/**
 * Per-(document, field) persistence layer for the Generate dialog.
 *
 * What it stores:
 *   - `brief`  — current textarea text + status + the AI-generated prompt and
 *                the doc-content hash that produced it. Lets us skip an LLM
 *                call on every popup open when the doc hasn't changed.
 *   - `run`    — the most recent generation: runId, mode, status, outputs.
 *                Lets us restore a generation popup (live or completed) on
 *                reopen, and resume polling if the run is still in flight.
 *
 * Industry-standard model:
 *   - Cache is a HINT, server is source of truth. On run-restore, we always
 *     refresh from `client.runs.get()` (or `freestyle.get()`) before trusting
 *     anything other than the runId itself.
 *   - Per-entry schema version. On version mismatch, the entry is dropped
 *     silently — no migrations, no user-visible drama.
 *   - Reads never throw. localStorage may be disabled (Safari private mode),
 *     JSON may be corrupt, the shape may have drifted. Failure → return null.
 *   - Writes are best-effort. Storage quota errors are swallowed.
 *   - GC sweep on plugin init drops entries older than the longest TTL.
 *
 * Scope:
 *   `lamina:dialog:{documentId}:{fieldName}` — different fields on the same
 *   doc don't share state. Drafts (`drafts.foo`) and published (`foo`) are
 *   different docs from this layer's POV (intentional V1 simplicity).
 */

import type { GeneratedOutput } from '../types.js';

const SCHEMA_VERSION = 1 as const;
const KEY_PREFIX = 'lamina:dialog:';

/** Drop entries older than this regardless of state. Belt-and-suspenders cap. */
const MAX_ENTRY_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Older runs are treated as expired at READ time. CDN URLs may be dead. */
export const RUN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Older brief caches are treated as expired at READ time. */
export const BRIEF_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Hard cap on number of dialog entries. Prevents unbounded growth across
 * many docs × many fields. With ~3KB per entry, 200 entries = ~600KB —
 * a small fraction of the ~5MB localStorage budget. When over the cap we
 * LRU-evict (oldest `updatedAt` first).
 */
const MAX_ENTRIES = 200;

export type CachedBriefStatus =
  | 'placeholder'
  | 'ai-loading'
  | 'ai-ready'
  | 'user-edited'
  | 'chip-applied';

export interface BriefCache {
  /** Current textarea text. */
  text: string;
  /** State-machine status when the entry was last written. */
  status: CachedBriefStatus;
  /**
   * The last AI-generated brief (if any). Independent from `text` because the
   * user may have edited or chip-replaced it; we still want to know what the
   * AI produced for the cached `docHash` so we don't refetch unnecessarily.
   */
  aiPrompt: string | null;
  /**
   * Hash of canonical doc fields that produced `aiPrompt`. On reopen we
   * recompute the hash; matching → use cached AI brief, mismatch → refetch.
   */
  docHash: string;
  /** When this brief entry was last written. Used for BRIEF_TTL_MS check. */
  cachedAt: number;
}

export type CachedRunStatus = 'generating' | 'completed' | 'failed';
export type CachedRunMode = 'app' | 'freestyle';

export interface RunCache {
  runId: string;
  mode: CachedRunMode;
  status: CachedRunStatus;
  outputs: GeneratedOutput[];
  progress: number | null;
  error: string | null;
  /** When `autoGenerate` returned. Used for RUN_TTL_MS check. */
  startedAt: number;
  /** What was sent in the brief (for display/regenerate). */
  brief: string;
  appId?: string;
  numVariants?: number;
}

export interface DialogState {
  v: typeof SCHEMA_VERSION;
  /** Last write time. Used for GC sweep. */
  updatedAt: number;
  brief: BriefCache | null;
  run: RunCache | null;
}

// ─── localStorage access guards ────────────────────────────────────────────

/**
 * Cache the storage probe result. The probe is a 17-byte setItem+removeItem
 * round-trip used to detect Safari private mode (where setItem always throws).
 * Running it on every call adds noise to telemetry and — more importantly —
 * blocks our own quota-recovery path, since the probe would itself fail when
 * storage is full, causing us to give up before evicting anything.
 *
 * Resolution states:
 *   undefined — not yet probed
 *   Storage   — probe succeeded; this is the live localStorage
 *   null      — probe failed; localStorage is unusable
 */
