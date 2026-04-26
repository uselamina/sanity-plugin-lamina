/**
 * Debounced typeahead hook for brief suggestions.
 *
 * Calls `client.content.brief()` as the user types, with a 500ms debounce.
 * Results are cached per (prefix + context) key to avoid redundant API calls.
 *
 * Closes #65.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LaminaClient, ContentConcept, ContentBriefParams } from '@uselamina/sdk';

const DEBOUNCE_MS = 500;
/** Minimum characters before triggering typeahead. */
const MIN_LENGTH = 8;

interface TypeaheadContext {
  modality?: string;
  brandProfileId?: string;
  documentType?: string;
  documentTitle?: string;
  fieldName?: string;
  documentExcerpt?: string;
}

export interface TypeaheadResult {
  /** Current suggestions. */
  suggestions: ContentConcept[];
  /** Whether a fetch is in flight. */
  loading: boolean;
  /** Clear all suggestions. */
  clear: () => void;
}

/**
 * Debounced typeahead hook.
 *
 * @param client - The LaminaClient instance.
 * @param brief - Current value of the brief textarea.
 * @param context - Document/field context for relevance.
 * @param enabled - Pass `false` to disable (e.g. while generating).
 */
export function useTypeahead(
  client: LaminaClient,
  brief: string,
  context: TypeaheadContext,
  enabled: boolean,
): TypeaheadResult {
  const [suggestions, setSuggestions] = useState<ContentConcept[]>([]);
  const [loading, setLoading] = useState(false);

  // In-memory cache keyed on brief prefix + context.
  const cacheRef = useRef<Map<string, ContentConcept[]>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const buildCacheKey = useCallback(
    (text: string) =>
      `${text.trim().toLowerCase().substring(0, 60)}::${context.documentType ?? ''}:${context.fieldName ?? ''}:${context.brandProfileId ?? ''}`,
    [context.documentType, context.fieldName, context.brandProfileId],
  );

  const clear = useCallback(() => {
    setSuggestions([]);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    // Clear previous timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Don't fetch if disabled, too short, or empty
    if (!enabled || brief.trim().length < MIN_LENGTH) {
      setSuggestions([]);
      return;
    }

    const cacheKey = buildCacheKey(brief);
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setSuggestions(cached);
      return;
    }

    // Debounce the API call
    timerRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;

      setLoading(true);
      try {
        const goalParts = [brief.trim()];
        if (context.documentTitle) {
          goalParts.push(`for ${context.documentType ?? 'content'}: ${context.documentTitle}`);
        }
        if (context.documentExcerpt) {
          goalParts.push(context.documentExcerpt);
        }

        const params: ContentBriefParams = {
          goal: goalParts.join(' — '),
          modality: context.modality || 'image',
          count: 3,
          ...(context.brandProfileId ? { brandProfileId: context.brandProfileId } : {}),
        };

        const result = await client.content.brief(params);
        if (abort.signal.aborted) return;

        const concepts = result.data?.concepts ?? [];
        cacheRef.current.set(cacheKey, concepts);

        // Limit cache size
        if (cacheRef.current.size > 50) {
          const firstKey = cacheRef.current.keys().next().value;
          if (firstKey !== undefined) {
            cacheRef.current.delete(firstKey);
          }
        }

        setSuggestions(concepts);
      } catch {
        if (!abort.signal.aborted) setSuggestions([]);
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [brief, enabled, client, context.modality, context.brandProfileId, context.documentType, context.documentTitle, context.fieldName, context.documentExcerpt, buildCacheKey]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  return { suggestions, loading, clear };
}
