/**
 * Single-source-of-truth hook for the brief textarea in GenerateDialog.
 *
 * Replaces the previous tangle of state + refs + parallel effects with one
 * explicit state machine:
 *
 *     placeholder ─► ai-loading ─► ai-ready
 *           │             │            │
 *           └─────────────┴────────────┴─► user-edited ◄──► chip-applied
 *                                              ▲                │
 *                                              └────keystroke───┘
 *
 *   • placeholder   — deterministic string template built from doc context.
 *                     Shown the moment the popup opens; nothing async.
 *   • ai-loading    — the mount-effect kicked off `client.content.brief()`.
 *                     UI shows a spinner. briefText is still the placeholder.
 *   • ai-ready      — AI brief returned and replaced briefText. User has not
 *                     edited.
 *   • user-edited   — user typed in the textarea. Typeahead is enabled.
 *   • chip-applied  — user clicked a typeahead chip. Text was replaced with
 *                     the chip's prompt; typeahead suppressed so we don't
 *                     immediately re-fetch. Any subsequent textarea keystroke
 *                     flips back to user-edited.
 *
 *   AI replacements (mount-effect) are ignored once the user has interacted
 *   (status ∈ {user-edited, chip-applied}) — their work always wins.
 *
 * Typeahead chips are populated only when status === 'user-edited' and the
 * brief is long enough to be a real query (≥8 chars). One debounced fetch
 * per ~500ms of input idle.
 *
 * The hook owns:
 *   - briefText state
 *   - briefStatus state
 *   - typeaheadChips + typeaheadLoading state
 *   - the fire-once mount-effect ref
 *   - the typeahead debounce timer
 *
 * The component owns:
 *   - rendering the textarea, spinner, chips
 *   - calling setBriefText on every textarea change
 *   - everything else (modality, brand picker, generate button, etc.)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContentBriefParams, ContentConcept, LaminaClient } from '@uselamina/sdk';
import {
  patchDialogState,
  readDialogState,
  type BriefCache,
  type CachedBriefStatus,
} from './dialogStore.js';
import { hashDocForBrief } from './hashDocForBrief.js';

const TYPEAHEAD_DEBOUNCE_MS = 500;
const TYPEAHEAD_MIN_LENGTH = 8;

const FIELD_LABELS: Record<string, string> = {
  heroImage: 'hero image',
  mainImage: 'main image',
  thumbnail: 'thumbnail',
  ogImage: 'social preview image',
  coverImage: 'cover image',
  poster: 'poster',
  avatar: 'avatar',
  logo: 'logo',
  icon: 'icon',
  banner: 'banner',
  background: 'background image',
};

const TYPE_LABELS: Record<string, string> = {
  product: 'product',
  post: 'blog post',
  blogPost: 'blog post',
  article: 'article',
  page: 'page',
  landingPage: 'landing page',
  category: 'category',
  author: 'author',
  event: 'event',
  project: 'project',
};

function humaniseSlug(slug: string): string {
  return slug.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
}

/**
 * Deterministic placeholder built from doc + field context. Used as the
 * initial textarea value (before the AI brief lands) and as the fallback
 * if the AI call fails.
 */
function buildPlaceholderBrief(ctx: {
  documentType?: string;
  documentTitle?: string;
  fieldName?: string;
  fieldDescription?: string;
}): string {
  const parts: string[] = [];

  const fieldLabel = ctx.fieldName
    ? FIELD_LABELS[ctx.fieldName] ?? humaniseSlug(ctx.fieldName)
    : null;
  const typeLabel = ctx.documentType
    ? TYPE_LABELS[ctx.documentType] ?? humaniseSlug(ctx.documentType)
    : null;

  if (fieldLabel) {
    parts.push(fieldLabel.charAt(0).toUpperCase() + fieldLabel.slice(1));
  }
  if (typeLabel && ctx.documentTitle) {
    parts.push(`for ${typeLabel}: ${ctx.documentTitle}`);
  } else if (ctx.documentTitle) {
    parts.push(`for ${ctx.documentTitle}`);
  } else if (typeLabel) {
    parts.push(`for ${typeLabel}`);
  }
  if (ctx.fieldDescription) {
    parts.push(`(${ctx.fieldDescription})`);
  }

  return parts.join(' ');
}

