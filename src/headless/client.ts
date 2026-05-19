/**
 * Headless Lamina + Sanity client.
 *
 * Wraps @uselamina/sdk and @sanity/client into high-level operations
 * for programmatic content generation at scale — no React required.
 *
 * Closes #76.
 */

import { createClient, type SanityClient } from '@sanity/client';
import { LaminaClient } from '@uselamina/sdk';
import type {
  ExecutionOutput,
  LaminaCreateParams,
} from '@uselamina/sdk';
import { enhanceBrief } from '../lib/briefEnhancer.js';
import { detectAspectRatio } from '../lib/aspectRatio.js';
import type {
  AssetScore,
  FillEmptyMediaParams,
  FillEmptyMediaResult,
  FillProgressEvent,
  GenerateForDocumentParams,
  GenerateForDocumentResult,
  GenerateParams,
  GeneratedAsset,
  GenerationResult,
  LaminaSanityClient,
  LaminaSanityClientOptions,
  PredictParams,
  RecommendationsParams,
  ScoreAssetsParams,
  TrendsParams,
  UploadResult,
  UploadToSanityParams,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toGeneratedAsset(out: ExecutionOutput): GeneratedAsset | null {
  if (out.status !== 'completed' || !out.value || typeof out.value !== 'string') {
    return null;
  }
  return {
    id: out.id,
    type: out.type,
    url: out.value,
    mimeType: out.mimeType ?? null,
    label: out.label,
    dimensions: out.dimensions ?? null,
    durationSeconds: out.durationSeconds ?? null,
  };
}

/**
 * Resolve `{{fieldName}}` placeholders in a brief template against a document.
 */
function resolveTemplate(template: string, doc: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path: string) => {
    const parts = path.split('.');
    let current: unknown = doc;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return '';
      current = (current as Record<string, unknown>)[part];
    }
    if (typeof current === 'string') return current;
    if (typeof current === 'number') return String(current);
    return '';
  });
}

/**
 * Build a default brief from document context when no explicit brief or template is given.
 */
function buildDefaultBrief(
  fieldName: string,
  documentType: string,
  documentTitle: string | null,
): string {
  const fieldLabel = fieldName
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .trim();
  const parts = [fieldLabel.charAt(0).toUpperCase() + fieldLabel.slice(1)];
  if (documentTitle) {
    parts.push(`for ${documentType}: ${documentTitle}`);
  } else {
    parts.push(`for ${documentType}`);
  }
  return parts.join(' ');
}

/** Collect image/file field names from a document's _type schema via a GROQ query. */
async function discoverImageFields(
  sanity: SanityClient,
  documentId: string,
): Promise<string[]> {
  // Fetch the document and inspect which top-level keys have {asset: {_ref}} shape
  const doc = await sanity.fetch<Record<string, unknown> | null>(
    `*[_id == $id || _id == "drafts." + $id][0]`,
    { id: documentId },
  );
  if (!doc) return [];

  const fields: string[] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('_')) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      // An image/file field has _type === 'image' or 'file'
      if (obj._type === 'image' || obj._type === 'file') {
        fields.push(key);
      }
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

class LaminaSanityClientImpl implements LaminaSanityClient {
  readonly lamina: LaminaClient;
  readonly sanity: SanityClient;
  private readonly opts: LaminaSanityClientOptions;

