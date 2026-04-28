/**
 * Headless entry point for sanity-plugin-lamina.
 *
 * Import from 'sanity-plugin-lamina/headless' — no React or browser required.
 *
 * @example
 * ```ts
 * import { createLaminaSanityClient } from 'sanity-plugin-lamina/headless'
 *
 * const lamina = createLaminaSanityClient({
 *   laminaApiKey: process.env.LAMINA_API_KEY,
 *   sanityProjectId: 'abc123',
 *   sanityToken: process.env.SANITY_TOKEN,
 * })
 *
 * await lamina.generateForDocument('product-123', 'heroImage', {
 *   brief: 'Lifestyle product photo',
 * })
 * ```
 *
 * @packageDocumentation
 */

export { createLaminaSanityClient } from './client.js';

export type {
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