export type BriefStatus =
  | 'placeholder'
  | 'ai-loading'
  | 'ai-ready'
  | 'user-edited'
  | 'chip-applied';

export interface UseDocumentBriefArgs {
  client: LaminaClient;
  /**
   * Sanity document _id (drafts.foo or foo). Together with `fieldName`,
   * forms the persistence scope for the brief cache. When either is missing,
   * the hook still works fully — it just doesn't persist across reopens.
   */
  documentId?: string;
  documentType?: string;
  documentTitle?: string;
  documentExcerpt?: string;
  fieldName?: string;
  fieldDescription?: string;
  /** Full Sanity document; sent to the server as `metadata.document`. */
  fullDocument?: Record<string, unknown>;
  /** Current modality (caller may override the auto-derived one). */
  modality?: string;
  /** Sanity asset type from the asset-source props (`'image' | 'file'`). */
  assetType?: string;
  /** When set, included in the brief request as brandProfileId. */
  selectedBrandId?: string;
  /**
   * Whether typeahead should be enabled. Typically `true` when the dialog's
   * generation state is idle (not currently running). Caller passes
   * `(state.status === 'idle' || state.status === 'failed')` or similar.
   */
  typeaheadEnabled: boolean;
}

export interface UseDocumentBriefResult {
  briefText: string;
  /**
   * Setter for the textarea. Wire this to `<TextArea onChange>`. Flips status
   * to `'user-edited'` (or keeps it there) and enables typeahead. The AI
   * brief mount-effect, if still in flight, won't overwrite the user's text.
   */
  setBriefText: (next: string) => void;
  /**
   * Apply a typeahead chip's prompt as the brief. Sets status to
   * `'chip-applied'` so the typeahead effect does NOT re-fire on the
   * resulting briefText change. Subsequent keystrokes via `setBriefText`
   * flip status back to `'user-edited'` and re-enable typeahead.
   */
  applyChip: (next: string) => void;
  /**
   * Force-reset the brief back to its placeholder state and re-arm the AI
   * mount-fetch. Intended for the user-facing "Clear cached state" action;
   * GenerateDialog calls this in addition to wiping localStorage so the
   * textarea visibly returns to a fresh state. Caller is responsible for
   * having already cleared the dialogStore entry — this only resets the
   * hook's React state.
   */
  resetBrief: () => void;
  briefStatus: BriefStatus;
  typeaheadChips: ContentConcept[];
  typeaheadLoading: boolean;
}

/**
 * Resolve the modality string sent to the server.
 *
 * Sanity's `assetType` is `'image' | 'file' | 'sanity.video'`. For `file`
 * fields we default to `'video'` — the most common case where someone uses
 * the generic file dropdown for a media field. Caller's explicit `modality`
 * overrides everything.
 */
function resolveModality(modality?: string, assetType?: string): string {
  if (modality) return modality;
  if (assetType === 'image') return 'image';
  if (assetType === 'sanity.video') return 'video';
  return assetType === 'file' ? 'video' : 'image';
}

