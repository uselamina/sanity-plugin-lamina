import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Checkbox,
  Dialog,
  Flex,
  Grid,
  Inline,
  Label,
  Select,
  Spinner,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Text,
  TextArea,
  TextInput,
} from '@sanity/ui';
import {
  BoltIcon,
  CheckmarkCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  ResetIcon,
  SearchIcon,
  UploadIcon,
} from '@sanity/icons';
import type { AssetFromSource, AssetSourceComponentProps } from 'sanity';
import { useFormValue, useSchema } from 'sanity';
import { useSanityAssets } from '../lib/useSanityAssets.js';
import { AssetPickerGrid } from './AssetPickerGrid.js';
import { AppPickerPanel } from './AppPickerPanel.js';
import { MissingInputsForm } from './MissingInputsForm.js';
import type { AssetTypeFilter, LaminaAsset, LaminaPreset } from '../types.js';
import type {
  AppSummary as SdkAppSummary,
  CostEstimate,
  ContentBriefParams,
  ContentConcept,
  ExecutionOutput,
  ExecutionStatus,
  MissingInput,
  PreviewRunResult,
  PreviewAppMode,
  PreviewFreestyleMode,
  PreviewAgentFailedMode,
  FormField,
  RunConfirmedParams,
} from '@uselamina/sdk';
import { LaminaAuthError, LaminaRateLimitError } from '@uselamina/sdk';

// SDK 0.2.0 has native `progress`, `inputSummary`, `modality`, `icon` fields on
// AppSummary / ExecutionStatus, so we no longer need extension interfaces for
// those. The one remaining augmentation: `credits.manageUrl` on CostEstimate
// hasn't shipped to the SDK yet.

interface CostEstimateWithManageUrl extends CostEstimate {
  credits?: { manageUrl?: string };
}
import { useLamina } from '../lib/LaminaContext.js';
import { getRoutedAppId, saveRoutedAppId, clearRoutedAppId } from '../lib/appRouting.js';
import { clearRecentBriefs, getRecentBriefs, saveRecentBrief } from '../lib/recentBriefs.js';
import { detectAspectRatio, ASPECT_RATIO_OPTIONS } from '../lib/aspectRatio.js';
import type { LaminaAspectRatio } from '../lib/aspectRatio.js';
import type { GeneratedOutput, GenerationState } from '../types.js';
import type { EnhanceResult } from '../lib/briefEnhancer.js';
import { useDocumentBrief } from '../lib/useDocumentBrief.js';
import { classifyRunFailure } from '../lib/classifyGenerationError.js';
import {
  clearDialogState,
  patchDialogState,
  readDialogState,
  type CachedRunMode,
  type PreviewCache,
  type RunCache,
} from '../lib/dialogStore.js';