  constructor(opts: LaminaSanityClientOptions) {
    this.opts = opts;

    // Resolve Lamina client
    const laminaApiKey = opts.laminaApiKey || process.env.LAMINA_API_KEY;
    if (!laminaApiKey) {
      throw new Error(
        'sanity-plugin-lamina/headless: laminaApiKey is required. ' +
        'Pass it via options or set the LAMINA_API_KEY environment variable.',
      );
    }
    this.lamina = new LaminaClient({
      apiKey: laminaApiKey,
      baseUrl: opts.laminaBaseUrl,
    });

    // Resolve Sanity client
    if (opts.sanityClient) {
      this.sanity = opts.sanityClient;
    } else {
      const projectId = opts.sanityProjectId || process.env.SANITY_PROJECT_ID;
      const token = opts.sanityToken || process.env.SANITY_TOKEN;
      if (!projectId) {
        throw new Error(
          'sanity-plugin-lamina/headless: sanityProjectId is required. ' +
          'Pass it via options, provide a sanityClient, or set SANITY_PROJECT_ID.',
        );
      }
      this.sanity = createClient({
        projectId,
        dataset: opts.sanityDataset || process.env.SANITY_DATASET || 'production',
        token,
        apiVersion: opts.sanityApiVersion || '2024-01-01',
        useCdn: false,
      });
    }
  }

  // -----------------------------------------------------------------------
  // generate()
  // -----------------------------------------------------------------------

