/**
 * Brief enhancement utilities.
 *
 * Calls `client.content.brief()` to refine a rough user-written prompt into
 * an optimized generation prompt.  Also builds a silent metadata enrichment
 * object from document context so the Lamina API receives richer signals
 * without changing what the user sees in the text field.
 *
 * Closes #66.
 */

import type { LaminaClient, ContentBriefParams, ContentConcept } from '@uselamina/sdk';

export interface EnhanceResult {
  /** The optimized prompt text. */
  enhanced: string;
  /** Title of the concept (for display). */
  title: string;
  /** Short rationale explaining the enhancement. */
  rationale: string;
}

/**
 * Ask the Lamina API to rewrite `rawBrief` into a higher-quality prompt.
 * Returns `null` if the API fails (enhancement is best-effort).
 */
export async function enhanceBrief(
  client: LaminaClient,
  rawBrief: string,
  context: {
    modality?: string;
    brandProfileId?: string;
    documentType?: string;
    documentTitle?: string;
    fieldName?: string;
    documentExcerpt?: string;
  },
): Promise<EnhanceResult | null> {
  try {
    const goalParts: string[] = [rawBrief];
    if (context.documentTitle) {
      goalParts.push(`Context: ${context.documentType ?? 'content'} titled "${context.documentTitle}"`);
    }
    if (context.fieldName) {
      goalParts.push(`Target field: ${context.fieldName}`);
    }
    if (context.documentExcerpt) {
      goalParts.push(`Content excerpt: ${context.documentExcerpt}`);
    }

    const params: ContentBriefParams = {
      goal: goalParts.join('. '),
      modality: context.modality || 'image',
      count: 1,
      ...(context.brandProfileId ? { brandProfileId: context.brandProfileId } : {}),
    };

    const result = await client.content.brief(params);
    const concepts: ContentConcept[] = result.data?.concepts ?? [];
    if (concepts.length === 0) return null;

    const best = concepts[0];
    return {
      enhanced: best.prompt,
      title: best.title,
      rationale: best.rationale,
    };
  } catch {
    // Enhancement is best-effort; fall back gracefully.
    return null;
  }
}

export interface SilentEnrichment {
  metadata: Record<string, string>;
}

/**
 * Build a metadata bag from document context that is sent alongside the
 * generation request.  This enriches the API call without being visible
 * in the brief textarea.
 */
export function buildSilentEnrichment(context: {
  documentType?: string;
  documentTitle?: string;
  fieldName?: string;
  fieldDescription?: string;
  documentExcerpt?: string;
  brandProfileName?: string;
  targetDimensions?: string;
  platform?: string;
}): SilentEnrichment {
  const metadata: Record<string, string> = {};

  if (context.documentType) metadata.documentType = context.documentType;
  if (context.documentTitle) metadata.documentTitle = context.documentTitle;
  if (context.fieldName) metadata.fieldName = context.fieldName;
  if (context.fieldDescription) metadata.fieldPurpose = context.fieldDescription;
  if (context.documentExcerpt) metadata.documentExcerpt = context.documentExcerpt;
  if (context.brandProfileName) metadata.brandTone = context.brandProfileName;
  if (context.targetDimensions) metadata.targetDimensions = context.targetDimensions;
  if (context.platform) metadata.platform = context.platform;

  return { metadata };
}