let cachedStorage: Storage | null | undefined = undefined;

function getStorage(): Storage | null {
  if (cachedStorage !== undefined) return cachedStorage;
  try {
    if (typeof window === 'undefined') {
      cachedStorage = null;
      return null;
    }
    // Safari private mode: window.localStorage exists but throws on access.
    const ls = window.localStorage;
    const probe = '__lamina_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    cachedStorage = ls;
    return ls;
  } catch {
    cachedStorage = null;
    return null;
  }
}

/**
 * Test-only: reset the cached storage probe. Lets unit tests inject a fresh
 * mock storage between runs without restarting the process.
 */
export function __resetStorageCacheForTests(): void {
  cachedStorage = undefined;
}

function makeKey(docId: string, fieldName: string): string {
  return `${KEY_PREFIX}${docId}:${fieldName}`;
}

/**
 * Walk lamina:dialog:* entries, return their keys with parsed `updatedAt`.
 * Used by LRU eviction. Skips corrupt entries (they get cleaned up by gc()).
 */
function listEntries(ls: Storage): Array<{ key: string; updatedAt: number }> {
  const out: Array<{ key: string; updatedAt: number }> = [];
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    if (!key || !key.startsWith(KEY_PREFIX)) continue;
    const raw = ls.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const updatedAt =
        parsed && typeof parsed === 'object' && typeof parsed.updatedAt === 'number'
          ? parsed.updatedAt
          : 0;
      out.push({ key, updatedAt });
    } catch {
      // Corrupt entries are listed with updatedAt=0 so they evict first.
      out.push({ key, updatedAt: 0 });
    }
  }
  return out;
}

/**
 * Drop the oldest N entries (by updatedAt). Returns count removed.
 * Used both by enforceEntryCap and quota-exceeded recovery.
 */
function evictOldest(ls: Storage, count: number): number {
  if (count <= 0) return 0;
  const entries = listEntries(ls);
  entries.sort((a, b) => a.updatedAt - b.updatedAt);
  const toRemove = entries.slice(0, count);
  for (const e of toRemove) {
    try { ls.removeItem(e.key); } catch { /* noop */ }
  }
  return toRemove.length;
}

/**
 * If we're over the entry cap after a write, evict oldest. Cheap — only
 * fires when cap is exceeded.
 */
function enforceEntryCap(ls: Storage): void {
  const entries = listEntries(ls);
  if (entries.length <= MAX_ENTRIES) return;
  evictOldest(ls, entries.length - MAX_ENTRIES);
}

/**
 * Wraps `setItem` with quota-recovery: on QuotaExceededError, evict oldest
 * 10% of entries and retry once. Returns true on success, false on failure.
 */
function safeSetItem(ls: Storage, key: string, value: string): boolean {
  try {
    ls.setItem(key, value);
    return true;
  } catch (err) {
    // Most browsers throw DOMException with name 'QuotaExceededError' (or
    // legacy 'NS_ERROR_DOM_QUOTA_REACHED'). Rather than name-match, we just
    // attempt eviction and retry on any setItem error.
    try {
      const cleared = evictOldest(ls, Math.max(1, Math.floor(MAX_ENTRIES / 10)));
      if (cleared > 0) {
        ls.setItem(key, value);
        return true;
      }
    } catch {
      // Retry also failed — fall through.
    }
    // eslint-disable-next-line no-console
    console.warn('[lamina/dialogStore] setItem failed even after eviction:', err);
    return false;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Read the dialog state for a (doc, field). Returns null when:
 *   - docId or fieldName missing
 *   - no entry exists
 *   - entry is corrupt / wrong schema version
 *   - localStorage unavailable
 *
 * Never throws. Self-heals corrupt entries (deletes them).
 */
export function readDialogState(
  docId: string | undefined,
  fieldName: string | undefined,
): DialogState | null {
  if (!docId || !fieldName) return null;
  const ls = getStorage();
  if (!ls) return null;

  const key = makeKey(docId, fieldName);
  const raw = ls.getItem(key);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt — drop it.
    try { ls.removeItem(key); } catch { /* noop */ }
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { v?: unknown }).v !== SCHEMA_VERSION
  ) {
    try { ls.removeItem(key); } catch { /* noop */ }
    return null;
  }

  const state = parsed as DialogState;

  // Per-field freshness checks — a stale `run` field doesn't invalidate the
  // whole entry, just that field. Same for brief.
  const now = Date.now();
  let brief = state.brief;
  let run = state.run;

  if (brief && now - (brief.cachedAt ?? 0) > BRIEF_TTL_MS) {
    brief = null;
  }
  if (run && now - (run.startedAt ?? 0) > RUN_TTL_MS) {
    run = null;
  }

  return {
    v: SCHEMA_VERSION,
    updatedAt: state.updatedAt ?? 0,
    brief,
    run,
  };
}