  async generate(params: GenerateParams): Promise<GenerationResult> {
    const modality = params.modality || 'image';
    let finalBrief = params.brief;

    // Enhance brief
    if (params.enhance !== false) {
      const enhanced = await enhanceBrief(this.lamina, params.brief, {
        modality,
        brandProfileId: params.brandProfileId || this.opts.defaultBrandProfileId,
        ...(params.metadata?.documentType ? { documentType: params.metadata.documentType } : {}),
        ...(params.metadata?.documentTitle ? { documentTitle: params.metadata.documentTitle } : {}),
        ...(params.metadata?.fieldName ? { fieldName: params.metadata.fieldName } : {}),
      });
      if (enhanced) finalBrief = enhanced.enhanced;
    }

    const createParams: LaminaCreateParams & { aspectRatio?: string; metadata?: Record<string, string> } = {
      brief: finalBrief,
      modality,
      ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
      ...(params.appId ? { appId: params.appId } : {}),
      ...(params.brandProfileId || this.opts.defaultBrandProfileId
        ? { brandProfileId: params.brandProfileId || this.opts.defaultBrandProfileId }
        : {}),
      ...(params.campaignId || this.opts.defaultCampaignId
        ? { campaignId: params.campaignId || this.opts.defaultCampaignId }
        : {}),
      ...(params.inputs ? { inputs: params.inputs } : {}),
      ...(params.autoQuality ? { autoQuality: params.autoQuality } : {}),
      ...(this.opts.webhookUrl ? { webhookUrl: this.opts.webhookUrl } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };

    const createResult = await this.lamina.content.create(createParams);
    // SDK returns a discriminated union; `needs_input` mode has no runId —
    // for headless callers there's no form UI, so treat it as a soft failure
    // pointing the caller back to refine the brief.
    const createData = createResult.data as { runId?: string; status?: string };
    const runId = createData.runId;

    if (!runId) {
      return {
        runId: '',
        status: 'failed',
        outputs: [],
        error: 'No run was started. Try a more specific brief.',
        finalBrief,
      };
    }

    const result = await this.lamina.runs.wait(runId, {
      intervalMs: 3000,
      timeoutMs: 30 * 60 * 1000,
    });

    if (result.data.status === 'failed') {
      return {
        runId,
        status: 'failed',
        outputs: [],
        error: result.data.errorMessage || 'Generation failed.',
        finalBrief,
      };
    }

    const outputs = result.data.outputs
      .map(toGeneratedAsset)
      .filter((o): o is GeneratedAsset => o !== null);

    return {
      runId,
      status: 'completed',
      outputs,
      error: null,
      finalBrief,
    };
  }

  // -----------------------------------------------------------------------
  // generateForDocument()
  // -----------------------------------------------------------------------

  async generateForDocument(
    documentId: string,
    fieldName: string,
    params?: GenerateForDocumentParams,
  ): Promise<GenerateForDocumentResult> {
    // Fetch document for context
    const doc = await this.sanity.fetch<Record<string, unknown> | null>(
      `*[_id == $id || _id == "drafts." + $id][0]{ _id, _type, title, name, description, excerpt }`,
      { id: documentId },
    );

    const documentType = (doc?._type as string) || 'document';
    const documentTitle = (doc?.title as string) || (doc?.name as string) || null;

    // Build brief
    const brief = params?.brief || buildDefaultBrief(fieldName, documentType, documentTitle);

    // Detect aspect ratio from field name
    const detectedRatio = detectAspectRatio(fieldName);

    const genResult = await this.generate({
      ...params,
      brief,
      aspectRatio: params?.aspectRatio || detectedRatio?.ratio,
      metadata: {
        ...params?.metadata,
        documentType,
        ...(documentTitle ? { documentTitle } : {}),
        fieldName,
        documentId,
      },
    });

    if (genResult.status === 'failed' || genResult.outputs.length === 0) {
      return {
        ...genResult,
        sanityAssetId: null,
        patched: false,
      };
    }

    // Upload first output to Sanity and patch the document
    const output = genResult.outputs[0];
    try {
      const uploadResult = await this.uploadToSanity({
        url: output.url,
        type: output.type === 'video' ? 'file' : 'image',
        filename: `lamina-${fieldName}-${output.id}`,
        source: {
          name: 'lamina',
          id: genResult.runId,
          url: `https://app.uselamina.ai/runs/${genResult.runId}`,
        },
        description: genResult.finalBrief,
        creditLine: 'Generated by Lamina',
        documentId,
        fieldName,
      });

      return {
        ...genResult,
        sanityAssetId: uploadResult.assetId,
        patched: uploadResult.patched,
      };
    } catch {
      return {
        ...genResult,
        sanityAssetId: null,
        patched: false,
      };
    }
  }

  // -----------------------------------------------------------------------
  // fillEmptyMedia()
  // -----------------------------------------------------------------------

  async fillEmptyMedia(params: FillEmptyMediaParams): Promise<FillEmptyMediaResult> {
    const concurrency = params.concurrency || 3;
    const onlyIfEmpty = params.onlyIfEmpty !== false;

    // Fetch documents
    const docs = await this.sanity.fetch<Array<Record<string, unknown>>>(
      params.query,
      params.queryParams || {},
    );

    if (!docs || docs.length === 0) {
      return { documentsProcessed: 0, fieldsGenerated: 0, fieldsSkipped: 0, fieldsFailed: 0, results: [] };
    }

    const result: FillEmptyMediaResult = {
      documentsProcessed: 0,
      fieldsGenerated: 0,
      fieldsSkipped: 0,
      fieldsFailed: 0,
      results: [],
    };

    // Process each document
    await mapWithConcurrency(docs, concurrency, async (doc, docIdx) => {
      const documentId = doc._id as string;
      const documentType = doc._type as string;
      const documentTitle = (doc.title as string) || (doc.name as string) || null;

      // Discover image/file fields from the document itself
      const allFields = await discoverImageFields(this.sanity, documentId);

      // Filter to fields from fieldMapping if provided, otherwise use all
      const targetFields = params.fieldMapping
        ? Object.keys(params.fieldMapping).filter((f) => allFields.includes(f) || !onlyIfEmpty)
        : allFields;

      const docResult: FillEmptyMediaResult['results'][0] = {
        documentId,
        documentTitle,
        fields: [],
      };

      for (const fieldName of targetFields) {
        // Check if field is empty
        if (onlyIfEmpty) {
          const fieldValue = doc[fieldName] as Record<string, unknown> | undefined;
          const hasAsset = fieldValue?.asset && (fieldValue.asset as Record<string, unknown>)?._ref;
          if (hasAsset) {
            docResult.fields.push({
              fieldName, status: 'skipped', brief: null, assetId: null, error: null,
            });
            result.fieldsSkipped++;
            params.onProgress?.({
              documentId, documentTitle, fieldName, status: 'skipped', brief: null, error: null,
              documentsCompleted: docIdx, documentsTotal: docs.length,
            });
            continue;
          }
        }

        // Build brief
        let brief: string;
        if (params.fieldMapping?.[fieldName]) {
          brief = resolveTemplate(params.fieldMapping[fieldName], doc);
        } else {
          brief = buildDefaultBrief(fieldName, documentType, documentTitle);
        }

        if (params.dryRun) {
          docResult.fields.push({
            fieldName, status: 'skipped', brief, assetId: null, error: 'Dry run',
          });
          result.fieldsSkipped++;
          params.onProgress?.({
            documentId, documentTitle, fieldName, status: 'skipped', brief, error: 'Dry run',
            documentsCompleted: docIdx, documentsTotal: docs.length,
          });
          continue;
        }

        params.onProgress?.({
          documentId, documentTitle, fieldName, status: 'generating', brief, error: null,
          documentsCompleted: docIdx, documentsTotal: docs.length,
        });

        try {
          const genResult = await this.generateForDocument(documentId, fieldName, {
            brief,
            enhance: params.enhance,
            brandProfileId: params.brandProfileId,
          });

          if (genResult.status === 'completed' && genResult.patched) {
            docResult.fields.push({
              fieldName, status: 'generated', brief: genResult.finalBrief,
              assetId: genResult.sanityAssetId, error: null,
            });
            result.fieldsGenerated++;
            params.onProgress?.({
              documentId, documentTitle, fieldName, status: 'patched',
              brief: genResult.finalBrief, error: null,
              documentsCompleted: docIdx, documentsTotal: docs.length,
            });
          } else {
            docResult.fields.push({
              fieldName, status: 'failed', brief, assetId: null,
              error: genResult.error || 'Generation failed',
            });
            result.fieldsFailed++;
            params.onProgress?.({
              documentId, documentTitle, fieldName, status: 'failed',
              brief, error: genResult.error || 'Generation failed',
              documentsCompleted: docIdx, documentsTotal: docs.length,
            });
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : 'Unknown error';
          docResult.fields.push({ fieldName, status: 'failed', brief, assetId: null, error });
          result.fieldsFailed++;
          params.onProgress?.({
            documentId, documentTitle, fieldName, status: 'failed', brief, error,
            documentsCompleted: docIdx, documentsTotal: docs.length,
          });
        }
      }

      result.results.push(docResult);
      result.documentsProcessed++;
    });

    return result;
  }

  // -----------------------------------------------------------------------
  // uploadToSanity()
  // -----------------------------------------------------------------------

  async uploadToSanity(params: UploadToSanityParams): Promise<UploadResult> {
    const assetType = params.type || 'image';

    // Transfer through Lamina CDN for CORS safety
    let cdnUrl = params.url;
    try {
      const transfer = await this.lamina.publishing.transferAsset({
        sourceUrl: params.url,
        mediaType: assetType === 'file' ? 'video' : 'image',
        filename: params.filename,
      });
      cdnUrl = transfer.data.cdnUrl;
    } catch {
      // Fall back to direct URL
    }

    // Fetch and upload to Sanity
    const response = await fetch(cdnUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || (assetType === 'file' ? 'video/mp4' : 'image/png');
    const extension = contentType.split('/')[1] || 'png';
    const filename = params.filename || `lamina-asset.${extension}`;

    const asset = await this.sanity.assets.upload(assetType, buffer, {
      filename: filename.includes('.') ? filename : `${filename}.${extension}`,
      contentType,
      source: params.source || { name: 'lamina', id: 'headless' },
      description: params.description,
      creditLine: params.creditLine || 'Generated by Lamina',
    });

    let patched = false;

    // Patch document if requested
    if (params.documentId && params.fieldName) {
      try {
        const fieldType = assetType === 'file' ? 'file' : 'image';
        await this.sanity
          .patch(params.documentId)
          .set({
            [params.fieldName]: {
              _type: fieldType,
              asset: { _type: 'reference', _ref: asset._id },
            },
          })
          .commit();
        patched = true;
      } catch {
        // Patch failed — asset was still uploaded
      }
    }

    return {
      assetId: asset._id,
      url: asset.url,
      patched,
    };
  }

  // -----------------------------------------------------------------------
  // scoreAssets()
  // -----------------------------------------------------------------------

  async scoreAssets(params?: ScoreAssetsParams): Promise<AssetScore[]> {
    const query = params?.query
      || `*[_type in ["sanity.imageAsset", "sanity.fileAsset"] && source.name == "lamina"][0..${(params?.limit || 100) - 1}]{ _id, url, description }`;

    const assets = await this.sanity.fetch<Array<{ _id: string; url: string; description: string | null }>>(query);
    if (!assets || assets.length === 0) return [];

    // Score via the Lamina content.score API
    try {
      const result = await this.lamina.content.score({
        contentItemIds: assets.map((a) => a._id),
        ...(params?.platform ? { platform: params.platform } : {}),
        ...(params?.modality ? { modality: params.modality } : {}),
        limit: params?.limit || 100,
      });

      const scoreMap = new Map<string, number>();
      const scores = (result.data as Record<string, unknown>)?.scores as Array<{ id: string; score: number }> | undefined;
      if (Array.isArray(scores)) {
        for (const s of scores) {
          scoreMap.set(s.id, s.score);
        }
      }

      return assets.map((a) => ({
        assetId: a._id,
        url: a.url,
        score: scoreMap.get(a._id) ?? null,
        brief: a.description,
      }));
    } catch {
      // Scoring not available — return assets without scores
      return assets.map((a) => ({
        assetId: a._id,
        url: a.url,
        score: null,
        brief: a.description,
      }));
    }
  }

  // -----------------------------------------------------------------------
  // intelligence
  // -----------------------------------------------------------------------

  readonly intelligence = {
    trends: async (params?: TrendsParams) => {
      const result = await this.lamina.intelligence.trends(params);
      return result.data;
    },

    predict: async (params: PredictParams) => {
      const result = await this.lamina.intelligence.predict({
        concept: params.concept,
        platform: params.platform,
        modality: params.modality || 'image',
        brandProfileId: params.brandProfileId || this.opts.defaultBrandProfileId,
        campaignId: params.campaignId || this.opts.defaultCampaignId,
      });
      return result.data;
    },

    recommendations: async (params?: RecommendationsParams) => {
      const result = await this.lamina.intelligence.recommendations(params);
      return result.data;
    },

    getBrandContext: async (brandProfileId?: string) => {
      const result = await this.lamina.intelligence.getBrandContext({
        brandProfileId: brandProfileId || this.opts.defaultBrandProfileId,
      });
      return result.data;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a headless Lamina + Sanity client for programmatic content generation.
 *
 * @example
 * ```ts
 * import { createLaminaSanityClient } from 'sanity-plugin-lamina/headless'
 *
 * const lamina = createLaminaSanityClient({
 *   laminaApiKey: process.env.LAMINA_API_KEY,
 *   sanityProjectId: 'abc123',
 *   sanityDataset: 'production',
 *   sanityToken: process.env.SANITY_TOKEN,
 * })
 *
 * // Generate + upload + patch in one call
 * await lamina.generateForDocument('product-123', 'heroImage', {
 *   brief: 'Lifestyle product photo',
 * })
 *
 * // Bulk: find empty fields, generate, patch
 * await lamina.fillEmptyMedia({
 *   query: '*[_type == "product" && !defined(mainImage)]',
 *   fieldMapping: { mainImage: 'Product photo: {{title}}' },
 *   concurrency: 5,
 * })
 * ```
 */
export function createLaminaSanityClient(
  options: LaminaSanityClientOptions,
): LaminaSanityClient {
  return new LaminaSanityClientImpl(options);
}
