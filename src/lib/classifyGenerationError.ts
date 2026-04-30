/**
 * Classify errors that surface during the Generate flow into structured
 * categories the UI can render with tailored CTAs.
 *
 * Strict policy: only the cases we are 100% confident about get their own
 * `kind`. Everything else falls through to `'unknown'` with the raw message
 * so we don't claim to know what happened when we don't.
 *
 * Sure cases (today):
 *   - 'rate_limit'           — `LaminaRateLimitError` instance from the SDK,
 *                              carries a `retryAfterSeconds` field.
 *   - 'needs_choice'         — `/v1/content/auto-generate` returned
 *                              `status: 'needs_choice'`. Server-defined enum,
 *                              not a string we're guessing at.
 *   - 'insufficient_credits' — error message matches the exact server log
 *                              line `'Insufficient credits'` (verified from
 *                              real freestyle-fallback logs).
 *
 * Auth errors (`LaminaAuthError`) intentionally fall through to `'unknown'`
 * here — the OAuth refactor in `LaminaContext.tsx` already handles them by
 * clearing storage and re-rendering to the sign-in surface, so by the time
 * one would reach this classifier the user is already on the login screen.
 */

import { LaminaRateLimitError } from '@uselamina/sdk';

const TOPUP_URL = 'https://app.uselamina.ai/pricing';

export type GenerationError =
  | { kind: 'rate_limit'; retryAfterSeconds: number | null; message: string }
  | { kind: 'needs_choice'; reason: string }
  | { kind: 'insufficient_credits'; message: string; topUpUrl: string }
  | { kind: 'unknown'; message: string };

const INSUFFICIENT_CREDITS_PATTERN = /insufficient credits/i;

/**
 * Classify an exception thrown by an SDK call (`autoGenerate`, `runs.wait`,
 * etc.) into a structured error.
 */
export function classifyThrownError(err: unknown): GenerationError {
  if (err instanceof LaminaRateLimitError) {
    return {
      kind: 'rate_limit',
      retryAfterSeconds: err.retryAfterSeconds,
      message: err.message,
    };
  }

  if (err instanceof Error && INSUFFICIENT_CREDITS_PATTERN.test(err.message)) {
    return { kind: 'insufficient_credits', message: err.message, topUpUrl: TOPUP_URL };
  }

  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'unknown', message: message || 'An unexpected error occurred.' };
}

/**
 * Classify an `auto-generate` response that didn't produce a runId. Returns
 * `null` when the response was the happy path (the caller's already moved on).
 */
export function classifyAutoGenerateResult(
  data: { status?: string; reason?: string } | null | undefined,
): GenerationError | null {
  if (!data) return null;
  if (data.status === 'needs_choice') {
    return {
      kind: 'needs_choice',
      reason:
        typeof data.reason === 'string' && data.reason.trim()
          ? data.reason
          : "Couldn't auto-pick a template for this brief.",
    };
  }
  return null;
}

/**
 * Classify a run that polled to terminal `failed`. The run pipeline writes
 * the failure reason as a free-text string; we pattern-match for known
 * categories and fall through to `'unknown'` otherwise.
 */
export function classifyRunFailure(errorMessage: string | null | undefined): GenerationError {
  const message = (errorMessage || '').trim() || 'Generation failed.';
  if (INSUFFICIENT_CREDITS_PATTERN.test(message)) {
    return { kind: 'insufficient_credits', message, topUpUrl: TOPUP_URL };
  }
  return { kind: 'unknown', message };
}
