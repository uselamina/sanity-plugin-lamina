/**
 * Stable content hash for a Sanity document, used to decide whether the
 * cached AI brief is still valid for this doc.
 *
 * "Same hash" must mean: nothing the LLM brief endpoint cared about has
 * changed. Things that DON'T affect the brief (and so are stripped):
 *   - `_rev` / `_updatedAt` / `_createdAt` — change on every save, no
 *     semantic meaning to the brief.
 *   - `_id`, `_key` — identity, not content.
 *   - Bare references (`{_type:'reference',_ref:...}`) — opaque pointers;
 *     the server can't fetch them without a separate query, so they don't
 *     contribute to the brief.
 *
 * Things that DO matter (and so are kept):
 *   - title, description, body text, plain field values
 *   - portable text (flattened to plain strings, the same way the server
 *     does it in `compactDocForPrompt`)
 *
 * The hash itself is djb2 (xor variant) → 32-bit unsigned → hex. Not
 * cryptographic — we only need stable equality detection for cache lookups.
 * This stays in 8 hex chars max. Browser-safe, no crypto.subtle dependency.
 */

const SANITY_INTERNAL_KEYS = new Set([
  '_rev',
  '_updatedAt',
  '_createdAt',
  '_id',
  '_key',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isReference(v: unknown): boolean {
  return (
    isPlainObject(v) &&
    (v as { _type?: unknown })._type === 'reference' &&
    typeof (v as { _ref?: unknown })._ref === 'string'
  );
}

function isPortableTextBlock(v: unknown): boolean {
  return (
    isPlainObject(v) &&
    (v as { _type?: unknown })._type === 'block' &&
    Array.isArray((v as { children?: unknown }).children)
  );
}

function flattenPortableText(block: Record<string, unknown>): string {
  const children = block.children as Array<Record<string, unknown>>;
  return children
    .filter((c) => isPlainObject(c) && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');
}

/**
 * Returns a "compact" representation that drops noise and flattens portable
 * text. Used as input to the stable stringifier.
 */
function compact(value: unknown): unknown {
  if (value == null) return value;

  if (Array.isArray(value)) {
    // If this looks like a portable-text array, flatten the blocks.
    const ptParts: string[] = [];
    let allBlockLike = value.length > 0;
    for (const b of value) {
      if (isPortableTextBlock(b)) {
        ptParts.push(flattenPortableText(b as Record<string, unknown>));
      } else if (!isPlainObject(b) || typeof (b as { _type?: unknown })._type !== 'string') {
        allBlockLike = false;
        break;
      }
    }
    if (allBlockLike && ptParts.length > 0) {
      return ptParts.join('\n\n');
    }
    return value.map(compact).filter((v) => v !== undefined);
  }

  if (isReference(value)) return undefined;

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SANITY_INTERNAL_KEYS.has(k)) continue;
      const c = compact(v);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }

  return value;
}

/**
 * JSON.stringify with sorted object keys — same input → identical string.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * djb2 hash (xor variant) → unsigned 32-bit → hex string.
 * Fast, browser-safe, deterministic, plenty of collision resistance for our
 * "did the doc change?" cache key.
 */
function djb2Hex(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  // Coerce to unsigned 32-bit, then hex-pad.
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compute a stable hash of the brief-relevant content of a Sanity doc.
 * Returns a stable hex string; `null` when the input isn't a usable doc.
 *
 * Same doc → same hash. `_rev`/`_updatedAt` changes alone → same hash.
 * Title or body change → different hash.
 */
export function hashDocForBrief(doc: unknown): string | null {
  if (!isPlainObject(doc)) return null;
  const compacted = compact(doc);
  const json = stableStringify(compacted);
  if (!json || json === '{}' || json === 'null') return null;
  return djb2Hex(json);
}