const MODALITIES = [
  { value: '', label: 'Auto-detect' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
] as const;

/** Built-in presets for common field names. Custom presets override these. */
const DEFAULT_PRESETS: Record<string, LaminaPreset> = {
  ogImage: { aspectRatio: '16:9', modality: 'image' },
  socialImage: { aspectRatio: '16:9', modality: 'image' },
  storyImage: { aspectRatio: '9:16', modality: 'image' },
  thumbnail: { aspectRatio: '1:1', modality: 'image' },
  avatar: { aspectRatio: '1:1', modality: 'image' },
};

/**
 * Resolve a preset for the current field.
 * Custom presets from plugin config take precedence over built-in defaults.
 * Returns `[presetName, preset]` or `null` if no match.
 */
function resolvePreset(
  fieldName: string | undefined,
  customPresets: Record<string, LaminaPreset> | undefined,
): [string, LaminaPreset] | null {
  if (!fieldName) return null;
  // Custom presets override defaults
  if (customPresets?.[fieldName]) {
    return [fieldName, customPresets[fieldName]];
  }
  if (DEFAULT_PRESETS[fieldName]) {
    return [fieldName, DEFAULT_PRESETS[fieldName]];
  }
  return null;
}

/** 30 minutes in milliseconds. */
const GENERATION_TIMEOUT_MS = 30 * 60 * 1000;
/** Show a warning 5 minutes before timeout. */
const TIMEOUT_WARNING_MS = GENERATION_TIMEOUT_MS - 5 * 60 * 1000;

/** Prompt suggestions by schema type. */
const SCHEMA_SUGGESTIONS: Record<string, string[]> = {
  product: [
    'Product photo on clean white background',
    'Lifestyle shot showing product in use',
    'Social media ad with product highlight',
  ],
  blogPost: [
    'Blog header illustration matching the topic',
    'Social share image with title overlay',
  ],
  article: [
    'Article header image',
    'Social share card for article',
  ],
  landingPage: [
    'Hero banner for landing page',
    'Feature section illustration',
  ],
  page: [
    'Page hero banner',
    'Section background image',
  ],
};

const DEFAULT_IMAGE_SUGGESTIONS = [
  'Product photo',
  'Marketing banner',
  'Social media post',
];

const DEFAULT_VIDEO_SUGGESTIONS = [
  'Product demo video',
  'Social media reel',
  'Promotional clip',
];

function getSuggestions(documentType: string | undefined, assetType: 'image' | 'file'): string[] {
  if (documentType) {
    const match = SCHEMA_SUGGESTIONS[documentType];
    if (match) return match;
    // Try lowercase match
    const lower = documentType.toLowerCase();
    for (const [key, suggestions] of Object.entries(SCHEMA_SUGGESTIONS)) {
      if (lower.includes(key.toLowerCase())) return suggestions;
    }
  }
  return assetType === 'file' ? DEFAULT_VIDEO_SUGGESTIONS : DEFAULT_IMAGE_SUGGESTIONS;
}

interface BrandProfileEntry {
  id: string;
  name: string;
}

interface CampaignEntry {
  id: string;
  name: string;
}

interface NeedsInputContext {
  message: string;
  missing: MissingInput[];
  appId?: string;
  workflowId?: string;
}

interface AppEntry {
  appId: string;
  name: string;
  description: string | null;
  capabilities: SdkAppSummary['capabilities'];
  icon?: string | null;
  modality?: string | null;
  inputSummary?: string | null;
  /** Optional empty-state media (image/video URL) — when present, picker
   *  renders a card with the thumbnail instead of a plain list row. */
  thumbnail?: { url: string; type: 'image' | 'video' } | null;
}

interface AppPickerState {
  expanded: boolean;
  loading: boolean;
  apps: AppEntry[];
  error: string | null;
  mode: 'list' | 'discover';
}

function toGeneratedOutput(out: ExecutionOutput): GeneratedOutput | null {
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

function failureMessageFromRun(run: ExecutionStatus): string {
  const parentError = typeof run.errorMessage === 'string' ? run.errorMessage.trim() : '';
  if (parentError) return parentError;

  const outputError = (run.outputs ?? [])
    .map((output) => (typeof output.error === 'string' ? output.error.trim() : ''))
    .find(Boolean);

  return outputError || 'Generation failed.';
}

function progressFromStatus(status: ExecutionStatus): number | null {
  // SDK 0.2.0 provides native progress.percentComplete (number | null).
  if (typeof status.progress?.percentComplete === 'number') {
    return Math.round(status.progress.percentComplete);
  }
  // Fallback for older API responses without granular progress
  switch (status.status) {
    case 'queued':
      return 0;
    case 'running':
      return 0;
    case 'completed':
      return 100;
    case 'failed':
      return null;
    default:
      return null;
  }
}

/**
 * Merge a freshly-observed progress value with the previously-displayed one,
 * never going backward. Industry-standard loader behavior — once the user
 * has seen "30%" we don't show them "10%" again, even if the server's notion
 * of progress dipped (e.g. queued→running transition reports 0% momentarily).
 *
 * Keeps null only when both are null. A real number always wins over null.
 */
function monotonicProgress(prev: number | null, next: number | null): number | null {
  if (next == null) return prev;
  if (prev == null) return next;
  return next > prev ? next : prev;
}

function describeError(err: unknown): string {
  if (err instanceof LaminaAuthError) {
    return 'Invalid or expired API key. Please check your Lamina API key configuration.';
  }
  if (err instanceof LaminaRateLimitError) {
    const wait = err.retryAfterSeconds;
    return wait != null && wait > 0
      ? `Rate limited. Please wait ${wait} seconds before trying again.`
      : 'Rate limited. Please wait a moment before trying again.';
  }
  if (
    err instanceof TypeError &&
    typeof err.message === 'string' &&
    err.message.toLowerCase().includes('fetch')
  ) {
    return 'Network error. Please check your connection.';
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'An unexpected error occurred.';
}

function isMediaParam(param: MissingInput): boolean {
  return (
    param.type === 'url' &&
    Array.isArray(param.accept) &&
    param.accept.some((a) => a === 'image' || a === 'video')
  );
}

function MediaInputField({
  param,
  value,
  onChange,
  laminaClient,
}: {
  param: MissingInput;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
  laminaClient: ReturnType<typeof useLamina>['client'];
}) {
  const label = param.description || param.name;
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setUploading(true);
      try {
        // Show local preview immediately
        setPreview(URL.createObjectURL(file));
        // Upload via transferAsset to get a CDN URL
        const mediaType = file.type.startsWith('video/') ? 'video' : 'image';
        const result = await laminaClient.publishing.transferAsset({
          sourceUrl: URL.createObjectURL(file),
          mediaType: mediaType as 'image' | 'video',
          filename: file.name,
        });
        onChange(param.name, result.data.cdnUrl);
      } catch {
        // Fall back: create a blob URL (won't work for server-side, but shows intent)
        onChange(param.name, URL.createObjectURL(file));
      } finally {
        setUploading(false);
      }
    },
    [laminaClient, param.name, onChange],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const currentUrl = typeof value === 'string' ? value : null;

  return (
    <Stack space={2}>
      <Label size={1}>{label}</Label>
      {currentUrl || preview ? (
        <Card padding={2} radius={2} border>
          <Flex align="center" gap={3}>
            <img
              src={preview || currentUrl!}
              alt=""
              style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 4 }}
            />
            <Text size={1} muted textOverflow="ellipsis" style={{ flex: 1 }}>
              {uploading ? 'Uploading...' : 'Image attached'}
            </Text>
            <Button
              text="Change"
              mode="ghost"
              fontSize={0}
              padding={1}
              onClick={() => fileRef.current?.click()}
            />
          </Flex>
        </Card>
      ) : (
        <Card
          padding={4}
          radius={2}
          border
          tone="transparent"
          style={{ textAlign: 'center', cursor: 'pointer' }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
        >
          <Stack space={2}>
            <Flex justify="center">
              {uploading ? <Spinner /> : <UploadIcon />}
            </Flex>
            <Text size={1} muted>
              {uploading ? 'Uploading...' : 'Drop file here or click to upload'}
            </Text>
            {param.accept ? (
              <Text size={0} muted>
                Accepts: {param.accept.join(', ')}
              </Text>
            ) : null}
          </Stack>
        </Card>
      )}
      <input
        ref={fileRef}
        type="file"
        accept={param.accept?.map((a) => `${a}/*`).join(',') ?? 'image/*'}
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />
      {/* Fallback URL input */}
      <TextInput
        value={currentUrl ?? ''}
        onChange={(e) => onChange(param.name, e.currentTarget.value)}
        placeholder="Or paste a URL"
        fontSize={0}
      />
    </Stack>
  );
}

function ParameterField({
  param,
  value,
  onChange,
  laminaClient,
}: {
  param: MissingInput;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
  laminaClient?: ReturnType<typeof useLamina>['client'];
}) {
  const label = param.description || param.name;

  // Upgrade URL params with media accepts to the rich media input
  if (isMediaParam(param) && laminaClient) {
    return (
      <MediaInputField
        param={param}
        value={value}
        onChange={onChange}
        laminaClient={laminaClient}
      />
    );
  }

  switch (param.type) {
    case 'options':
      return (
        <Stack space={2}>
          <Label size={1}>{label}</Label>
          <TextInput
            value={(value as string) ?? ''}
            onChange={(e) => onChange(param.name, e.currentTarget.value)}
            placeholder={param.examples?.length ? `e.g. ${param.examples[0]}` : 'Enter value'}
          />
        </Stack>
      );
    case 'url':
      return (
        <Stack space={2}>
          <Label size={1}>{label}</Label>
          <TextInput
            value={(value as string) ?? ''}
            onChange={(e) => onChange(param.name, e.currentTarget.value)}
            placeholder={param.accept ? `URL (accepts: ${param.accept.join(', ')})` : 'URL'}
          />
        </Stack>
      );
    case 'text':
    default:
      return (
        <Stack space={2}>
          <Label size={1}>{label}</Label>
          <TextInput
            value={(value as string) ?? ''}
            onChange={(e) => onChange(param.name, e.currentTarget.value)}
          />
        </Stack>
      );
  }
}

/**
 * Extracts a plain-text excerpt (up to 200 chars) from common document body fields.
 * Handles plain strings and portable text arrays.
 */
function extractDocumentExcerpt(
  body: unknown,
  content: unknown,
  description: string | undefined,
  excerpt: string | undefined,
): string | null {
  // Prefer explicit excerpt/description (usually short summaries)
  if (excerpt && typeof excerpt === 'string' && excerpt.trim()) {
    return excerpt.trim().substring(0, 200);
  }
  if (description && typeof description === 'string' && description.trim()) {
    return description.trim().substring(0, 200);
  }

  // Try to extract plain text from portable text blocks
  const ptSource = body ?? content;
  if (Array.isArray(ptSource)) {
    const textParts: string[] = [];
    for (const block of ptSource) {
      if (
        block &&
        typeof block === 'object' &&
        '_type' in block &&
        (block as Record<string, unknown>)._type === 'block' &&
        Array.isArray((block as Record<string, unknown>).children)
      ) {
        for (const child of (block as Record<string, unknown>).children as Array<Record<string, unknown>>) {
          if (typeof child.text === 'string') {
            textParts.push(child.text);
          }
        }
      }
      if (textParts.join(' ').length >= 200) break;
    }
    const joined = textParts.join(' ').trim();
    if (joined) return joined.substring(0, 200);
  }

  // Plain string body
  if (typeof ptSource === 'string' && ptSource.trim()) {
    return ptSource.trim().substring(0, 200);
  }

  return null;
}

// Brief placeholder + AI suggestion logic now lives in `useDocumentBrief`
// (see ../lib/useDocumentBrief.ts). The legacy `buildSuggestedBrief` +
// FIELD_LABELS + TYPE_LABELS were duplicated in there as the canonical
// source — removed from this file.

export function GenerateDialog(props: AssetSourceComponentProps) {
  const {
    assetType: rawAssetType,
    selectionType,
    onSelect,
    onClose,
  } = props;

  const assetType = rawAssetType === 'image' ? 'image' : 'file';
  const { client, options } = useLamina();

  // -- Document context via useFormValue --
  const documentId = useFormValue(['_id']) as string | undefined;
  const documentTitle = useFormValue(['title']) as string | undefined
    || useFormValue(['name']) as string | undefined;
  const documentType = useFormValue(['_type']) as string | undefined;
  // Full Sanity document JSON. Passed to /v1/content/auto-generate so the
  // server-side agent can choose the right app and draft inputs from full
  // doc context (title, body, asset URLs already on the doc, etc.).
  const fullDocument = useFormValue([]) as Record<string, unknown> | undefined;

  // Read common body fields to enrich AI brief suggestions (#51)
  const rawBody = useFormValue(['body']) as unknown;
  const rawContent = useFormValue(['content']) as unknown;
  const rawDescription = useFormValue(['description']) as string | undefined;
  const rawExcerpt = useFormValue(['excerpt']) as string | undefined;
  const documentExcerpt = extractDocumentExcerpt(rawBody, rawContent, rawDescription, rawExcerpt);

  // Derive field name from the parent path if available
  const parentSchemaType = (props as unknown as Record<string, unknown>).schemaType as
    | { name?: string; description?: string; parent?: { name?: string } }
    | undefined;
  const fieldName = parentSchemaType?.name;
  const fieldDescription = parentSchemaType?.description ?? undefined;

  const suggestions = getSuggestions(documentType, assetType);
  const [recentBriefsVersion, setRecentBriefsVersion] = useState(0);
  const recentBriefs = useMemo(
    () => getRecentBriefs(documentType, fieldName),
    [documentType, fieldName, recentBriefsVersion],
  );

  // -- Preset resolution --
  const presetMatch = resolvePreset(fieldName, options.presets);
  const activePresetName = presetMatch?.[0] ?? null;
  const activePreset = presetMatch?.[1] ?? null;

  const [dialogTab, setDialogTab] = useState<'generate' | 'library'>('generate');
  const [modality, setModality] = useState(activePreset?.modality ?? '');
  // Number of variants. Used by the freestyle path on the server (clamped [1, 8]).
  // Ignored when the agent picks an app run.
  const [numVariants, setNumVariants] = useState<number>(2);

  // -- Aspect ratio auto-detection --
  const detectedRatio = detectAspectRatio(fieldName);
  const [aspectRatioOverride, setAspectRatioOverride] = useState<LaminaAspectRatio | ''>('');
  const effectiveAspectRatio: LaminaAspectRatio | null =
    aspectRatioOverride || detectedRatio?.ratio || null;

  // Lazy initializer: synchronously hydrate `state` from a previously-stored
  // run for this (doc, field) so reopening the dialog brings back the same
  // results / spinner / error. The dialogStore enforces RUN_TTL — entries
  // older than 24h come back as `run: null`, which falls through to the
  // fresh-start default. The mount-effect below verifies still-running runs
  // against the server before resuming polling.
  //
  // Run cache takes priority over preview cache: if a run exists, the user
  // already moved past the form-fill step; we don't restore the form. If no
  // run but a fresh preview exists, we hydrate state to 'reviewing' (handled
  // alongside the previewResult / editedInputs initializers below).
  const [state, setState] = useState<GenerationState>(() => {
    const cached = readDialogState(documentId, fieldName);
    const cachedRun = cached?.run;
    if (cachedRun) {
      const status: GenerationState['status'] =
        cachedRun.status === 'generating'
          ? 'generating'
          : cachedRun.status === 'completed'
            ? 'completed'
            : cachedRun.status === 'failed'
              ? 'failed'
              : 'idle';
      return {
        status,
        runId: cachedRun.runId,
        outputs: cachedRun.outputs ?? [],
        error: cachedRun.error,
        progress: cachedRun.progress,
      };
    }
    // No run cached. If a fresh preview snapshot exists (form-fill in progress
    // when the dialog last closed), come back into the 'reviewing' state so
    // MissingInputsForm renders with the user's previous values intact.
    if (cached?.preview?.previewResult) {
      return { status: 'reviewing', runId: null, outputs: [], error: null, progress: null };
    }
    return { status: 'idle', runId: null, outputs: [], error: null, progress: null };
  });

  // True iff the initial mount restored a 'generating' state from cache. Used
  // by the resume effect to render a quieter "Checking previous run…" message
  // until the first server fetch resolves, instead of flashing the regular
  // generating spinner. Flips to false the moment the resume completes.
  const [isResumingFromCache, setIsResumingFromCache] = useState<boolean>(() => {
    const cached = readDialogState(documentId, fieldName);
    return cached?.run?.status === 'generating';
  });

  // The cached `mode` field. Needed by the resume effect to know whether to
  // call `client.runs.get` or `client.freestyle.get` against the runId.
  const [cachedRunMode, setCachedRunMode] = useState<CachedRunMode | null>(() => {
    const cached = readDialogState(documentId, fieldName);
    return cached?.run?.mode ?? null;
  });

  // hasCachedState is derived after the useDocumentBrief hook call below
  // (it needs briefStatus to be in scope). Lives there to avoid a forward-
  // reference dance.

  // needsInput state (legacy auto-generate flow — kept for back-compat)
  const [needsInputCtx, setNeedsInputCtx] = useState<NeedsInputContext | null>(null);
  const [collectedInputs, setCollectedInputs] = useState<Record<string, unknown>>({});

  // ─── Preview-then-confirm flow ─────────────────────────────────────────────
  // The agent drafts the plan in "preview mode" without dispatching anything.
  // The plugin shows a decision card; user reviews drafted inputs, fills missing
  // ones (one-tap suggested defaults available), then clicks "Confirm" to dispatch.
  //
  // Both `previewResult` and `editedInputs` are persisted via dialogStore on
  // change (PREVIEW_TTL_MS), so a user closing the dialog mid-form-fill can
  // come back and pick up where they left off. Hydrated from cache here when
  // a fresh preview snapshot exists AND no run has been started.
  const [previewResult, setPreviewResult] = useState<PreviewRunResult | null>(() => {
    const cached = readDialogState(documentId, fieldName);
    if (cached?.run) return null; // run takes priority — past the form
    const pv = cached?.preview;
    if (!pv?.previewResult) return null;
    // Cast through `unknown` because the cache stores a structured-clone-safe
    // shape (Record<string, unknown>) and we trust it matches PreviewRunResult
    // — schema-versioned at the cache layer, so a stale-shape entry was
    // already dropped by readDialogState.
    return pv.previewResult as unknown as PreviewRunResult;
  });
  // User-edited values — overrides what the agent drafted. Keyed by input name.
  // Includes both edits to drafted inputs AND fills for missing inputs.
  const [editedInputs, setEditedInputs] = useState<Record<string, unknown>>(() => {
    const cached = readDialogState(documentId, fieldName);
    if (cached?.run) return {};
    return cached?.preview?.editedInputs ?? {};
  });

  // Timeout warning (#56)
  const [timeoutWarning, setTimeoutWarning] = useState(false);
  const timeoutWarningRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Multi-select state (#10)
  const [selectedOutputIds, setSelectedOutputIds] = useState<Set<string>>(new Set());

  // Credit estimate state (#4)
  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);

  // App picker state — auto-select from routing history
  const routedAppId = getRoutedAppId(documentType, fieldName);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(routedAppId);
  const [selectedAppName, setSelectedAppName] = useState<string | null>(null);
  const [appPicker, setAppPicker] = useState<AppPickerState>({
    expanded: false,
    loading: false,
    apps: [],
    error: null,
    mode: 'list',
  });
  const [showAllApps, setShowAllApps] = useState(false);

  // Brand profile and campaign state
  const [brandProfiles, setBrandProfiles] = useState<BrandProfileEntry[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignEntry[]>([]);
  const [selectedBrandId, setSelectedBrandId] = useState<string>('');
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>('');
  const [brandsLoaded, setBrandsLoaded] = useState(false);

  // -- Enhance brief state (#66) --
  // (Separate feature from the auto-suggested AI brief. This is the
  //  "Enhance brief before generating" toggle that fires at click-Generate
  //  time to refine the user's brief before it goes to the run pipeline.)
  const [enhanceEnabled, setEnhanceEnabled] = useState(true);
  const [enhanceResult, setEnhanceResult] = useState<EnhanceResult | null>(null);
  const [enhanceLoading, setEnhanceLoading] = useState(false);

  // -- Document brief (the textarea state machine) --
  // One hook owns: brief value, system-vs-user status, mount-effect AI fetch,
  // typeahead chips. Replaces the previous 7-state-variable tangle.
  const {
    briefText: brief,
    setBriefText: setBrief,
    applyChip,
    resetBrief,
    briefStatus,
    typeaheadChips,
    typeaheadLoading,
  } = useDocumentBrief({
    client,
    documentId,
    documentType,
    documentTitle: documentTitle ?? undefined,
    documentExcerpt: documentExcerpt ?? undefined,
    fieldName,
    fieldDescription,
    fullDocument,
    modality,
    assetType,
    selectedBrandId: selectedBrandId || undefined,
    typeaheadEnabled:
      enhanceEnabled && (state.status === 'idle' || state.status === 'failed'),
  });

  // Whether the textarea is showing a system-set value (initial placeholder
  // or AI-replaced). Drives the "Suggested from document context" caption.
  // After the user types ('user-edited') OR picks a chip ('chip-applied'),
  // the text is theirs — no caption.
  const briefPreFilled =
    briefStatus === 'placeholder' || briefStatus === 'ai-loading' || briefStatus === 'ai-ready';

  // Derived: is anything worth clearing in localStorage for this (doc, field)?
  //   - briefStatus past 'placeholder' means the brief cache holds something.
  //   - state.runId means the run cache holds a run.
  //   - recentBriefs means the older per-(docType, field) prompt history has entries.
  // Re-renders keep this in sync with the underlying state — no separate
  // useState, no localStorage polling.
  const hasCachedState =
    briefStatus !== 'placeholder' || state.runId !== null || recentBriefs.length > 0;

  // Auto-set app from preset on mount
  useEffect(() => {
    if (activePreset?.appId && !selectedAppId) {
      setSelectedAppId(activePreset.appId);
    }
  }, [activePreset?.appId, selectedAppId]);

  // Library picker state
  const [libraryFilter, setLibraryFilter] = useState<AssetTypeFilter>(
    assetType === 'image' ? 'images' : 'all',
  );
  const [librarySearch, setLibrarySearch] = useState('');
  const [libraryDocFilter, setLibraryDocFilter] = useState(false);
  const libraryAssets = useSanityAssets({
    typeFilter: libraryFilter,
    search: librarySearch,
    pageSize: 12,
    documentId: libraryDocFilter ? documentId : undefined,
  });

  const handleSelectFromLibrary = useCallback(
    (asset: LaminaAsset) => {
      onSelect([
        {
          kind: 'assetDocumentId',
          value: asset._id,
        } as AssetFromSource,
      ]);
    },
    [onSelect],
  );

  const abortRef = useRef<AbortController | null>(null);

  // Refs for the cards that should snap into view when state transitions.
  // We auto-scroll to these so users don't miss the spinner / variants below
  // the fold of the dialog. Pure UX — no logic dependency.
  const generatingCardRef = useRef<HTMLDivElement | null>(null);
  const completedCardRef = useRef<HTMLDivElement | null>(null);
  const reviewingCardRef = useRef<HTMLDivElement | null>(null);

  // Snap the relevant card into view on state transitions AND on previewResult
  // swaps (so the scroll re-fires when reviewing's contents change from the
  // "Planning…" spinner to the actual form / confirm card). `previewResult?.mode`
  // covers that swap without over-firing on per-keystroke edits.
  useEffect(() => {
    let target: HTMLDivElement | null = null;
    if (state.status === 'generating') target = generatingCardRef.current;
    else if (state.status === 'completed') target = completedCardRef.current;
    else if (state.status === 'reviewing') target = reviewingCardRef.current;
    if (!target) return;
    // rAF lets the new card actually mount before we measure / scroll.
    const id = requestAnimationFrame(() => {
      try {
        target!.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch {
        // older browsers — fall back to no-op
      }
    });
    return () => cancelAnimationFrame(id);
  }, [state.status, previewResult?.mode]);

  // ─── Run-cache helpers ─────────────────────────────────────────────────
  // Writes go through these so persistence stays in lockstep with React
  // state. They no-op when documentId/fieldName aren't both set (the
  // dialogStore primitives already guard, but skipping here also avoids
  // computing JSON we'll never write).
  const persistRun = useCallback(
    (run: RunCache | null) => {
      if (!documentId || !fieldName) return;
      patchDialogState(documentId, fieldName, { run });
      setCachedRunMode(run?.mode ?? null);
    },
    [documentId, fieldName],
  );
  const updateRunCache = useCallback(
    (updater: (prev: RunCache | null) => RunCache | null) => {
      if (!documentId || !fieldName) return;
      const prior = readDialogState(documentId, fieldName)?.run ?? null;
      const next = updater(prior);
      patchDialogState(documentId, fieldName, { run: next });
      setCachedRunMode(next?.mode ?? null);
    },
    [documentId, fieldName],
  );

  // ─── Preview-cache helpers ───────────────────────────────────────────────
  // The preview snapshot (`previewResult` + `editedInputs`) is persisted so
  // a user closing the dialog mid-form-fill can come back and pick up where
  // they left off. Persisted only while we're in the 'reviewing' state; gets
  // cleared the moment we transition to 'generating' / 'completed' / 'failed'
  // / 'idle' — those states are owned by the run cache, not preview.
  const persistPreview = useCallback(
    (preview: PreviewCache | null) => {
      if (!documentId || !fieldName) return;
      patchDialogState(documentId, fieldName, { preview });
    },
    [documentId, fieldName],
  );

  // Effect: keep preview cache in sync with in-memory previewResult + editedInputs.
  // Only writes when in 'reviewing' state with an app-mode preview that has a
  // non-empty form — otherwise there's nothing the user could have typed.
  // For modes without form fields (auto-dispatch path) we don't persist; the
  // run cache will pick up almost immediately.
  useEffect(() => {
    if (!documentId || !fieldName) return;
    const isAppPreviewWithForm =
      state.status === 'reviewing' &&
      previewResult?.mode === 'app' &&
      previewResult.form.length > 0;
    if (!isAppPreviewWithForm) return;
    persistPreview({
      cachedAt: Date.now(),
      previewResult: previewResult as unknown as Record<string, unknown>,
      editedInputs,
    });
  }, [documentId, fieldName, state.status, previewResult, editedInputs, persistPreview]);

  /**
   * User-initiated "start fresh" action: wipes both brief and run cache for
   * this (doc, field), aborts any in-flight polling, and resets local state.
   * The next dialog open will start as if it had never been opened before:
   *   - placeholder brief shown
   *   - AI brief refetched (no docHash to match against)
   *   - no previous outputs
   */
  const handleClearCachedState = useCallback(() => {
    abortRef.current?.abort();
    setState({ status: 'idle', runId: null, outputs: [], error: null, progress: null });
    setIsResumingFromCache(false);
    setNeedsInputCtx(null);
    setCollectedInputs({});
    setSelectedOutputIds(new Set());
    setTimeoutWarning(false);
    setEnhanceResult(null);
    setEnhanceLoading(false);
    setPreviewResult(null);
    setEditedInputs({});
    // Clear the app routing pin too — both React state and the per-
    // (docType, fieldName) localStorage entry — so the user starts cleanly.
    setSelectedAppId(null);
    setSelectedAppName(null);
    clearRoutedAppId(documentType, fieldName);
    if (timeoutWarningRef.current) {
      clearTimeout(timeoutWarningRef.current);
      timeoutWarningRef.current = null;
    }
    if (documentId && fieldName) {
      // clearDialogState wipes brief, run, AND preview from this (doc, field)
      // entry — single localStorage write, all three sub-caches gone.
      clearDialogState(documentId, fieldName);
      setCachedRunMode(null);
    }
    clearRecentBriefs(documentType, fieldName);
    setRecentBriefsVersion((v) => v + 1);
    // Snap the brief hook back to its placeholder + re-arm the AI mount
    // fetch so the user sees the field reset visually and a fresh AI brief
    // gets generated for the current doc state.
    resetBrief();
  }, [documentId, documentType, fieldName, resetBrief]);

  // ─── Resume cached run on mount ──────────────────────────────────────────
  // If `state` was hydrated from a cached run with status='generating', we
  // need to verify the run with the server (it may have completed while the
  // dialog was closed) and either:
  //   - settle the local state to the terminal server state, OR
  //   - resume polling via .wait() until terminal.
  //
  // This is the "idempotent resume" — never starts a new run, only re-attaches.
  // 404 / fetch error → fall back to a fresh-start state (cache was stale).
  const resumeFiredRef = useRef(false);
  useEffect(() => {
    if (resumeFiredRef.current) return;
    if (state.status !== 'generating' || !state.runId || !cachedRunMode) return;
    resumeFiredRef.current = true;

    const runId = state.runId;
    const mode = cachedRunMode;
    const abort = new AbortController();
    abortRef.current = abort;

    void (async () => {
      const poller = mode === 'freestyle' ? client.freestyle : client.runs;
      try {
        // First: cheap GET to see current server state. If terminal, we're done.
        const fresh = await poller.get(runId);
        if (abort.signal.aborted) return;
        // Resume verified — flip the muted "Checking previous run…" copy off.
        // From here on the spinner card uses normal generating UX.
        setIsResumingFromCache(false);

        if (fresh.data.status === 'completed' || fresh.data.status === 'failed') {
          const outputs = (fresh.data.outputs ?? [])
            .map(toGeneratedOutput)
            .filter((o): o is GeneratedOutput => o !== null);
          if (fresh.data.status === 'failed') {
            const errorMsg = failureMessageFromRun(fresh.data);
            setState({ status: 'failed', runId, outputs, error: errorMsg, progress: null });
            updateRunCache((prev) =>
              prev && prev.runId === runId
                ? { ...prev, status: 'failed', error: errorMsg, outputs, progress: null }
                : prev,
            );
          } else {
            setState({ status: 'completed', runId, outputs, error: null, progress: 100 });
            updateRunCache((prev) =>
              prev && prev.runId === runId
                ? { ...prev, status: 'completed', outputs, progress: 100, error: null }
                : prev,
            );
          }
          return;
        }

        // Still running on server — re-attach polling.
        // eslint-disable-next-line no-console
        console.log('[lamina/run] resuming polling for', runId, 'mode=', mode);
        const result = await poller.wait(runId, {
          intervalMs: 3000,
          timeoutMs: GENERATION_TIMEOUT_MS,
          onPoll(status) {
            if (abort.signal.aborted) return;
            const nextProgress = progressFromStatus(status);
            setState((prev) => ({
              ...prev,
              progress: monotonicProgress(prev.progress, nextProgress),
            }));
            updateRunCache((prev) =>
              prev && prev.runId === runId
                ? { ...prev, progress: monotonicProgress(prev.progress, nextProgress) }
                : prev,
            );
          },
        });
        if (abort.signal.aborted) return;

        if (result.data.status === 'failed') {
          const errorMsg = failureMessageFromRun(result.data);
          setState({ status: 'failed', runId, outputs: [], error: errorMsg, progress: null });
          updateRunCache((prev) =>
            prev && prev.runId === runId
              ? { ...prev, status: 'failed', error: errorMsg, progress: null }
              : prev,
          );
          return;
        }
        const outputs = result.data.outputs
          .map(toGeneratedOutput)
          .filter((o): o is GeneratedOutput => o !== null);
        setState({ status: 'completed', runId, outputs, error: null, progress: 100 });
        updateRunCache((prev) =>
          prev && prev.runId === runId
            ? { ...prev, status: 'completed', outputs, progress: 100, error: null }
            : prev,
        );
      } catch (err) {
        if (abort.signal.aborted) return;
        // eslint-disable-next-line no-console
        console.warn('[lamina/run] resume failed; falling back to fresh start', err);
        // Cache was stale (run deleted, server restarted, etc.). Reset to
        // idle and clear the cache entry — the user can hit Generate again.
        setState({ status: 'idle', runId: null, outputs: [], error: null, progress: null });
        setIsResumingFromCache(false);
        if (documentId && fieldName) clearDialogState(documentId, fieldName);
      }
    })();

    return () => {
      abort.abort();
    };
    // Run-once on mount. We deliberately don't depend on state.* here — the
    // `resumeFiredRef` guard makes this fire-once semantics; further state
    // changes are handled by the effect's own polling, not by re-firing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- Load brand profiles and campaigns on mount --
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [profilesRes, campaignsRes] = await Promise.allSettled([
          client.request<{ data: BrandProfileEntry[] }>('/v1/brand-profiles'),
          client.request<{ data: CampaignEntry[] }>('/v1/campaigns'),
        ]);
        if (cancelled) return;
        if (profilesRes.status === 'fulfilled') {
          setBrandProfiles(profilesRes.value.data ?? []);
        }
        if (campaignsRes.status === 'fulfilled') {
          setCampaigns(campaignsRes.value.data ?? []);
        }
      } catch {
        // Brand profiles / campaigns not available — hide the fields
      } finally {
        if (!cancelled) setBrandsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [client]);

  // -- App picker handlers --

  const handleToggleAppPicker = useCallback(async () => {
    setAppPicker((prev) => {
      if (prev.expanded) return { ...prev, expanded: false };
      // If already loaded, just expand
      if (prev.apps.length > 0) return { ...prev, expanded: true };
      // Will load below
      return { ...prev, expanded: true, loading: true };
    });

    // Load on first expand
    if (!appPicker.expanded && appPicker.apps.length === 0) {
      try {
        const result = await client.apps.list();
        const apps: AppEntry[] = (result.data ?? []).map((a) => ({
          appId: a.appId,
          name: a.name,
          description: a.description,
          capabilities: a.capabilities,
          icon: a.icon ?? null,
          modality: a.modality ?? null,
          // SDK 0.2.0 returns inputSummary as a structured object {required, optional, total}.
          // Plugin renders this as a one-line muted hint, so collapse to a count string.
          inputSummary: a.inputSummary ? `${a.inputSummary.total} input${a.inputSummary.total === 1 ? '' : 's'}` : null,
          // Server now returns thumbnail (extracted from settings.emptyStateMedia)
          // — surfaces in the picker grid as a 16:9 card preview.
          thumbnail: (a as { thumbnail?: { url: string; type: 'image' | 'video' } | null }).thumbnail ?? null,
        }));
        setAppPicker((prev) => ({ ...prev, loading: false, apps, mode: 'list', error: null }));
      } catch (err) {
        setAppPicker((prev) => ({
          ...prev,
          loading: false,
          error: describeError(err),
        }));
      }
    }
  }, [client, appPicker.expanded, appPicker.apps.length]);

  /**
   * Picker search-as-you-type handler. Driven by the AppPickerPanel's debounced
   * search input (500ms idle).
   *
   *   - Empty query → re-load apps.list() (cached on first expand) so user sees
   *     the full catalog again. We still hit list() to refresh in case server-side
   *     workspace apps changed; the call is fast and idempotent.
   *   - Non-empty query → fire apps.discover(query) for ranked, thumbnail-rich
   *     results scored by the new searchApps() service.
   *
   * Replaces the previous "Find best app" button (which used the dialog's brief
   * as the search intent — confusing because there was no place to type a
   * separate picker query).
   */
  const handlePickerSearch = useCallback(
    async (query: string) => {
      setAppPicker((prev) => ({ ...prev, loading: true, error: null }));
      try {
        if (!query) {
          // Empty query → load all apps (list mode).
          const result = await client.apps.list();
          const apps: AppEntry[] = (result.data ?? []).map((a) => ({
            appId: a.appId,
            name: a.name,
            description: a.description,
            capabilities: a.capabilities,
            icon: a.icon ?? null,
            modality: a.modality ?? null,
            inputSummary: a.inputSummary
              ? `${a.inputSummary.total} input${a.inputSummary.total === 1 ? '' : 's'}`
              : null,
            thumbnail: (a as { thumbnail?: { url: string; type: 'image' | 'video' } | null }).thumbnail ?? null,
          }));
          setAppPicker((prev) => ({ ...prev, loading: false, apps, mode: 'list', error: null }));
          return;
        }

        // Non-empty query → ranked search via discover() (server-side searchApps).
        const result = await client.apps.discover({ intent: query });
        const matches = result.data?.matches ?? [];
        const apps: AppEntry[] = matches.map((a) => ({
          appId: a.appId,
          name: a.name,
          description: a.description,
          capabilities: a.capabilities,
          icon: null,
          modality: null,
          inputSummary: null,
          thumbnail: (a as { thumbnail?: { url: string; type: 'image' | 'video' } | null }).thumbnail ?? null,
        }));
        setAppPicker((prev) => ({ ...prev, loading: false, apps, mode: 'discover', error: null }));
      } catch (err) {
        setAppPicker((prev) => ({ ...prev, loading: false, error: describeError(err) }));
      }
    },
    [client],
  );

  // manageUrl from the cost estimate response
  const [creditsManageUrl, setCreditsManageUrl] = useState<string | null>(null);

  const fetchEstimate = useCallback(async (appId: string) => {
    setEstimateLoading(true);
    try {
      const result = await client.apps.estimate(appId);
      setCostEstimate(result.data);
      const enriched = result.data as CostEstimateWithManageUrl;
      setCreditsManageUrl(enriched.credits?.manageUrl ?? null);
    } catch {
      setCostEstimate(null);
      setCreditsManageUrl(null);
    } finally {
      setEstimateLoading(false);
    }
  }, [client]);

  const handleSelectApp = useCallback((app: AppEntry) => {
    const deselecting = selectedAppId === app.appId;
    setSelectedAppId(deselecting ? null : app.appId);
    setSelectedAppName(deselecting ? null : app.name);
    if (deselecting) {
      setCostEstimate(null);
    } else {
      fetchEstimate(app.appId);
    }
  }, [selectedAppId, fetchEstimate]);

  const handleClearAppSelection = useCallback(() => {
    setSelectedAppId(null);
    setSelectedAppName(null);
    setCostEstimate(null);
    // Also unpin from localStorage so it doesn't restore on next dialog open.
    clearRoutedAppId(documentType, fieldName);
  }, [documentType, fieldName]);

  // -- needsInput handler --

  const handleInputChange = useCallback((name: string, value: unknown) => {
    setCollectedInputs((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handleContinueWithInputs = useCallback(async () => {
    if (!needsInputCtx) return;

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setState((prev) => ({
      ...prev,
      status: 'generating',
      error: null,
      progress: 0,
    }));

    try {
      const appId = needsInputCtx.appId || selectedAppId;
      if (!appId) {
        setState((prev) => ({
          ...prev,
          status: 'failed',
          error: 'No app selected for input submission.',
        }));
        return;
      }

      // Silent enrichment — same document context as handleGenerate
      const metadata: Record<string, string> = {
        ...(documentType ? { documentType } : {}),
        ...(documentTitle ? { documentTitle } : {}),
        ...(fieldName ? { fieldName } : {}),
        ...(fieldDescription ? { fieldPurpose: fieldDescription } : {}),
      };

      const runResult = await client.runs.run(appId, {
        inputs: collectedInputs,
        ...(options.webhookUrl ? { webhook: options.webhookUrl } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
      if (abort.signal.aborted) return;

      const runId = runResult.data.runId;
      setState((prev) => ({ ...prev, runId }));
      setNeedsInputCtx(null);

      const result = await client.runs.wait(runId, {
        intervalMs: 3000,
        timeoutMs: GENERATION_TIMEOUT_MS,
        onPoll(status) {
          if (abort.signal.aborted) return;
          setState((prev) => ({
            ...prev,
            progress: monotonicProgress(prev.progress, progressFromStatus(status)),
          }));
        },
      });

      if (abort.signal.aborted) return;

      if (result.data.status === 'failed') {
        const errorMsg = failureMessageFromRun(result.data);
        setState((prev) => ({
          ...prev,
          status: 'failed',
          error: errorMsg,
          progress: null,
        }));
        return;
      }

      const outputs = result.data.outputs
        .map(toGeneratedOutput)
        .filter((o): o is GeneratedOutput => o !== null);

      setState({
        status: 'completed',
        runId,
        outputs,
        error: null,
        progress: 100,
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      const isTimeout =
        err instanceof Error && err.message.toLowerCase().includes('timed out');
      setState((prev) => ({
        ...prev,
        status: 'failed',
        error: isTimeout
          ? 'Generation timed out after 30 minutes. Please try again with a simpler brief.'
          : describeError(err),
        progress: null,
      }));
    }
  }, [needsInputCtx, selectedAppId, collectedInputs, options.webhookUrl, client, documentType, documentTitle, fieldName, fieldDescription]);

  // -- Main generate handler --
  //
  // STEP 1 (preview): user clicks Generate → call POST /v1/content/preview-run.
  // Server runs the agent in PREVIEW MODE — drafts the plan WITHOUT dispatching.
  // Returns one of:
  //   - mode='app'          → render decision card (chosen app, drafted+missing inputs)
  //   - mode='freestyle'    → render freestyle decision card (variants + prompts)
  //   - mode='needs_choice' → show multi-app picker (user picks → re-run preview pinned)
  //
  // STEP 2 (confirm): user reviews/edits in the decision card → clicks Confirm
  // → handleConfirmAndRun() calls POST /v1/content/run with merged inputs/recipe
  // → server dispatches → polling proceeds as before.

  const handleGenerate = useCallback(async () => {
    if (!brief.trim()) return;

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    // 'reviewing' state shows the "Planning…" spinner while preview-run runs.
    // After the response lands we either:
    //   - auto-dispatch (freestyle OR app with no missing inputs) → state → 'generating'
    //   - render the missing-inputs form (app + missing) → state stays 'reviewing'
    //   - render the multi-app picker (needs_choice) → state stays 'reviewing'
    setState({
      status: 'reviewing',
      runId: null,
      outputs: [],
      error: null,
      progress: null,
    });
    setNeedsInputCtx(null);
    setCollectedInputs({});
    setPreviewResult(null);
    setEditedInputs({});
    setTimeoutWarning(false);
    if (timeoutWarningRef.current) clearTimeout(timeoutWarningRef.current);

    try {
      const resolvedModality =
        modality || (assetType === 'file' ? 'video' : 'image');

      const previewResp = await client.content.previewRun({
        brief: brief.trim(),
        document: fullDocument ?? {},
        ...(fieldName ? { fieldName } : {}),
        ...(fieldDescription ? { fieldDescription } : {}),
        constraints: {
          modality: resolvedModality as 'image' | 'video' | 'audio' | 'text',
          ...(effectiveAspectRatio ? { aspectRatio: effectiveAspectRatio } : {}),
        },
        ...(selectedAppId ? { appId: selectedAppId } : {}),
        numVariants,
      });

      if (abort.signal.aborted) return;
      const data = previewResp.data;

      // ── Freestyle path: explicit confirmation before dispatch ─────────────
      // Freestyle means no catalog app's purpose matched the brief — the agent
      // Freestyle path. Same branching as app: if the agent asked the user for
      // inputs (most commonly: reference image for ref-aware models like
      // nano-banana-pro-edit whose paramSchema declares imageUrls), show the
      // form. Otherwise auto-dispatch.
      if (data.mode === 'freestyle') {
        const form = (data as { form?: unknown[] }).form ?? [];
        if (form.length > 0) {
          const initial: Record<string, unknown> = {};
          for (const f of form as Array<{ name: string }>) {
            initial[f.name] = '';
          }
          setPreviewResult(data);
          setEditedInputs(initial);
          return;
        }
        setPreviewResult(data);
        await dispatchPreview(data, {});
        return;
      }

      // ── App auto-dispatch path: agent has everything, no form needed ──────
      // Stash the preview BEFORE dispatching so the generating spinner can
      // surface "Using <App Name>" inline (visibility into agent's choice).
      if (data.mode === 'app' && data.form.length === 0) {
        const inputs: Record<string, unknown> = {};
        for (const [name, drafted] of Object.entries(data.draftedInputs)) {
          inputs[name] = drafted.value;
        }
        setPreviewResult(data);
        await dispatchPreview(data, inputs);
        return;
      }

      // ── Form path: app with form fields ───────────────────────────────────
      // Render MissingInputsForm. Pre-fill drafted values so the user only
      // touches the form fields, plus seed each form field with its
      // suggestedDefault (one-tap accept via the chip in the form). For
      // multi-select fields (output selection) initialize as an empty array
      // so the checkbox group starts unchecked.
      if (data.mode === 'app') {
        const initial: Record<string, unknown> = {};
        for (const [name, drafted] of Object.entries(data.draftedInputs)) {
          initial[name] = drafted.value;
        }
        for (const f of data.form) {
          if (f.kind === 'multiSelect') {
            initial[f.name] = [];
          } else if (f.suggestedDefault) {
            initial[f.name] = f.suggestedDefault.value;
          }
        }
        setPreviewResult(data);
        setEditedInputs(initial);
        return;
      }

      // ── Agent-failed path: validator exhausted retries ────────────────────
      // Agent picked an app but couldn't describe its missing inputs as a
      // valid form even after retries. Show the failure card so the user can
      // pick an app manually or retry with a clearer brief.
      if (data.mode === 'agent_failed') {
        setPreviewResult(data);
        return;
      }

      // No other modes exist — the agent always picks one app or goes freestyle.
      // Treat any unexpected mode defensively as a failure rather than a render gap.
      setState((prev) => ({
        ...prev,
        status: 'failed',
        error: 'Unexpected response from the planner. Please try again.',
        progress: null,
      }));
    } catch (err) {
      if (abort.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        status: 'failed',
        error: describeError(err),
        progress: null,
      }));
    }
    // Note: dispatchPreview is intentionally NOT in the deps — it's stable as
    // it has no closure dependencies of its own and is wrapped in useCallback
    // below. This keeps handleGenerate stable across re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    brief,
    modality,
    assetType,
    fullDocument,
    fieldName,
    fieldDescription,
    effectiveAspectRatio,
    selectedAppId,
    numVariants,
    client,
  ]);

  /**
   * Dispatch a preview-run result via /v1/content/run, then poll for outputs.
   *
   * Called from THREE places:
   *   1. handleGenerate auto-dispatch (freestyle mode) — passed an empty inputs map
   *   2. handleGenerate auto-dispatch (app mode, no missing) — passed agent's drafted values
   *   3. The MissingInputsForm's "Generate" button (via handleConfirmAndRun) —
   *      passed editedInputs from form state
   *
   * Takes the data directly (rather than reading from React state) so it can be
   * called immediately after a setState without waiting for a re-render.
   */
  const dispatchPreview = useCallback(
    async (preview: PreviewRunResult, inputs: Record<string, unknown>) => {
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;

      setState({
        status: 'generating',
        runId: null,
        outputs: [],
        error: null,
        progress: 0,
      });
      setTimeoutWarning(false);
      if (timeoutWarningRef.current) clearTimeout(timeoutWarningRef.current);
      timeoutWarningRef.current = setTimeout(() => setTimeoutWarning(true), TIMEOUT_WARNING_MS);

      try {
        // Build the run payload based on which mode the preview returned.
        let runParams: RunConfirmedParams;
        if (preview.mode === 'app') {
          // Output selection. Two sources, in priority order:
          //   1. User picks from the __outputs multi-select widget (if the
          //      agent asked) → the form value lives under "__outputs".
          //   2. Agent's confident pick from preview.selectedOutputs (no ask).
          //   3. Neither → omit, run all outputs (today's default).
          // The `__outputs` key never reaches `inputs` — it's an output
          // selection, not an app parameter.
          const OUTPUTS_KEY = '__outputs';
          const formOutputs = inputs[OUTPUTS_KEY];
          const outputsFromForm = Array.isArray(formOutputs)
            ? (formOutputs.filter((v) => typeof v === 'string') as string[])
            : undefined;
          const previewWithOutputs = preview as unknown as {
            selectedOutputs?: string[] | null;
          };
          const agentSelected = Array.isArray(previewWithOutputs.selectedOutputs)
            ? previewWithOutputs.selectedOutputs
            : undefined;
          const outputs =
            outputsFromForm && outputsFromForm.length > 0
              ? outputsFromForm
              : agentSelected && agentSelected.length > 0
                ? agentSelected
                : undefined;

          // Strip empty-string inputs before sending — empty means the user
          // either left it blank or clicked "Skip — use workflow default" on a
          // field that has a default. The server resolver falls back to the
          // workflow's saved defaultValue when an input is not supplied.
          // Also strip the reserved __outputs key (handled above).
          const inputsToSend: Record<string, unknown> = {};
          for (const [name, v] of Object.entries(inputs)) {
            if (name === OUTPUTS_KEY) continue;
            if (typeof v === 'string' && v.trim() === '') continue;
            if (v === null || v === undefined) continue;
            inputsToSend[name] = v;
          }
          runParams = {
            mode: 'app',
            appId: preview.selectedApp.appId,
            inputs: inputsToSend,
            rationale: preview.selectedApp.rationale,
            ...(options.webhookUrl ? { webhookUrl: options.webhookUrl } : {}),
            ...(outputs ? { outputs } : {}),
          };
        } else if (preview.mode === 'freestyle') {
          // Patch user-supplied form values into each variant's imageParams /
          // videoParams. This is what makes ref-aware freestyle work: the agent
          // emits variants with placeholder fields (e.g., imageUrls: []) AND
          // adds the same field name to ask_user_for; the user uploads via the
          // form; here we merge the upload URL back into the recipe before
          // dispatch.
          const previewWithForm = preview as unknown as {
            form?: Array<{ name: string; kind?: string }>;
          };
          const askedNames = (previewWithForm.form || []).map((f) => f.name);
          const patchedVariants = preview.freestylePlan.variants.map((v: Record<string, unknown>) => {
            const imageParams: Record<string, unknown> = {
              ...((v.imageParams as Record<string, unknown>) || {}),
            };
            const hasVideoParams = v.videoParams && typeof v.videoParams === 'object';
            const videoParams: Record<string, unknown> | null = hasVideoParams
              ? { ...(v.videoParams as Record<string, unknown>) }
              : null;

            for (const askName of askedNames) {
              const value = inputs[askName];
              if (value === undefined || value === null || value === '') continue;
              // imageUrls is an array param — wrap a single string URL.
              const wrap = (val: unknown) =>
                askName === 'imageUrls' && typeof val === 'string' ? [val] : val;
              if (askName in imageParams) {
                imageParams[askName] = wrap(value);
              } else if (videoParams && askName in videoParams) {
                videoParams[askName] = wrap(value);
              } else {
                // Param wasn't in either params object — default to imageParams
                // (most freestyle asks today are image references).
                imageParams[askName] = wrap(value);
              }
            }

            return {
              ...v,
              imageParams,
              ...(videoParams ? { videoParams } : {}),
            };
          });

          runParams = {
            mode: 'freestyle',
            freestyleRecipe: {
              modality: preview.freestylePlan.modality,
              rationale: preview.freestylePlan.rationale,
              variants: patchedVariants,
            },
            intent: brief.trim(),
            numVariants,
            ...(fieldName ? { metadata: { fieldName } } : {}),
          };
        } else {
          // needs_choice — should not reach dispatchPreview; user must pick a
          // candidate first which re-fires handleGenerate with pinnedAppId.
          setState((prev) => ({
            ...prev,
            status: 'failed',
            error: 'Pick a specific app first to continue.',
            progress: null,
          }));
          return;
        }

        const runResp = await client.content.run(runParams);
        if (abort.signal.aborted) return;
        const data = runResp.data;

        const runId = data.runId;
        setState((prev) => ({ ...prev, runId }));

        const mode: CachedRunMode = data.mode === 'freestyle' ? 'freestyle' : 'app';
        persistRun({
          runId,
          mode,
          status: 'generating',
          outputs: [],
          progress: 0,
          error: null,
          startedAt: Date.now(),
          brief: brief.trim(),
          ...(preview.mode === 'app' ? { appId: preview.selectedApp.appId } : {}),
          numVariants,
        });
        // Run is committed — drop the form-fill snapshot. From here on the
        // run cache is the source of truth for restoring on reopen.
        persistPreview(null);

        // Branch on `mode === 'freestyle'` — server returns this when it dispatched
        // parallel FAL calls with no app match. Same response shape, different URL.
        const poller = mode === 'freestyle' ? client.freestyle : client.runs;
        const result = await poller.wait(runId, {
          intervalMs: 3000,
          timeoutMs: GENERATION_TIMEOUT_MS,
          onPoll(status) {
            if (abort.signal.aborted) return;
            const nextProgress = progressFromStatus(status);
            setState((prev) => ({
              ...prev,
              progress: monotonicProgress(prev.progress, nextProgress),
            }));
            // Mirror progress to the run cache so a reopen mid-generation
            // shows accurate progress immediately (before the next poll lands).
            updateRunCache((prev) =>
              prev && prev.runId === runId
                ? { ...prev, progress: monotonicProgress(prev.progress, nextProgress) }
                : prev,
            );
          },
        });

        if (abort.signal.aborted) return;

        if (result.data.status === 'failed') {
          const errorMsg = failureMessageFromRun(result.data);
          setState((prev) => ({
            ...prev,
            status: 'failed',
            error: errorMsg,
            progress: null,
          }));
          updateRunCache((prev) =>
            prev && prev.runId === runId
              ? { ...prev, status: 'failed', error: errorMsg, progress: null }
              : prev,
          );
          return;
        }

        const outputs = result.data.outputs
          .map(toGeneratedOutput)
          .filter((o): o is GeneratedOutput => o !== null);

        setState({
          status: 'completed',
          runId,
          outputs,
          error: null,
          progress: 100,
        });
        updateRunCache((prev) =>
          prev && prev.runId === runId
            ? { ...prev, status: 'completed', outputs, progress: 100, error: null }
            : prev,
        );

        // Save app routing and brief to recent history
        if (outputs.length > 0) {
          if (selectedAppId) {
            saveRoutedAppId(documentType, fieldName, selectedAppId);
          }
          saveRecentBrief(documentType, fieldName, brief, selectedAppId ?? undefined);
          setRecentBriefsVersion((v) => v + 1);
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        const isTimeout =
          err instanceof Error && err.message.toLowerCase().includes('timed out');
        const errorMsg = isTimeout
          ? 'Generation timed out after 30 minutes. Please try again with a simpler brief.'
          : describeError(err);
        setState((prev) => ({
          ...prev,
          status: 'failed',
          error: errorMsg,
          progress: null,
        }));
        // We don't always have a stable `runId` at this point (the throw could
        // have happened before content.run returned). updateRunCache only
        // patches when the cached run matches, so this is safe either way.
        updateRunCache((prev) =>
          prev ? { ...prev, status: 'failed', error: errorMsg, progress: null } : prev,
        );
      }
    },
    [
      brief,
      selectedAppId,
      options.webhookUrl,
      client,
      fieldName,
      numVariants,
      persistRun,
      persistPreview,
      updateRunCache,
      documentType,
    ],
  );

  /**
   * Thin wrapper called by MissingInputsForm's "Generate" button.
   * Reads the current preview + edited inputs from React state and delegates to
   * dispatchPreview. The auto-dispatch paths in handleGenerate call dispatchPreview
   * directly with fresh values (avoiding setState timing issues).
   */
  const handleConfirmAndRun = useCallback(() => {
    if (!previewResult) return;
    void dispatchPreview(previewResult, editedInputs);
  }, [previewResult, editedInputs, dispatchPreview]);

  // Proxy a CDN URL through transferAsset to avoid CORS issues
  const resolveAssetUrl = useCallback(
    async (output: GeneratedOutput): Promise<string> => {
      try {
        const mediaType =
          output.type === 'video' ? 'video' : output.type === 'image' ? 'image' : 'image';
        const result = await client.publishing.transferAsset({
          sourceUrl: output.url,
          mediaType: mediaType as 'image' | 'video' | 'audio',
          filename: `lamina-${state.runId ?? 'gen'}-${output.id}`,
        });
        return result.data.cdnUrl;
      } catch {
        // Fall back to direct URL if transferAsset fails
        return output.url;
      }
    },
    [client, state.runId],
  );

  const buildAsset = useCallback(
    (output: GeneratedOutput, resolvedUrl: string): AssetFromSource => ({
      kind: 'url',
      value: resolvedUrl,
      assetDocumentProps: {
        originalFilename: `lamina-${state.runId ?? 'gen'}-${output.id}.${
          output.mimeType?.split('/')[1] || 'png'
        }`,
        source: {
          name: 'lamina',
          id: state.runId ?? output.id,
          url: `https://app.uselamina.ai/runs/${state.runId ?? output.id}`,
          ...(documentId ? { documentId } : {}),
        },
        description: brief,
        creditLine: 'Generated by Lamina',
      } as AssetFromSource['assetDocumentProps'],
    }),
    [state.runId, brief, documentId],
  );

  const [selecting, setSelecting] = useState(false);
  const [selectingPhase, setSelectingPhase] = useState<'downloading' | 'uploading' | null>(null);

  // -- Quality feedback state (#33) --
  const [feedbackState, setFeedbackState] = useState<{
    runId: string;
    outputId: string;
    submitted: boolean;
  } | null>(null);
  const [pendingAssets, setPendingAssets] = useState<AssetFromSource[] | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finishAndClose = useCallback(() => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    if (pendingAssets) {
      onSelect(pendingAssets);
      // Asset has been consumed → drop the run cache so the next dialog
      // open for this field starts clean (no stale "previous run" results).
      // We deliberately keep the brief cache so the user's textarea text
      // and AI-brief docHash survive across asset insertions.
      if (documentId && fieldName) {
        patchDialogState(documentId, fieldName, { run: null });
      }
    }
    setPendingAssets(null);
    setFeedbackState(null);
    setState({ status: 'idle', runId: null, outputs: [], error: null, progress: null });
    setSelectedOutputIds(new Set());
    setCachedRunMode(null);
  }, [pendingAssets, onSelect, documentId, fieldName]);

  const submitFeedback = useCallback(
    async (rating: 'positive' | 'negative') => {
      if (!feedbackState) return;
      setFeedbackState((prev) => (prev ? { ...prev, submitted: true } : null));
      try {
        await client.request(`/v1/runs/${feedbackState.runId}/feedback`, {
          method: 'POST',
          body: {
            feedback:
              rating === 'positive'
                ? 'The output was good and matched the brief well.'
                : 'The output could be improved - it did not fully match the brief.',
          },
        });
      } catch {
        // Feedback is best-effort, don't block the user
      }
      finishAndClose();
    },
    [feedbackState, client, finishAndClose],
  );

  // Clean up any lingering timer on unmount (no auto-dismiss — user must
  // click a feedback button or "Skip" to proceed).
  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    };
  }, []);

  const handleSelectOutput = useCallback(
    async (output: GeneratedOutput) => {
      setSelecting(true);
      setSelectingPhase('downloading');
      try {
        const url = await resolveAssetUrl(output);
        setSelectingPhase('uploading');
        const assets = [buildAsset(output, url)];
        setPendingAssets(assets);
        setFeedbackState({
          runId: state.runId ?? output.id,
          outputId: output.id,
          submitted: false,
        });
      } finally {
        setSelecting(false);
        setSelectingPhase(null);
      }
    },
    [resolveAssetUrl, buildAsset, state.runId],
  );

  const handleToggleOutput = useCallback((outputId: string) => {
    setSelectedOutputIds((prev) => {
      const next = new Set(prev);
      if (next.has(outputId)) {
        next.delete(outputId);
      } else {
        next.add(outputId);
      }
      return next;
    });
  }, []);

  const handleUseSelected = useCallback(async () => {
    const selected = state.outputs.filter((o) => selectedOutputIds.has(o.id));
    if (selected.length === 0) return;
    setSelecting(true);
    setSelectingPhase('downloading');
    try {
      const resolved = await Promise.all(
        selected.map(async (o) => {
          const url = await resolveAssetUrl(o);
          return buildAsset(o, url);
        }),
      );
      setSelectingPhase('uploading');
      setPendingAssets(resolved);
      setFeedbackState({
        runId: state.runId ?? selected[0].id,
        outputId: selected[0].id,
        submitted: false,
      });
    } finally {
      setSelecting(false);
      setSelectingPhase(null);
    }
  }, [state.outputs, state.runId, selectedOutputIds, resolveAssetUrl, buildAsset]);

  const handleReset = useCallback(() => {
    abortRef.current?.abort();
    setState({
      status: 'idle',
      runId: null,
      outputs: [],
      error: null,
      progress: null,
    });
    setNeedsInputCtx(null);
    setCollectedInputs({});
    setSelectedOutputIds(new Set());
    setTimeoutWarning(false);
    setEnhanceResult(null);
    setEnhanceLoading(false);
    setPreviewResult(null);
    setEditedInputs({});
    if (timeoutWarningRef.current) {
      clearTimeout(timeoutWarningRef.current);
      timeoutWarningRef.current = null;
    }
    // User canceled / dismissed an in-progress or failed run — clear both the
    // run cache AND any in-flight preview snapshot. Brief cache is kept so
    // their textarea text persists.
    if (documentId && fieldName) {
      patchDialogState(documentId, fieldName, { run: null, preview: null });
      setCachedRunMode(null);
    }
  }, [documentId, fieldName]);

  // Sanity types selectionType as 'single' but future versions may support 'multiple'
  const isMultiple = (selectionType as string) === 'multiple';
  const isIdle = state.status === 'idle' || state.status === 'failed';
  const generationError =
    state.status === 'failed' && state.error ? classifyRunFailure(state.error) : null;
  const generationErrorMessage =
    generationError?.kind === 'needs_choice'
      ? generationError.reason
      : generationError?.kind === 'insufficient_credits'
        ? 'Your workspace does not have enough credits for this generation.'
        : generationError?.message;

  // Keyboard shortcuts (#60): Cmd/Ctrl+Enter to generate, Escape to cancel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (isIdle && brief.trim()) {
          handleGenerate();
        }
      }
      if (e.key === 'Escape' && state.status === 'generating') {
        e.preventDefault();
        e.stopPropagation();
        handleReset();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isIdle, brief, state.status, handleGenerate, handleReset]);

  return (
    <Dialog
      id="lamina-generate"
      header="Generate with Lamina"
      onClose={onClose}
      width={2}
      open
    >
      <Box padding={3} paddingBottom={0}>
        <TabList space={1}>
          <Tab
            id="lamina-dialog-generate"
            label="Generate"
            aria-controls="lamina-dialog-panel-generate"
            selected={dialogTab === 'generate'}
            onClick={() => setDialogTab('generate')}
            fontSize={1}
            padding={2}
          />
          <Tab
            id="lamina-dialog-library"
            label="From library"
            aria-controls="lamina-dialog-panel-library"
            selected={dialogTab === 'library'}
            onClick={() => setDialogTab('library')}
            fontSize={1}
            padding={2}
          />
        </TabList>
      </Box>

      {/* Library tab */}
      <TabPanel
        id="lamina-dialog-panel-library"
        aria-labelledby="lamina-dialog-library"
        hidden={dialogTab !== 'library'}
      >
        <Box padding={4}>
          <Stack space={3}>
            <Flex align="center" gap={2}>
              <Box style={{ flex: 1 }}>
                <TextInput
                  icon={SearchIcon}
                  value={librarySearch}
                  onChange={(e) => setLibrarySearch(e.currentTarget.value)}
                  placeholder="Search by filename..."
                  fontSize={1}
                />
              </Box>
              <Select
                value={libraryFilter}
                onChange={(e) => setLibraryFilter(e.currentTarget.value as AssetTypeFilter)}
                fontSize={1}
                style={{ width: 130 }}
              >
                <option value="all">All types</option>
                <option value="images">Images</option>
                <option value="videos">Videos</option>
              </Select>
            </Flex>
            {documentId ? (
              <Flex align="center" gap={2}>
                <Checkbox
                  id="lamina-doc-filter"
                  checked={libraryDocFilter}
                  onChange={(e) => setLibraryDocFilter(e.currentTarget.checked)}
                />
                <Label htmlFor="lamina-doc-filter" size={1} muted>
                  For this document
                </Label>
              </Flex>
            ) : null}
            <Text size={0} muted>{libraryAssets.totalLabel}</Text>
            <Box style={{ maxHeight: 400, overflowY: 'auto' }}>
              <AssetPickerGrid
                assets={libraryAssets.assets}
                loading={libraryAssets.loading}
                loadingMore={libraryAssets.loadingMore}
                hasMore={libraryAssets.hasMore}
                columns={2}
                onSelect={handleSelectFromLibrary}
                onLoadMore={libraryAssets.loadMore}
                emptyMessage="No Lamina assets yet. Generate some first!"
              />
            </Box>
          </Stack>
        </Box>
      </TabPanel>

      {/* Generate tab */}
      <TabPanel
        id="lamina-dialog-panel-generate"
        aria-labelledby="lamina-dialog-generate"
        hidden={dialogTab !== 'generate'}
      >
      <Box padding={4}>
        <Stack space={4}>
          {/* Brief input */}
          <Stack space={2}>
            <Flex align="center" justify="space-between" gap={2}>
              <Label size={1}>Describe what you need</Label>
              {hasCachedState ? (
                <ClearWithConfirmButton onClear={handleClearCachedState} />
              ) : null}
            </Flex>
            <TextArea
              value={brief}
              onChange={(e) => setBrief(e.currentTarget.value)}
              placeholder="Product photo of white sneakers on marble surface, lifestyle aesthetic"
              rows={3}
              disabled={state.status === 'generating'}
            />

            {/* AI brief loading — fires on popup open, before user has typed */}
            {briefStatus === 'ai-loading' ? (
              <Flex align="center" gap={2}>
                <Spinner />
                <Text size={0} muted>Generating AI brief from document context…</Text>
              </Flex>
            ) : null}

            {/* Typeahead chips — appear after the user actively edits the brief */}
            {brief && isIdle && typeaheadChips.length > 0 ? (
              <Stack space={1}>
                <Flex align="center" gap={2}>
                  <Text size={0} muted weight="medium">Suggestions</Text>
                  {typeaheadLoading ? <Spinner /> : null}
                </Flex>
                <Inline space={1}>
                  {typeaheadChips.map((c) => (
                    <Button
                      key={c.title}
                      text={c.prompt.length > 50 ? `${c.prompt.substring(0, 50)}...` : c.prompt}
                      title={`${c.title}: ${c.rationale}`}
                      mode="ghost"
                      fontSize={0}
                      padding={2}
                      tone="primary"
                      onClick={() => applyChip(c.prompt)}
                    />
                  ))}
                </Inline>
              </Stack>
            ) : brief && isIdle && typeaheadLoading ? (
              <Flex align="center" gap={2}>
                <Spinner />
                <Text size={0} muted>Finding suggestions…</Text>
              </Flex>
            ) : null}

            {/* "Suggested from document context" caption — appears once a
                system-set value is actually sitting in the textarea. Hidden
                while the AI brief is still loading (the "Generating AI brief…"
                row above carries that signal); showing both at once made the
                two captions stack and contradict each other. */}
            {briefPreFilled && briefStatus !== 'ai-loading' ? (
              <Text size={0} muted>
                Suggested from document context
              </Text>
            ) : null}
            {/* Enhance brief toggle (#66) */}
            {isIdle ? (
              <Flex align="center" gap={2}>
                <Checkbox
                  id="lamina-enhance-brief"
                  checked={enhanceEnabled}
                  onChange={(e) => setEnhanceEnabled(e.currentTarget.checked)}
                />
                <Label htmlFor="lamina-enhance-brief" size={0} muted>
                  Enhance brief before generating
                </Label>
                <BoltIcon style={{ opacity: enhanceEnabled ? 1 : 0.3 }} />
              </Flex>
            ) : null}
            {/* Show enhanced brief preview after generation starts */}
            {enhanceResult && state.status !== 'idle' ? (
              <Card padding={2} radius={2} tone="positive" border>
                <Stack space={1}>
                  <Text size={0} weight="medium">Enhanced: {enhanceResult.title}</Text>
                  <Text size={0} muted>{enhanceResult.enhanced}</Text>
                  <Text size={0} muted style={{ fontStyle: 'italic' }}>{enhanceResult.rationale}</Text>
                </Stack>
              </Card>
            ) : null}
            {enhanceLoading ? (
              <Flex align="center" gap={2}>
                <Spinner />
                <Text size={0} muted>Enhancing your brief...</Text>
              </Flex>
            ) : null}
          </Stack>

          {/* Modality selector */}
          <Stack space={2}>
            <Label size={1}>Output type</Label>
            <Select
              value={modality}
              onChange={(e) => setModality(e.currentTarget.value)}
              disabled={state.status === 'generating'}
            >
              {MODALITIES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Stack>

          {/* Active preset indicator */}
          {activePresetName ? (
            <Card padding={2} radius={2} tone="positive" border>
              <Text size={1} muted>
                Preset: <strong>{activePresetName}</strong>
                {activePreset?.aspectRatio ? ` (${activePreset.aspectRatio})` : ''}
              </Text>
            </Card>
          ) : null}

          {/* Aspect ratio */}
          <Stack space={2}>
            <Label size={1}>Aspect ratio</Label>
            <Select
              value={aspectRatioOverride}
              onChange={(e) =>
                setAspectRatioOverride(e.currentTarget.value as LaminaAspectRatio | '')
              }
              disabled={state.status === 'generating'}
            >
              {ASPECT_RATIO_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            {!aspectRatioOverride && detectedRatio ? (
              <Text size={0} muted>
                Detected: {detectedRatio.label}
              </Text>
            ) : null}
          </Stack>

          {/* Number of variants — used by the freestyle (no app match) path */}
          <Stack space={2}>
            <Label size={1}>Variants</Label>
            <Select
              value={String(numVariants)}
              onChange={(e) => setNumVariants(Number(e.currentTarget.value))}
              disabled={state.status === 'generating'}
            >
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
            </Select>
            <Text size={0} muted>
              How many alternative outputs to generate.
            </Text>
          </Stack>

          {/* Brand profile selector */}
          {brandsLoaded && brandProfiles.length > 0 ? (
            <Stack space={2}>
              <Label size={1}>Brand profile</Label>
              <Select
                value={selectedBrandId}
                onChange={(e) => setSelectedBrandId(e.currentTarget.value)}
                disabled={state.status === 'generating'}
              >
                <option value="">None</option>
                {brandProfiles.map((bp) => (
                  <option key={bp.id} value={bp.id}>
                    {bp.name}
                  </option>
                ))}
              </Select>
            </Stack>
          ) : null}

          {/* Campaign selector */}
          {brandsLoaded && campaigns.length > 0 ? (
            <Stack space={2}>
              <Label size={1}>Campaign</Label>
              <Select
                value={selectedCampaignId}
                onChange={(e) => setSelectedCampaignId(e.currentTarget.value)}
                disabled={state.status === 'generating'}
              >
                <option value="">None</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Stack>
          ) : null}

          {/* App picker */}
          {isIdle ? (
            <Stack space={2}>
              {selectedAppId && !appPicker.expanded ? (
                <Card padding={2} radius={2} tone="primary" border>
                  <Flex align="center" justify="space-between">
                    <Text size={1} weight="medium">
                      App: {selectedAppName || selectedAppId}
                    </Text>
                    <Button
                      icon={CloseIcon}
                      mode="bleed"
                      fontSize={1}
                      padding={1}
                      onClick={handleClearAppSelection}
                    />
                  </Flex>
                </Card>
              ) : null}
              <Button
                text={appPicker.expanded ? 'Hide app picker' : 'Choose a specific app (optional)'}
                icon={appPicker.expanded ? ChevronUpIcon : ChevronDownIcon}
                mode="ghost"
                fontSize={1}
                onClick={handleToggleAppPicker}
              />
              {appPicker.expanded ? (
                <AppPickerPanel
                  apps={appPicker.apps.map((a) => ({
                    appId: a.appId,
                    name: a.name,
                    description: a.description,
                    modality: a.modality ?? null,
                    outputFormats: a.capabilities?.outputFormats || [],
                    thumbnail: a.thumbnail ?? null,
                  }))}
                  selectedAppId={selectedAppId}
                  mode={appPicker.mode}
                  loading={appPicker.loading}
                  error={appPicker.error}
                  targetModality={modality || (assetType === 'file' ? 'video' : 'image')}
                  onSelect={(picked) =>
                    handleSelectApp(
                      // The full AppEntry is in appPicker.apps; look it up by id.
                      appPicker.apps.find((a) => a.appId === picked.appId) ?? {
                        appId: picked.appId,
                        name: picked.name,
                        description: picked.description ?? null,
                        capabilities: null,
                        modality: picked.modality ?? null,
                        thumbnail: picked.thumbnail ?? null,
                      },
                    )
                  }
                  onSearchSubmit={handlePickerSearch}
                  onClearSelection={handleClearAppSelection}
                />
              ) : null}
            </Stack>
          ) : null}

          {/* Credit estimate */}
          {selectedAppId && (costEstimate || estimateLoading) ? (
            <Card padding={2} radius={2} border tone={costEstimate && !costEstimate.affordable ? 'caution' : 'default'}>
              {estimateLoading ? (
                <Flex align="center" gap={2}>
                  <Spinner />
                  <Text size={1} muted>Estimating cost...</Text>
                </Flex>
              ) : costEstimate ? (
                <Stack space={2}>
                  <Flex align="center" justify="space-between">
                    <Text size={1}>
                      Est. {costEstimate.estimatedCredits.expected} credits
                    </Text>
                    <Text size={1} muted>
                      Balance: {costEstimate.currentBalance}
                    </Text>
                  </Flex>
                  {!costEstimate.affordable ? (
                    <Flex align="center" justify="space-between">
                      <Text size={1} weight="medium" style={{ color: 'var(--card-badge-caution-fg-color)' }}>
                        Insufficient credits for this generation
                      </Text>
                      <a
                        href={creditsManageUrl ?? 'https://app.uselamina.ai/pricing'}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ textDecoration: 'none' }}
                      >
                        <Button text="Add credits" mode="ghost" tone="primary" fontSize={0} padding={2} as="span" />
                      </a>
                    </Flex>
                  ) : null}
                </Stack>
              ) : null}
            </Card>
          ) : null}

          {/* Action buttons */}
          {isIdle ? (
            <Button
              text="Generate"
              tone="primary"
              onClick={handleGenerate}
              disabled={!brief.trim() || (costEstimate !== null && !costEstimate.affordable)}
            />
          ) : null}

          {/* Error */}
          {generationError ? (
            <Card
              padding={3}
              radius={2}
              tone={generationError.kind === 'insufficient_credits' ? 'caution' : 'critical'}
              border
            >
              <Stack space={3}>
                <Stack space={2}>
                  <Text size={1} weight="medium">
                    {generationError.kind === 'insufficient_credits'
                      ? 'Not enough credits'
                      : 'Generation failed'}
                  </Text>
                  <Text size={1}>
                    {generationErrorMessage}
                  </Text>
                </Stack>
                <Inline space={2}>
                  {generationError.kind === 'insufficient_credits' ? (
                    <a
                      href={generationError.topUpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ textDecoration: 'none' }}
                    >
                      <Button
                        text="Upgrade / add credits"
                        tone="primary"
                        as="span"
                        fontSize={1}
                        padding={2}
                      />
                    </a>
                  ) : null}
                  <Button
                    text={generationError.kind === 'insufficient_credits' ? 'Try again after upgrading' : 'Try again'}
                    icon={ResetIcon}
                    tone="default"
                    mode="ghost"
                    onClick={handleGenerate}
                    disabled={!brief.trim()}
                    fontSize={1}
                    padding={2}
                  />
                </Inline>
              </Stack>
            </Card>
          ) : null}

          {/*
           * Reviewing-state UI rules (after handleGenerate's preview-run lands):
           *   - mode='app' AND form non-empty   → MissingInputsForm
           *   - mode='needs_choice'             → DecisionCard (multi-app picker)
           *   - mode='agent_failed'             → AgentFailedCard
           *   - mode='app' AND form empty       → unreachable (auto-dispatched in handleGenerate)
           *   - mode='freestyle'                → unreachable (auto-dispatched in handleGenerate)
           */}
          {/* Reviewing state — single wrapper owns the scroll ref so it works
              uniformly across all four sub-states (loading, app+form,
              freestyle, agent_failed). The scroll effect re-fires when
              previewResult.mode changes, so the user is auto-scrolled to the
              form when it replaces the "Planning…" spinner. */}
          {state.status === 'reviewing' ? (
            <div ref={reviewingCardRef}>
              {!previewResult ? (
                <Card padding={4} radius={3} tone="default" border>
                  <Flex align="center" gap={3}>
                    <Spinner muted />
                    <Text size={1} muted>
                      Planning the best approach…
                    </Text>
                  </Flex>
                </Card>
              ) : previewResult.mode === 'app' && previewResult.form.length > 0 ? (
                <MissingInputsForm
                  appName={previewResult.selectedApp.name}
                  appRationale={previewResult.selectedApp.rationale || null}
                  form={previewResult.form}
                  warnings={previewResult.warnings}
                  values={editedInputs}
                  onChangeValue={(name, value) =>
                    setEditedInputs((prev) => ({ ...prev, [name]: value }))
                  }
                  onConfirm={handleConfirmAndRun}
                  onCancel={handleReset}
                />
              ) : previewResult.mode === 'freestyle' &&
                Array.isArray((previewResult as unknown as { form?: unknown }).form) &&
                ((previewResult as unknown as { form: unknown[] }).form.length > 0) ? (
                <MissingInputsForm
                  appName="Custom generation"
                  appRationale={previewResult.freestylePlan?.rationale || null}
                  form={(previewResult as unknown as { form: never[] }).form}
                  values={editedInputs}
                  onChangeValue={(name, value) =>
                    setEditedInputs((prev) => ({ ...prev, [name]: value }))
                  }
                  onConfirm={handleConfirmAndRun}
                  onCancel={handleReset}
                />
              ) : previewResult.mode === 'agent_failed' ? (
                <Card padding={4} radius={3} tone="critical" border>
                  <Stack space={3}>
                    <Text size={2} weight="semibold">
                      Couldn&apos;t draft a form for this
                    </Text>
                    <Text size={1} muted>
                      {previewResult.reason}
                    </Text>
                    {previewResult.selectedApp ? (
                      <Text size={1} muted>
                        The agent had picked: <strong>{previewResult.selectedApp.name}</strong>.
                        You can pick an app manually below or refine your brief and try again.
                      </Text>
                    ) : null}
                    {previewResult.errors.length > 0 ? (
                      <Card padding={2} radius={2} tone="caution">
                        <Stack space={1}>
                          <Text size={0} weight="medium">
                            Validator errors:
                          </Text>
                          {previewResult.errors.slice(0, 5).map((e, i) => (
                            <Text key={i} size={0} muted>
                              {e}
                            </Text>
                          ))}
                        </Stack>
                      </Card>
                    ) : null}
                    <Inline space={2}>
                      <Button text="Try again" tone="primary" onClick={handleGenerate} />
                      <Button text="Cancel" mode="ghost" onClick={handleReset} />
                    </Inline>
                  </Stack>
                </Card>
              ) : null}
            </div>
          ) : null}

          {/* Needs input (legacy auto-generate flow — kept for back-compat) */}
          {state.status === 'needs-input' && needsInputCtx ? (
            <Card padding={3} radius={2} tone="caution" border>
              <Stack space={3}>
                <Text size={1} weight="medium">
                  {needsInputCtx.message || 'Additional information needed'}
                </Text>
                {needsInputCtx.missing.map((param) => (
                  <ParameterField
                    key={param.name}
                    param={param}
                    value={collectedInputs[param.name]}
                    onChange={handleInputChange}
                    laminaClient={client}
                  />
                ))}
                <Inline space={2}>
                  <Button
                    text="Continue"
                    tone="primary"
                    onClick={handleContinueWithInputs}
                  />
                  <Button
                    text="Cancel"
                    mode="ghost"
                    onClick={handleReset}
                  />
                </Inline>
              </Stack>
            </Card>
          ) : null}

          {/* Progress */}
          {state.status === 'generating' ? (
            <div ref={generatingCardRef}>
            <Stack space={3}>
              {previewResult?.mode === 'app' && previewResult.warnings && previewResult.warnings.length > 0 ? (
                <Card padding={3} radius={2} tone="caution" border>
                  <Stack space={2}>
                    {previewResult.warnings.map((w, i) => (
                      <Text key={`warn-${i}`} size={1}>
                        {w.message}
                      </Text>
                    ))}
                  </Stack>
                </Card>
              ) : null}
            <Card padding={4} radius={3} tone="default" border>
              <Stack space={5}>
                {/* Inline visibility into the agent's choice — only meaningful
                    when previewResult is set (which it is for both
                    freestyle-confirm dispatches and app auto-dispatches). For
                    resumed-from-cache runs we don't have previewResult, so the
                    inline line just doesn't render. */}
                {!isResumingFromCache &&
                previewResult?.mode === 'app' &&
                previewResult.selectedApp ? (
                  <Stack space={3}>
                    <Text size={2} weight="semibold">
                      Using {previewResult.selectedApp.name}
                    </Text>
                    {previewResult.selectedApp.rationale ? (
                      <Text size={1} muted>
                        {previewResult.selectedApp.rationale}
                      </Text>
                    ) : null}
                  </Stack>
                ) : null}
                {!isResumingFromCache && previewResult?.mode === 'freestyle' ? (
                  <Text size={2} weight="semibold">
                    Composing your generation
                  </Text>
                ) : null}
                <Flex align="center" gap={3}>
                  <Spinner muted />
                  <Stack space={2}>
                    <Text size={1} weight="semibold">
                      {isResumingFromCache
                        ? 'Checking previous run…'
                        : state.progress !== null && state.progress < 20
                          ? 'Queued'
                          : state.progress !== null && state.progress >= 90
                            ? 'Finalizing'
                            : 'Generating'}
                    </Text>
                    {!isResumingFromCache &&
                    state.progress !== null &&
                    state.progress >= 20 ? (
                      <Text size={1} muted>
                        {state.progress}% complete
                      </Text>
                    ) : null}
                    {!isResumingFromCache &&
                    state.progress !== null &&
                    state.progress < 20 ? (
                      <Text size={1} muted>
                        Just a moment, starting up shortly…
                      </Text>
                    ) : null}
                    {isResumingFromCache ? (
                      <Text size={1} muted>
                        Reconnecting to your last generation
                      </Text>
                    ) : null}
                  </Stack>
                  <Box style={{ marginLeft: 'auto' }}>
                    <Button
                      text="Cancel"
                      mode="bleed"
                      tone="default"
                      fontSize={1}
                      padding={2}
                      onClick={handleReset}
                    />
                  </Box>
                </Flex>
                {/* Progress bar — only show when there's meaningful fill to draw.
                    At 0-5% the bar would render as essentially an empty track
                    line, which reads as visual noise rather than a progress
                    indicator. Below the threshold the spinner + "Queued" copy
                    carry the loading affordance. */}
                {state.progress !== null && state.progress >= 5 ? (
                  <Box
                    style={{
                      height: 4,
                      borderRadius: 2,
                      backgroundColor: 'var(--card-border-color)',
                      overflow: 'hidden',
                    }}
                  >
                    <Box
                      style={{
                        height: '100%',
                        width: `${state.progress}%`,
                        backgroundColor: 'var(--card-focus-ring-color)',
                        borderRadius: 2,
                        transition: 'width 0.5s ease',
                      }}
                    />
                  </Box>
                ) : null}
                {timeoutWarning ? (
                  <Card padding={2} radius={2} tone="caution">
                    <Text size={1}>
                      Generation is taking longer than expected. It will time out in about 5 minutes.
                    </Text>
                  </Card>
                ) : null}
              </Stack>
            </Card>
            </Stack>
            </div>
          ) : null}

          {/* Feedback prompt (#33) */}
          {feedbackState && !feedbackState.submitted ? (
            <Card padding={4} radius={3} tone="positive">
              <Stack space={3}>
                <Text size={1} weight="medium">Asset saved! How was the result?</Text>
                <Inline space={2}>
                  <Button text="Great" tone="positive" onClick={() => submitFeedback('positive')} />
                  <Button text="Could be better" mode="ghost" onClick={() => submitFeedback('negative')} />
                  <Button text="Skip" mode="bleed" fontSize={0} onClick={() => finishAndClose()} />
                </Inline>
              </Stack>
            </Card>
          ) : null}

          {/* Results with side-by-side refinement */}
          {state.status === 'completed' && state.outputs.length > 0 && !feedbackState ? (
            <div ref={completedCardRef}>
            <Stack space={3}>
              {/* Refinement panel: brief + regenerate side by side with results */}
              <Card padding={3} radius={2} border tone="transparent">
                <Stack space={2}>
                  <Label size={0}>Refine your brief and regenerate</Label>
                  <Flex gap={2} align="flex-end">
                    <Box style={{ flex: 1 }}>
                      <TextArea
                        value={brief}
                        onChange={(e) => setBrief(e.currentTarget.value)}
                        rows={2}
                        fontSize={1}
                      />
                    </Box>
                    <Button
                      text="Regenerate"
                      icon={ResetIcon}
                      tone="primary"
                      onClick={handleGenerate}
                      disabled={!brief.trim()}
                      fontSize={1}
                      padding={3}
                    />
                  </Flex>
                </Stack>
              </Card>

              <Label size={1}>Generated assets</Label>
              <Grid columns={state.outputs.length > 1 ? 2 : 1} gap={3}>
                {state.outputs.map((output) => (
                  <Card
                    key={output.id}
                    padding={2}
                    radius={2}
                    border
                    tone={isMultiple && selectedOutputIds.has(output.id) ? 'primary' : 'default'}
                    style={{ cursor: 'pointer' }}
                    onClick={isMultiple ? () => handleToggleOutput(output.id) : undefined}
                  >
                    <Stack space={2}>
                      {output.type === 'video' ? (
                        <video
                          src={output.url}
                          controls
                          style={{
                            width: '100%',
                            borderRadius: 4,
                            maxHeight: 240,
                            objectFit: 'contain',
                          }}
                        />
                      ) : (
                        <img
                          src={output.url}
                          alt={output.label}
                          style={{
                            width: '100%',
                            borderRadius: 4,
                            maxHeight: 240,
                            objectFit: 'contain',
                          }}
                        />
                      )}
                      <Text size={1} muted>
                        {output.label}
                      </Text>
                      {isMultiple ? (
                        <Text size={0} muted>
                          {selectedOutputIds.has(output.id) ? 'Selected' : 'Click to select'}
                        </Text>
                      ) : (
                        <Inline space={2}>
                          <Button
                            text={selecting ? (selectingPhase === 'uploading' ? 'Uploading...' : 'Downloading...') : 'Use this'}
                            tone="positive"
                            icon={CheckmarkCircleIcon}
                            onClick={() => handleSelectOutput(output)}
                            disabled={selecting}
                            fontSize={1}
                            padding={2}
                          />
                        </Inline>
                      )}
                    </Stack>
                  </Card>
                ))}
              </Grid>

              {/* Multi-select action */}
              {isMultiple && selectedOutputIds.size > 0 ? (
                <Button
                  text={selecting ? (selectingPhase === 'uploading' ? 'Uploading...' : 'Downloading...') : `Use ${selectedOutputIds.size} selected`}
                  tone="positive"
                  icon={CheckmarkCircleIcon}
                  onClick={handleUseSelected}
                  disabled={selecting}
                />
              ) : null}
            </Stack>
            </div>
          ) : null}
        </Stack>
      </Box>
      </TabPanel>
    </Dialog>
  );
}

// ─── Clear-with-confirm button ─────────────────────────────────────────────
//
// Two-click destructive action. Default state shows "Clear" (reset icon, bleed
// mode). First click puts the button into a 3-second confirm window where it
// changes copy + tone to make the destructive next-click obvious. If the user
// doesn't click again within 3 seconds, the button silently reverts to
// default. Second click within the window triggers `onClear` and resets state.
//
// Why inline: keeps the destructive UX scoped to the only place we use it
// without spinning up a separate file/module for a 30-line component.

const CLEAR_CONFIRM_WINDOW_MS = 3000;

function ClearWithConfirmButton({ onClear }: { onClear: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Always cancel any pending revert when we unmount, otherwise a setState on
  // an unmounted component can fire from the timer callback.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = useCallback(() => {
    if (confirming) {
      // Second click within the confirm window — actually clear.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setConfirming(false);
      onClear();
      return;
    }
    // First click — arm the confirm window.
    setConfirming(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setConfirming(false);
      timerRef.current = null;
    }, CLEAR_CONFIRM_WINDOW_MS);
  }, [confirming, onClear]);

  return (
    <Button
      text={confirming ? 'Click again to confirm' : 'Clear'}
      icon={ResetIcon}
      mode="bleed"
      tone={confirming ? 'caution' : 'default'}
      fontSize={0}
      padding={2}
      onClick={handleClick}
      title={
        confirming
          ? 'Click again within 3 seconds to clear all saved brief, results, and form state for this field.'
          : 'Clear saved brief, recent prompts, results, and form state for this field.'
      }
    />
  );
}
