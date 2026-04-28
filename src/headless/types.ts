/**
 * Types for the headless API layer.
 *
 * These types define the programmatic interface for using Lamina
 * with Sanity outside of the Studio UI — in scripts, pipelines,
 * serverless functions, and CLI tools.
 */

import type { SanityClient } from '@sanity/client';
import type { LaminaAspectRatio } from '../lib/aspectRatio.js';

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

export interface LaminaSanityClientOptions {
  /** Lamina API key. Falls back to LAMINA_API_KEY env var. */
  laminaApiKey?: string;
  /** Lamina API base URL. Defaults to https://app.uselamina.ai */
  laminaBaseUrl?: string;

  /**
   * A pre-configured @sanity/client instance.
   * If provided, sanityProjectId / sanityDataset / sanityToken are ignored.
   */
  sanityClient?: SanityClient;

  /** Sanity project ID. Required if sanityClient is not provided. */
  sanityProjectId?: string;
  /** Sanity dataset. Defaults to 'production'. */
  sanityDataset?: string;
  /** Sanity API token with write access. Falls back to SANITY_TOKEN env var. */
  sanityToken?: string;
  /** Sanity API version. Defaults to '2024-01-01'. */
  sanityApiVersion?: string;

  /** Default brand profile ID for all generations. */
  defaultBrandProfileId?: string;
  /** Default campaign ID for all generations. */
  defaultCampaignId?: string;
  /** Webhook URL passed to Lamina for completion notifications. */
  webhookUrl?: string;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GenerateParams {
  /** The generation brief / prompt. */
  brief: string;
  /** Output modality. Defaults to 'image'. */
  modality?: 'image' | 'video';
  /** Aspect ratio hint. */
  aspectRatio?: LaminaAspectRatio;
  /** Pin a specific Lamina app. */
  appId?: string;
  /** Brand profile ID (overrides client default). */
  brandProfileId?: string;
  /** Campaign ID (overrides client default). */
  campaignId?: string;
  /** Additional inputs for the selected app. */
  inputs?: Record<string, unknown>;
  /** Whether to auto-enhance the brief before generation. Defaults to true. */
  enhance?: boolean;
  /** Auto-quality control. */
  autoQuality?: { enabled: boolean; minScore?: number; maxRetries?: number };
  /** Metadata to attach to the generation request. */
  metadata?: Record<string, string>;
}

export interface GeneratedAsset {
  id: string;
  type: 'image' | 'video' | 'text' | string;
  url: string;
  mimeType: string | null;
  label: string;
  dimensions: { width: number; height: number } | null;
  durationSeconds: number | null;
}

export interface GenerationResult {
  runId: string;
  status: 'completed' | 'failed';
  outputs: GeneratedAsset[];
  error: string | null;
  /** The (possibly enhanced) brief that was actually sent to the API. */
  finalBrief: string;
}

// ---------------------------------------------------------------------------
// Document operations
// ---------------------------------------------------------------------------

export interface GenerateForDocumentParams extends Omit<GenerateParams, 'brief'> {
  /** Override the auto-generated brief. If omitted, built from document context. */
  brief?: string;
}

export interface GenerateForDocumentResult extends GenerationResult {
  /** The Sanity asset document ID after upload. Null if upload failed or was skipped. */
  sanityAssetId: string | null;
  /** Whether the document was patched with the new asset. */
  patched: boolean;
}

export interface FillEmptyMediaParams {
  /** GROQ query that returns documents to process. Must return _id and _type. */
  query: string;
  /** GROQ query params. */
  queryParams?: Record<string, unknown>;
  /**
   * Mapping of field names to brief templates.
   * Templates support {{fieldName}} placeholders resolved from the document.
   * If omitted, briefs are auto-generated from field names and document context.
   */
  fieldMapping?: Record<string, string>;
  /** Only generate for fields that are currently empty. Defaults to true. */
  onlyIfEmpty?: boolean;
  /** Max concurrent generations. Defaults to 3. */
  concurrency?: number;
  /** Whether to auto-enhance briefs. Defaults to true. */
  enhance?: boolean;
  /** Brand profile ID for all generations. */
  brandProfileId?: string;
  /** Called after each field is processed. */
  onProgress?: (event: FillProgressEvent) => void;
  /** If true, don't actually generate or patch — just report what would happen. */
  dryRun?: boolean;
}

export interface FillProgressEvent {
  documentId: string;
  documentTitle: string | null;
  fieldName: string;
  status: 'generating' | 'uploading' | 'patched' | 'skipped' | 'failed';
  brief: string | null;
  error: string | null;
  /** Progress: documents completed / total documents. */
  documentsCompleted: number;
  documentsTotal: number;
}

export interface FillEmptyMediaResult {
  /** Total documents processed. */
  documentsProcessed: number;
  /** Total fields generated. */
  fieldsGenerated: number;
  /** Total fields skipped (already filled or failed). */
  fieldsSkipped: number;
  /** Total fields that failed. */
  fieldsFailed: number;
  /** Per-document results. */
  results: Array<{
    documentId: string;
    documentTitle: string | null;
    fields: Array<{
      fieldName: string;
      status: 'generated' | 'skipped' | 'failed';
      brief: string | null;
      assetId: string | null;
      error: string | null;
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// Asset operations
// ---------------------------------------------------------------------------

export interface UploadToSanityParams {
  /** URL of the asset to upload. */
  url: string;
  /** Asset type. Defaults to 'image'. */
  type?: 'image' | 'file';
  /** Filename for the uploaded asset. */
  filename?: string;
  /** Source metadata. */
  source?: {
    name: string;
    id: string;
    url?: string;
  };
  /** Description stored on the asset document. */
  description?: string;
  /** Credit line. */
  creditLine?: string;
  /** Document ID to associate the asset with (stored in source metadata). */
  documentId?: string;
  /** Field name to patch on the document after upload. */
  fieldName?: string;
}

export interface UploadResult {
  assetId: string;
  url: string;
  patched: boolean;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoreAssetsParams {
  /** GROQ query returning asset documents. */
  query?: string;
  /** Limit. Defaults to 100. */
  limit?: number;
  /** Platform context. */
  platform?: string;
  /** Modality context. */
  modality?: string;
}

export interface AssetScore {
  assetId: string;
  url: string;
  score: number | null;
  brief: string | null;
}

// ---------------------------------------------------------------------------
// Intelligence
// ---------------------------------------------------------------------------

export interface TrendsParams {
  category?: string;
  platform?: string;
  windowDays?: number;
  limit?: number;
}

export interface PredictParams {
  /** The content concept string to predict performance for. */
  concept: string;
  /** Target platform (e.g. 'instagram', 'twitter'). */
  platform: string;
  /** Modality (e.g. 'image', 'video'). Defaults to 'image'. */
  modality?: string;
  brandProfileId?: string;
  campaignId?: string;
}

export interface RecommendationsParams {
  campaignId?: string;
  workflowId?: string;
  brandProfileId?: string;
  platform?: string;
  objective?: string;
  modality?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// The client interface
// ---------------------------------------------------------------------------

export interface LaminaSanityClient {
  /** The underlying Lamina SDK client. */
  readonly lamina: import('@uselamina/sdk').LaminaClient;
  /** The underlying Sanity client. */
  readonly sanity: SanityClient;

  /**
   * Generate content and return outputs without uploading to Sanity.
   */
  generate(params: GenerateParams): Promise<GenerationResult>;

  /**
   * Generate content for a specific document field.
   * Uploads the first output to Sanity and patches the document.
   */
  generateForDocument(
    documentId: string,
    fieldName: string,
    params?: GenerateForDocumentParams,
  ): Promise<GenerateForDocumentResult>;

  /**
   * Find documents matching a GROQ query and fill their empty media fields.
   * The workhorse for bulk content generation.
   */
  fillEmptyMedia(params: FillEmptyMediaParams): Promise<FillEmptyMediaResult>;

  /**
   * Upload an asset URL to Sanity and optionally patch a document field.
   */
  uploadToSanity(params: UploadToSanityParams): Promise<UploadResult>;

  /**
   * Score existing Lamina-generated assets.
   */
  scoreAssets(params?: ScoreAssetsParams): Promise<AssetScore[]>;

  /** Intelligence sub-client. */
  readonly intelligence: {
    trends(params?: TrendsParams): Promise<unknown>;
    predict(params: PredictParams): Promise<unknown>;
    recommendations(params?: RecommendationsParams): Promise<unknown>;
    getBrandContext(brandProfileId?: string): Promise<unknown>;
  };
}
