export interface LaminaOAuthConfig {
  /**
   * OAuth client ID for Lamina. Optional — when omitted, the plugin
   * dynamically registers itself with the Lamina auth server on the first
   * "Sign in with Lamina" click and caches the assigned client ID in
   * localStorage. Set this explicitly only if your operations team has
   * pre-provisioned a client_id (rare).
   */
  clientId?: string;
  /**
   * OAuth redirect URI. Defaults to `{window.location.origin}/lamina/callback`.
   */
  redirectUri?: string;
  /**
   * Storage key prefix for persisting tokens. Defaults to `'lamina_oauth'`.
   */
  storageKey?: string;
}

/** Output format preset that maps a field name to generation parameters. */
export interface LaminaPreset {
  /** Aspect ratio hint passed to the generation API (e.g. '16:9', '1:1'). */
  aspectRatio?: string;
  /** Modality override (e.g. 'image', 'video'). */
  modality?: string;
  /** Target platform hint (e.g. 'instagram', 'twitter'). */
  platform?: string;
  /** Pin a specific Lamina app for this field. */
  appId?: string;
}

export interface LaminaPluginOptions {
  /** Lamina API key (team-level auth). Falls back to per-user OAuth if not set. */
  apiKey?: string;
  /** Lamina API base URL. Defaults to https://app.uselamina.ai */
  baseUrl?: string;
  /**
   * OAuth configuration for per-user authentication.
   * When set, users without a team-level apiKey can authenticate individually.
   */
  oauth?: LaminaOAuthConfig;
  /**
   * Whether to register the Lamina Editor as a Studio tool in the top nav.
   * @default true
   */
  enableTool?: boolean;
  /**
   * Webhook URL for receiving generation completion events.
   * When set, the plugin will pass this URL to the Lamina API
   * and listen for completion via SSE/polling instead of repeated GET requests.
   * Falls back to standard polling if not set.
   */
  webhookUrl?: string;
  /**
   * Whether to register the "Regenerate Media" document action
   * for documents containing Lamina-sourced assets.
   * @default true
   */
  enableDocumentAction?: boolean;
  /**
   * Output format presets mapping field names to generation parameters.
   * Keys are matched against the schema field name (e.g. 'ogImage', 'thumbnail').
   * Custom presets override the built-in defaults.
   *
   * Built-in defaults: ogImage, socialImage, storyImage, thumbnail, avatar.
   */
  presets?: Record<string, LaminaPreset>;
}

/** Metadata stored on Sanity asset documents for Lamina-generated assets. */
export interface LaminaAssetSourceMeta {
  name: 'lamina';
  id: string;
  url: string;
  /** The Sanity document ID from which this asset was generated. */
  documentId?: string;
}

/** A Lamina-sourced asset stored in Sanity. */
export interface LaminaAsset {
  _id: string;
  _type: string;
  url: string;
  originalFilename: string | null;
  mimeType: string | null;
  size: number | null;
  _createdAt: string;
  /** The original brief used to generate this asset. */
  description: string | null;
  source: {
    name: string;
    id: string;
    url?: string;
  } | null;
}

export type AssetTypeFilter = 'all' | 'images' | 'videos';

export type GenerationStatus = 'idle' | 'discovering' | 'generating' | 'needs-input' | 'completed' | 'failed';

export interface GenerationState {
  status: GenerationStatus;
  runId: string | null;
  outputs: GeneratedOutput[];
  error: string | null;
  /** 0-100 progress hint (null when unknown). */
  progress: number | null;
}

export interface GeneratedOutput {
  id: string;
  type: 'image' | 'video' | 'text' | string;
  url: string;
  mimeType: string | null;
  label: string;
  dimensions: { width: number; height: number } | null;
  durationSeconds: number | null;
}
