export interface LaminaPluginOptions {
  /** Lamina API key (team-level auth). */
  apiKey?: string;
  /** Lamina API base URL. Defaults to https://app.uselamina.ai */
  baseUrl?: string;
  /**
   * Whether to register the Lamina Editor as a Studio tool in the top nav.
   * @default true
   */
  enableTool?: boolean;
  /**
   * Whether to register the "Regenerate Media" document action
   * for documents containing Lamina-sourced assets.
   * @default true
   */
  enableDocumentAction?: boolean;
}

/** Metadata stored on Sanity asset documents for Lamina-generated assets. */
export interface LaminaAssetSourceMeta {
  name: 'lamina';
  id: string;
  url: string;
}

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