/**
 * Shallow-merge `patch` into the stored entry. Top-level fields (`brief`,
 * `run`) are replaced wholesale by the patch — pass `{ run: null }` to clear
 * just the run while keeping the brief, etc.
 *
 * No-ops silently when docId/fieldName missing or storage unavailable.
 */
export function patchDialogState(
  docId: string | undefined,
  fieldName: string | undefined,
  patch: { brief?: BriefCache | null; run?: RunCache | null },
): void {
  if (!docId || !fieldName) return;
  const ls = getStorage();
  if (!ls) return;

  const key = makeKey(docId, fieldName);
  const existing = readDialogState(docId, fieldName);

  const next: DialogState = {
    v: SCHEMA_VERSION,
    updatedAt: Date.now(),
    brief: 'brief' in patch ? patch.brief ?? null : existing?.brief ?? null,
    run: 'run' in patch ? patch.run ?? null : existing?.run ?? null,
  };

  const ok = safeSetItem(ls, key, JSON.stringify(next));
  if (ok) {
    enforceEntryCap(ls);
  }
}

/**
 * Drop the entry entirely for a single (doc, field). No-ops silently when
 * args missing.
 */
export function clearDialogState(
  docId: string | undefined,
  fieldName: string | undefined,
): void {
  if (!docId || !fieldName) return;
  const ls = getStorage();
  if (!ls) return;
  try {
    ls.removeItem(makeKey(docId, fieldName));
  } catch {
    /* noop */
  }
}

/**
 * Wipe all `lamina:dialog:*` entries — every doc, every field. Intended
 * for "Clear all cached dialog state" admin / debug actions, not for
 * routine use. Single calls only — no confirmation handled here.
 */
export function clearAllDialogState(): number {
  const ls = getStorage();
  if (!ls) return 0;
  const entries = listEntries(ls);
  for (const e of entries) {
    try { ls.removeItem(e.key); } catch { /* noop */ }
  }
  return entries.length;
}

/**
 * Diagnostics — count of stored entries and their total stringified size.
 * Useful for surfacing "X cached fields, Y KB" in a UI or for tests.
 */
export function getDialogStateStats(): { count: number; bytes: number } {
  const ls = getStorage();
  if (!ls) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    if (!key || !key.startsWith(KEY_PREFIX)) continue;
    const raw = ls.getItem(key);
    if (raw) {
      count++;
      // .length on a JS string is UTF-16 code units — close enough to bytes
      // for "is this big or small" reporting; not exact for non-ASCII.
      bytes += raw.length + key.length;
    }
  }
  return { count, bytes };
}

/**
 * Sweep all `lamina:dialog:*` entries; drop ones older than MAX_ENTRY_AGE_MS
 * or with the wrong schema version. Safe to call repeatedly. Intended to fire
 * once on plugin init.
 */
export function gcDialogState(): void {
  const ls = getStorage();
  if (!ls) return;

  const now = Date.now();
  const toRemove: string[] = [];

  // Collect first so we don't mutate while iterating.
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    if (!key || !key.startsWith(KEY_PREFIX)) continue;

    const raw = ls.getItem(key);
    if (!raw) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      toRemove.push(key);
      continue;
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { v?: unknown }).v !== SCHEMA_VERSION
    ) {
      toRemove.push(key);
      continue;
    }

    const updatedAt = (parsed as { updatedAt?: unknown }).updatedAt;
    if (typeof updatedAt !== 'number' || now - updatedAt > MAX_ENTRY_AGE_MS) {
      toRemove.push(key);
    }
  }

  for (const key of toRemove) {
    try { ls.removeItem(key); } catch { /* noop */ }
  }
}