export function useDocumentBrief(args: UseDocumentBriefArgs): UseDocumentBriefResult {
  const placeholder = buildPlaceholderBrief({
    documentType: args.documentType,
    documentTitle: args.documentTitle,
    fieldName: args.fieldName,
    fieldDescription: args.fieldDescription,
  });

  // Always open from the deterministic document placeholder. Cached user/chip
  // prompts are intentionally NOT restored here: they are drafts, not source
  // of truth, and restoring them made stale prompts reappear after Regenerate
  // or Clear Cache. A valid cached AI brief may still replace this placeholder
  // below, but only after the current document hash matches.
  const [briefText, setBriefTextRaw] = useState<string>(placeholder);
  const [briefStatus, setBriefStatus] = useState<BriefStatus>('placeholder');
  const [typeaheadChips, setTypeaheadChips] = useState<ContentConcept[]>([]);
  const [typeaheadLoading, setTypeaheadLoading] = useState(false);
  const [resetVersion, setResetVersion] = useState(0);

  // ─── Cache-write helper ─────────────────────────────────────────────────
  // Centralized so every state-change site persists in lockstep. The
  // `aiPrompt`/`docHash` fields are sticky — they're set when AI lands and
  // persist across user-edited/chip-applied transitions, so a future reopen
  // can still know "AI was generated for this docHash, don't refire."
  const persistBrief = useCallback(
    (next: { text: string; status: CachedBriefStatus; aiPrompt?: string; docHash?: string }) => {
      const prior = readDialogState(args.documentId, args.fieldName)?.brief ?? null;
      const merged: BriefCache = {
        text: next.text,
        status: next.status,
        aiPrompt: next.aiPrompt ?? prior?.aiPrompt ?? null,
        docHash: next.docHash ?? prior?.docHash ?? '',
        cachedAt: Date.now(),
      };
      patchDialogState(args.documentId, args.fieldName, { brief: merged });
    },
    [args.documentId, args.fieldName],
  );

  // ─── User setter (textarea typing) ───────────────────────────────────────
  // Clears stale typeahead chips immediately so they don't linger across
  // the 500ms debounce window. Always flips to 'user-edited' (so typing
  // after a chip pick re-enables typeahead). Persists so the user's text
  // survives a dialog close/reopen.
  const setBriefText = useCallback(
    (next: string) => {
      setBriefTextRaw(next);
      setBriefStatus('user-edited');
      setTypeaheadChips([]);
      persistBrief({ text: next, status: 'user-edited' });
    },
    [persistBrief],
  );

  // ─── Chip setter ────────────────────────────────────────────────────────
  // Distinct from `setBriefText` so the typeahead effect (gated on
  // `briefStatus === 'user-edited'`) does NOT re-fire when the chip's
  // prompt becomes the new briefText. Also clears the chip list so the
  // user sees a clean slate on the next edit. Persists for reopen.
  const applyChip = useCallback(
    (next: string) => {
      setBriefTextRaw(next);
      setBriefStatus('chip-applied');
      setTypeaheadChips([]);
      persistBrief({ text: next, status: 'chip-applied' });
    },
    [persistBrief],
  );

  // ─── Reset (user-initiated "start fresh") ──────────────────────────────
  // Reverts hook state to the deterministic placeholder + flips the
  // mount-effect fire ref so the next render fires a new AI brief. Caller
  // (GenerateDialog) is responsible for having already cleared localStorage;
  // this just snaps the React side to match.
  const resetBrief = useCallback(() => {
    setBriefTextRaw(placeholder);
    setBriefStatus('placeholder');
    setTypeaheadChips([]);
    setTypeaheadLoading(false);
    hasFiredRef.current = false;
    setResetVersion((version) => version + 1);
  }, [placeholder]);

  // ─── Mount-effect: fire AI brief ONCE per dialog mount ────────────────────
  // Sanity's `useFormValue([])` returns `undefined` on first render and
  // resolves the actual document on the next pass. If we fire immediately,
  // `metadata.document` would be null — defeating the whole point of
  // sending rich document context. Gate the fire on `fullDocument` actually
  // being present (we use `_type` as the readiness signal — that field is
  // always set on a real Sanity doc, never on the placeholder undefined).
  //
  // Once fired, `hasFiredRef` blocks every subsequent re-render so we
  // don't re-fetch when the doc gets updated by the user mid-dialog or in
  // StrictMode's double-mount.
  const hasFiredRef = useRef(false);
  // Snapshot args read inside the async callback — closure capture is fine
  // for "fire once" semantics. We don't refetch when args change.
  const argsForFetch = useRef(args);
  argsForFetch.current = args;

  useEffect(() => {
    if (hasFiredRef.current) return;
    // Wait until the Sanity document has actually resolved. Without this,
    // the first render fires the LLM call against `metadata.document = null`
    // and the server has nothing to read from.
    const docReady =
      args.fullDocument != null &&
      typeof args.fullDocument === 'object' &&
      typeof args.fullDocument._type === 'string';
    if (!docReady) return;
    hasFiredRef.current = true;

    // ─── Cache hit short-circuit ─────────────────────────────────────────
    // If we have a previous AI brief for this (doc, field) and the doc
    // content hasn't changed (hash match), don't fire the LLM. Restore ONLY
    // the cached AI prompt, not arbitrary user-edited/chip-applied text. That
    // keeps reopen behavior deterministic and prevents stale prompts from
    // being resurrected by Regenerate.
    const currentDocHash = hashDocForBrief(args.fullDocument);
    const cachedBrief = readDialogState(args.documentId, args.fieldName)?.brief ?? null;
    const briefHashMatches =
      cachedBrief?.aiPrompt &&
      currentDocHash &&
      cachedBrief.docHash === currentDocHash;

    if (briefHashMatches) {
      // eslint-disable-next-line no-console
      console.log('[lamina/brief] cache HIT — skipping AI fetch', {
        docHash: currentDocHash,
        cachedStatus: cachedBrief?.status,
      });
      if (typeof cachedBrief.aiPrompt === 'string' && cachedBrief.aiPrompt.trim()) {
        setBriefTextRaw(cachedBrief.aiPrompt);
        setBriefStatus('ai-ready');
      }
      return;
    }

    // eslint-disable-next-line no-console
    console.log('[lamina/brief] cache MISS — firing AI fetch', {
      currentDocHash,
      cachedDocHash: cachedBrief?.docHash ?? null,
      hasAiPromptCached: Boolean(cachedBrief?.aiPrompt),
    });

    let cancelled = false;
    void (async () => {
      const a = argsForFetch.current;
      const resolvedModality = resolveModality(a.modality, a.assetType);

      const goalParts = [
        `${a.fieldName ? FIELD_LABELS[a.fieldName] ?? humaniseSlug(a.fieldName) : 'media'} for ${a.documentType ?? 'content'}`,
        ...(a.documentTitle ? [`: ${a.documentTitle}`] : []),
        ...(a.documentExcerpt ? [` — ${a.documentExcerpt}`] : []),
      ];

      const params: ContentBriefParams = {
        goal: goalParts.join(''),
        modality: resolvedModality,
        count: 3,
        ...(a.selectedBrandId ? { brandProfileId: a.selectedBrandId } : {}),
        metadata: {
          documentType: a.documentType ?? null,
          fieldName: a.fieldName ?? null,
          fieldDescription: a.fieldDescription ?? null,
          // Server caps at ~6KB; safe to send.
          document: a.fullDocument ?? null,
        },
      };

      // eslint-disable-next-line no-console
      console.log('[lamina/brief] mount-fetch request →', {
        goal: params.goal,
        modality: params.modality,
        count: params.count,
        hasDocument: Boolean(a.fullDocument),
      });

      setBriefStatus('ai-loading');
      try {
        const result = await a.client.content.brief(params);
        if (cancelled) return;
        const concepts = result.data?.concepts ?? [];
        const aiPrompt = concepts[0]?.prompt;
        // eslint-disable-next-line no-console
        console.log('[lamina/brief] mount-fetch response ←', {
          count: concepts.length,
          firstTitle: concepts[0]?.title ?? null,
          firstPromptPreview: typeof aiPrompt === 'string' ? aiPrompt.slice(0, 120) : null,
        });

        const userHasInteracted = (s: BriefStatus) =>
          s === 'user-edited' || s === 'chip-applied';

        if (typeof aiPrompt !== 'string' || !aiPrompt.trim()) {
          // No usable concept — drop back to placeholder (unless user already moved on).
          setBriefStatus((prev) => (userHasInteracted(prev) ? prev : 'placeholder'));
          return;
        }

        const docHashAtFetch = hashDocForBrief(a.fullDocument) ?? '';

        // Two paths:
        //   1. User hasn't interacted → adopt the AI brief as the textarea
        //      content, set status to ai-ready, persist all of it.
        //   2. User HAS interacted → keep their text/status untouched, but
        //      still cache aiPrompt + docHash so a future reopen with the
        //      same doc hash skips the LLM call. We read cache directly
        //      rather than going through React state to avoid stale-closure
        //      bugs (the user may have typed during the fetch).
        setBriefStatus((prev) => {
          if (userHasInteracted(prev)) {
            const priorBrief = readDialogState(a.documentId, a.fieldName)?.brief;
            patchDialogState(a.documentId, a.fieldName, {
              brief: {
                text: priorBrief?.text ?? '',
                status: priorBrief?.status ?? prev,
                aiPrompt,
                docHash: docHashAtFetch,
                cachedAt: Date.now(),
              },
            });
            return prev;
          }
          setBriefTextRaw(aiPrompt);
          persistBrief({
            text: aiPrompt,
            status: 'ai-ready',
            aiPrompt,
            docHash: docHashAtFetch,
          });
          return 'ai-ready';
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[lamina/brief] mount-fetch failed; keeping placeholder', err);
        if (cancelled) return;
        setBriefStatus((prev) =>
          prev === 'user-edited' || prev === 'chip-applied' ? prev : 'placeholder',
        );
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-run when `fullDocument` transitions from undefined → resolved.
    // `hasFiredRef` blocks repeated fires once we've kicked off the fetch.
    // Other args are read via `argsForFetch.current` inside the callback so
    // we don't refetch on transient state changes (modality, brand, etc.).
  }, [args.fullDocument, resetVersion]);

  // ─── Typeahead: debounced fetch when user is editing ──────────────────────
  // Fires only when the user has actively edited the brief, the brief is
  // long enough to be a real query, and the parent says generation is idle.
  useEffect(() => {
    if (briefStatus !== 'user-edited') {
      setTypeaheadChips([]);
      return;
    }
    if (briefText.length < TYPEAHEAD_MIN_LENGTH || !args.typeaheadEnabled) {
      setTypeaheadChips([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      // Read from the always-fresh ref so the doc snapshot is current at
      // fire time, without putting `fullDocument` in the dep array (which
      // would re-fire on every unrelated doc edit due to ref churn).
      const fresh = argsForFetch.current;
      const resolvedModality = resolveModality(fresh.modality, fresh.assetType);

      // eslint-disable-next-line no-console
      console.log('[lamina/typeahead] fetch →', {
        goalPreview: briefText.slice(0, 80),
        modality: resolvedModality,
        hasDocument: Boolean(fresh.fullDocument),
      });

      setTypeaheadLoading(true);
      try {
        const result = await fresh.client.content.brief({
          goal: briefText,
          modality: resolvedModality,
          count: 3,
          ...(fresh.selectedBrandId ? { brandProfileId: fresh.selectedBrandId } : {}),
          metadata: {
            documentType: fresh.documentType ?? null,
            fieldName: fresh.fieldName ?? null,
            fieldDescription: fresh.fieldDescription ?? null,
            // Send the full Sanity doc — same as the mount-effect — so chip
            // suggestions are grounded in the actual document, not just the
            // user's brief text. Server caps at ~6KB.
            document: fresh.fullDocument ?? null,
          },
        });
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.log('[lamina/typeahead] response ←', {
          count: result.data?.concepts?.length ?? 0,
          firstTitle: result.data?.concepts?.[0]?.title ?? null,
        });
        setTypeaheadChips(result.data?.concepts ?? []);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[lamina/typeahead] fetch failed', err);
        if (!cancelled) setTypeaheadChips([]);
      } finally {
        if (!cancelled) setTypeaheadLoading(false);
      }
    }, TYPEAHEAD_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      // If a fetch was in-flight, its `finally` won't reset loading (gated on
      // !cancelled). Reset here so the spinner can never get stuck on.
      setTypeaheadLoading(false);
    };
  }, [
    briefStatus,
    briefText,
    args.client,
    args.modality,
    args.assetType,
    args.selectedBrandId,
    args.documentType,
    args.fieldName,
    args.fieldDescription,
    args.typeaheadEnabled,
    // NOTE: `args.fullDocument` deliberately NOT in the dep array. Sanity's
    // useFormValue([]) returns a new object reference on every doc-level
    // change, which would re-fire typeahead on unrelated edits. Instead the
    // fetch reads `argsForFetch.current.fullDocument` at fire time below,
    // picking up the latest doc snapshot without a re-render storm.
  ]);

  return {
    briefText,
    setBriefText,
    applyChip,
    resetBrief,
    briefStatus,
    typeaheadChips,
    typeaheadLoading,
  };
}
