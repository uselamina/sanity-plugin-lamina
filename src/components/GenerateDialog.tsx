import { useCallback, useEffect, useRef, useState } from 'react';
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
  CheckmarkCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  ResetIcon,
  SearchIcon,
  UploadIcon,
} from '@sanity/icons';
import type { AssetFromSource, AssetSourceComponentProps } from 'sanity';
import { useFormValue } from 'sanity';
import { useLaminaAssets } from '../lib/useLaminaAssets.js';
import { AssetPickerGrid } from './AssetPickerGrid.js';
import type { AssetTypeFilter, LaminaAsset, LaminaPreset } from '../types.js';
import type {
  AppSummary as SdkAppSummary,
  CostEstimate,
  ExecutionOutput,
  ExecutionStatus,
  LaminaCreateParams,
  MissingInput,
} from '@uselamina/sdk';
import { LaminaAuthError, LaminaRateLimitError } from '@uselamina/sdk';
import { useLamina } from '../lib/LaminaContext.js';
import { getRoutedAppId, saveRoutedAppId } from '../lib/appRouting.js';
import { getRecentBriefs, saveRecentBrief } from '../lib/recentBriefs.js';
import { detectAspectRatio, ASPECT_RATIO_OPTIONS } from '../lib/aspectRatio.js';
import type { LaminaAspectRatio } from '../lib/aspectRatio.js';
import type { GeneratedOutput, GenerationState } from '../types.js';

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

function progressFromStatus(status: ExecutionStatus): number | null {
  switch (status.status) {
    case 'queued':
      return 10;
    case 'running':
      return 50;
    case 'completed':
      return 100;
    case 'failed':
      return null;
    default:
      return null;
  }
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

// -- Document context for brief pre-filling --

interface DocumentContext {
  documentType?: string;
  documentTitle?: string;
  fieldName?: string;
  fieldDescription?: string;
}

const FIELD_LABELS: Record<string, string> = {
  heroImage: 'hero image',
  mainImage: 'main image',
  thumbnail: 'thumbnail',
  ogImage: 'social preview image',
  coverImage: 'cover image',
  poster: 'poster',
  avatar: 'avatar',
  logo: 'logo',
  icon: 'icon',
  banner: 'banner',
  background: 'background image',
};

const TYPE_LABELS: Record<string, string> = {
  product: 'product',
  post: 'blog post',
  blogPost: 'blog post',
  article: 'article',
  page: 'page',
  landingPage: 'landing page',
  category: 'category',
  author: 'author',
  event: 'event',
  project: 'project',
};

function buildSuggestedBrief(ctx: DocumentContext): string {
  const parts: string[] = [];

  const fieldLabel = ctx.fieldName ? FIELD_LABELS[ctx.fieldName] || ctx.fieldName.replace(/([A-Z])/g, ' $1').toLowerCase().trim() : null;
  const typeLabel = ctx.documentType ? TYPE_LABELS[ctx.documentType] || ctx.documentType.replace(/([A-Z])/g, ' $1').toLowerCase().trim() : null;

  if (fieldLabel) {
    parts.push(fieldLabel.charAt(0).toUpperCase() + fieldLabel.slice(1));
  }

  if (typeLabel && ctx.documentTitle) {
    parts.push(`for ${typeLabel}: ${ctx.documentTitle}`);
  } else if (ctx.documentTitle) {
    parts.push(`for ${ctx.documentTitle}`);
  } else if (typeLabel) {
    parts.push(`for ${typeLabel}`);
  }

  if (ctx.fieldDescription) {
    parts.push(`(${ctx.fieldDescription})`);
  }

  return parts.join(' ');
}

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

  // Derive field name from the parent path if available
  const parentSchemaType = (props as unknown as Record<string, unknown>).schemaType as
    | { name?: string; description?: string; parent?: { name?: string } }
    | undefined;
  const fieldName = parentSchemaType?.name;
  const fieldDescription = parentSchemaType?.description ?? undefined;

  const suggestedBrief = buildSuggestedBrief({
    documentType,
    documentTitle: documentTitle ?? undefined,
    fieldName,
    fieldDescription,
  });

  const suggestions = getSuggestions(documentType, assetType);
  const recentBriefs = getRecentBriefs(documentType, fieldName);

  // -- Preset resolution --
  const presetMatch = resolvePreset(fieldName, options.presets);
  const activePresetName = presetMatch?.[0] ?? null;
  const activePreset = presetMatch?.[1] ?? null;

  const [dialogTab, setDialogTab] = useState<'generate' | 'library'>('generate');
  const [brief, setBrief] = useState('');
  const [briefPreFilled, setBriefPreFilled] = useState(false);
  const [modality, setModality] = useState(activePreset?.modality ?? '');

  // -- Aspect ratio auto-detection --
  const detectedRatio = detectAspectRatio(fieldName);
  const [aspectRatioOverride, setAspectRatioOverride] = useState<LaminaAspectRatio | ''>('');
  const effectiveAspectRatio: LaminaAspectRatio | null =
    aspectRatioOverride || detectedRatio?.ratio || null;

  // Pre-fill brief on first render if we have context
  useEffect(() => {
    if (!briefPreFilled && suggestedBrief && !brief) {
      setBrief(suggestedBrief);
      setBriefPreFilled(true);
    }
  }, [suggestedBrief, briefPreFilled, brief]);
  const [state, setState] = useState<GenerationState>({
    status: 'idle',
    runId: null,
    outputs: [],
    error: null,
    progress: null,
  });

  // needsInput state
  const [needsInputCtx, setNeedsInputCtx] = useState<NeedsInputContext | null>(null);
  const [collectedInputs, setCollectedInputs] = useState<Record<string, unknown>>({});

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

  // Brand profile and campaign state
  const [brandProfiles, setBrandProfiles] = useState<BrandProfileEntry[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignEntry[]>([]);
  const [selectedBrandId, setSelectedBrandId] = useState<string>('');
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>('');
  const [brandsLoaded, setBrandsLoaded] = useState(false);

  // Batch generation state
  const [batchMode, setBatchMode] = useState(false);
  const [batchCount, setBatchCount] = useState(2);

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
  const libraryAssets = useLaminaAssets({
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

  const handleDiscoverApps = useCallback(async () => {
    if (!brief.trim()) return;
    setAppPicker((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const result = await client.apps.discover({ intent: brief.trim() });
      const matches = result.data?.matches ?? [];
      const apps: AppEntry[] = matches.map((a) => ({
        appId: a.appId,
        name: a.name,
        description: a.description,
        capabilities: a.capabilities,
      }));
      setAppPicker((prev) => ({ ...prev, loading: false, apps, mode: 'discover', error: null }));
    } catch (err) {
      setAppPicker((prev) => ({
        ...prev,
        loading: false,
        error: describeError(err),
      }));
    }
  }, [client, brief]);

  const fetchEstimate = useCallback(async (appId: string) => {
    setEstimateLoading(true);
    try {
      const result = await client.apps.estimate(appId);
      setCostEstimate(result.data);
    } catch {
      setCostEstimate(null);
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
  }, []);

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
      progress: 10,
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
            progress: progressFromStatus(status),
          }));
        },
      });

      if (abort.signal.aborted) return;

      if (result.data.status === 'failed') {
        setState((prev) => ({
          ...prev,
          status: 'failed',
          error: result.data.errorMessage || 'Generation failed.',
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

  const handleGenerate = useCallback(async () => {
    if (!brief.trim()) return;

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setState({
      status: 'generating',
      runId: null,
      outputs: [],
      error: null,
      progress: 10,
    });
    setNeedsInputCtx(null);
    setCollectedInputs({});

    try {
      const resolvedModality =
        modality || (assetType === 'file' ? 'video' : 'image');

      // Silent enrichment — context from the document, not visible in UI
      const metadata: Record<string, string> = {
        ...(documentType ? { documentType } : {}),
        ...(documentTitle ? { documentTitle } : {}),
        ...(fieldName ? { fieldName } : {}),
        ...(fieldDescription ? { fieldPurpose: fieldDescription } : {}),
      };

      const createParams: LaminaCreateParams & { aspectRatio?: string; metadata?: Record<string, string> } = {
        brief: brief.trim(),
        modality: resolvedModality,
        ...(activePreset?.aspectRatio ? { aspectRatio: activePreset.aspectRatio } : {}),
        ...(activePreset?.platform ? { platform: activePreset.platform } : {}),
        ...(selectedAppId ? { appId: selectedAppId } : {}),
        ...(selectedBrandId ? { brandProfileId: selectedBrandId } : {}),
        ...(selectedCampaignId ? { campaignId: selectedCampaignId } : {}),
        ...(options.webhookUrl ? { webhookUrl: options.webhookUrl } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(effectiveAspectRatio ? { aspectRatio: effectiveAspectRatio } : {}),
      };

      // Batch mode: run multiple content.create() calls in parallel for variants
      if (batchMode && batchCount > 1) {
        const createPromises = Array.from({ length: batchCount }, () =>
          client.content.create(createParams),
        );
        const createResults = await Promise.allSettled(createPromises);
        if (abort.signal.aborted) return;

        const runIds = createResults
          .filter(
            (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof client.content.create>>> =>
              r.status === 'fulfilled' && r.value.data.runId != null,
          )
          .map((r) => r.value.data.runId!);

        if (runIds.length === 0) {
          setState((prev) => ({
            ...prev,
            status: 'failed',
            error: 'All batch runs failed to start.',
            progress: null,
          }));
          return;
        }

        const allOutputs: GeneratedOutput[] = [];
        for (const runId of runIds) {
          const result = await client.runs.wait(runId, {
            intervalMs: 3000,
            timeoutMs: GENERATION_TIMEOUT_MS,
            onPoll(status) {
              if (abort.signal.aborted) return;
              setState((prev) => ({
                ...prev,
                progress: progressFromStatus(status),
              }));
            },
          });
          if (abort.signal.aborted) return;
          if (result.data.status === 'completed') {
            const outputs = result.data.outputs
              .map(toGeneratedOutput)
              .filter((o): o is GeneratedOutput => o !== null);
            allOutputs.push(...outputs);
          }
        }

        setState({
          status: 'completed',
          runId: runIds[0] ?? null,
          outputs: allOutputs,
          error: allOutputs.length === 0 ? 'All batch runs failed.' : null,
          progress: 100,
        });
        return;
      }

      const createResult = await client.content.create(createParams);

      if (abort.signal.aborted) return;

      const runId = createResult.data.runId;
      if (!runId) {
        const needsInput = createResult.data.needsInput;
        if (needsInput) {
          setNeedsInputCtx({
            message: needsInput.message,
            missing: needsInput.missing ?? [],
            appId: createResult.data.selectedApp?.appId,
            workflowId: createResult.data.workflowId,
          });
          setCollectedInputs({});
          setState((prev) => ({
            ...prev,
            status: 'needs-input',
            error: null,
            progress: null,
          }));
        } else {
          setState((prev) => ({
            ...prev,
            status: 'failed',
            error: 'No run was started. Try a more specific brief.',
          }));
        }
        return;
      }

      setState((prev) => ({ ...prev, runId }));

      const result = await client.runs.wait(runId, {
        intervalMs: 3000,
        timeoutMs: GENERATION_TIMEOUT_MS,
        onPoll(status) {
          if (abort.signal.aborted) return;
          setState((prev) => ({
            ...prev,
            progress: progressFromStatus(status),
          }));
        },
      });

      if (abort.signal.aborted) return;

      if (result.data.status === 'failed') {
        setState((prev) => ({
          ...prev,
          status: 'failed',
          error: result.data.errorMessage || 'Generation failed.',
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

      // Save app routing and brief to recent history
      if (outputs.length > 0) {
        if (selectedAppId) {
          saveRoutedAppId(documentType, fieldName, selectedAppId);
        }
        saveRecentBrief(documentType, fieldName, brief, selectedAppId ?? undefined);
      }
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
  }, [brief, modality, assetType, selectedAppId, selectedBrandId, selectedCampaignId, batchMode, batchCount, options.webhookUrl, effectiveAspectRatio, activePreset, client, documentType, documentTitle, fieldName, fieldDescription]);

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
    }
    setPendingAssets(null);
    setFeedbackState(null);
  }, [pendingAssets, onSelect]);

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

  // Start the auto-close timer whenever feedback UI appears
  useEffect(() => {
    if (feedbackState && !feedbackState.submitted) {
      feedbackTimerRef.current = setTimeout(() => {
        finishAndClose();
      }, 5000);
      return () => {
        if (feedbackTimerRef.current) {
          clearTimeout(feedbackTimerRef.current);
          feedbackTimerRef.current = null;
        }
      };
    }
    return undefined;
  }, [feedbackState, finishAndClose]);

  const handleSelectOutput = useCallback(
    async (output: GeneratedOutput) => {
      setSelecting(true);
      try {
        const url = await resolveAssetUrl(output);
        const assets = [buildAsset(output, url)];
        setPendingAssets(assets);
        setFeedbackState({
          runId: state.runId ?? output.id,
          outputId: output.id,
          submitted: false,
        });
      } finally {
        setSelecting(false);
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
    try {
      const resolved = await Promise.all(
        selected.map(async (o) => {
          const url = await resolveAssetUrl(o);
          return buildAsset(o, url);
        }),
      );
      setPendingAssets(resolved);
      setFeedbackState({
        runId: state.runId ?? selected[0].id,
        outputId: selected[0].id,
        submitted: false,
      });
    } finally {
      setSelecting(false);
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
  }, []);

  // Sanity types selectionType as 'single' but future versions may support 'multiple'
  const isMultiple = (selectionType as string) === 'multiple';
  const isIdle = state.status === 'idle' || state.status === 'failed';

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
            <Label size={1}>Describe what you need</Label>
            {!brief && isIdle && recentBriefs.length > 0 ? (
              <Stack space={1}>
                <Text size={0} muted weight="medium">Recently used</Text>
                <Inline space={1}>
                  {recentBriefs.map((r) => (
                    <Button
                      key={r.brief}
                      text={r.brief.length > 40 ? `${r.brief.substring(0, 40)}...` : r.brief}
                      mode="ghost"
                      fontSize={0}
                      padding={2}
                      tone="primary"
                      onClick={() => setBrief(r.brief)}
                    />
                  ))}
                </Inline>
              </Stack>
            ) : null}
            {!brief && isIdle ? (
              <Inline space={1}>
                {suggestions.map((s) => (
                  <Button
                    key={s}
                    text={s}
                    mode="ghost"
                    fontSize={0}
                    padding={2}
                    onClick={() => setBrief(s)}
                  />
                ))}
              </Inline>
            ) : null}
            <TextArea
              value={brief}
              onChange={(e) => {
                setBrief(e.currentTarget.value);
                if (briefPreFilled) setBriefPreFilled(false);
              }}
              placeholder="Product photo of white sneakers on marble surface, lifestyle aesthetic"
              rows={3}
              disabled={state.status === 'generating'}
            />
            {briefPreFilled && suggestedBrief ? (
              <Text size={0} muted>
                Suggested from document context
              </Text>
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

          {/* Batch mode toggle */}
          {isIdle ? (
            <Flex align="center" gap={3}>
              <Button
                text={batchMode ? 'Single output' : 'Generate variants'}
                mode="ghost"
                fontSize={1}
                onClick={() => setBatchMode((v) => !v)}
              />
              {batchMode ? (
                <Flex align="center" gap={2}>
                  <Label size={1}>Count:</Label>
                  <Select
                    value={String(batchCount)}
                    onChange={(e) => setBatchCount(Number(e.currentTarget.value))}
                    fontSize={1}
                    style={{ width: 60 }}
                  >
                    {[2, 3, 4, 5].map((n) => (
                      <option key={n} value={String(n)}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </Flex>
              ) : null}
            </Flex>
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
                <Card padding={3} radius={2} border>
                  <Stack space={3}>
                    <Flex align="center" justify="space-between">
                      <Text size={1} weight="medium">
                        {appPicker.mode === 'discover' ? 'Best matches for your brief' : 'Available apps'}
                      </Text>
                      <Button
                        text="Find best app"
                        icon={SearchIcon}
                        mode="ghost"
                        fontSize={1}
                        padding={2}
                        onClick={handleDiscoverApps}
                        disabled={!brief.trim() || appPicker.loading}
                      />
                    </Flex>
                    {appPicker.loading ? (
                      <Flex align="center" justify="center" padding={3}>
                        <Spinner />
                      </Flex>
                    ) : null}
                    {appPicker.error ? (
                      <Card padding={2} radius={2} tone="critical">
                        <Text size={1}>{appPicker.error}</Text>
                      </Card>
                    ) : null}
                    {!appPicker.loading && appPicker.apps.length > 0 ? (
                      <Box style={{ maxHeight: 240, overflowY: 'auto' }}>
                        <Stack space={2}>
                          {appPicker.apps.map((app) => (
                            <Card
                              key={app.appId}
                              padding={2}
                              radius={2}
                              border
                              tone={selectedAppId === app.appId ? 'primary' : 'default'}
                              style={{ cursor: 'pointer' }}
                              onClick={() => handleSelectApp(app)}
                            >
                              <Stack space={1}>
                                <Flex align="center" gap={2}>
                                  {selectedAppId === app.appId ? (
                                    <CheckmarkCircleIcon />
                                  ) : null}
                                  <Text size={1} weight="medium">
                                    {app.name}
                                  </Text>
                                </Flex>
                                {app.description ? (
                                  <Text size={1} muted>
                                    {app.description}
                                  </Text>
                                ) : null}
                                {app.capabilities?.produces?.length ? (
                                  <Inline space={1}>
                                    {app.capabilities.produces.slice(0, 3).map((cap) => (
                                      <Card key={cap} padding={1} radius={2} tone="transparent">
                                        <Text size={0} muted>{cap}</Text>
                                      </Card>
                                    ))}
                                  </Inline>
                                ) : null}
                              </Stack>
                            </Card>
                          ))}
                        </Stack>
                      </Box>
                    ) : null}
                    {!appPicker.loading && appPicker.apps.length === 0 && !appPicker.error ? (
                      <Text size={1} muted>No apps found.</Text>
                    ) : null}
                    {selectedAppId ? (
                      <Button
                        text="Clear selection"
                        mode="ghost"
                        fontSize={1}
                        onClick={handleClearAppSelection}
                      />
                    ) : null}
                  </Stack>
                </Card>
              ) : null}
            </Stack>
          ) : null}

          {/* Credit estimate */}
          {selectedAppId && (costEstimate || estimateLoading) ? (
            <Card padding={2} radius={2} border tone={costEstimate && !costEstimate.affordable ? 'critical' : 'default'}>
              {estimateLoading ? (
                <Flex align="center" gap={2}>
                  <Spinner />
                  <Text size={1} muted>Estimating cost...</Text>
                </Flex>
              ) : costEstimate ? (
                <Flex align="center" justify="space-between">
                  <Text size={1}>
                    Est. {costEstimate.estimatedCredits.expected} credits
                  </Text>
                  <Text size={1} muted>
                    Balance: {costEstimate.currentBalance}
                  </Text>
                  {!costEstimate.affordable ? (
                    <Text size={1} weight="medium">Insufficient balance</Text>
                  ) : null}
                </Flex>
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
          {state.status === 'failed' && state.error ? (
            <Card padding={3} radius={2} tone="critical">
              <Text size={1}>{state.error}</Text>
            </Card>
          ) : null}

          {/* Needs input */}
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
            <Card padding={4} radius={2} tone="primary">
              <Flex align="center" gap={3}>
                <Spinner />
                <Stack space={2}>
                  <Text size={1} weight="medium">
                    Generating...
                  </Text>
                  {state.progress !== null ? (
                    <Text size={1} muted>
                      {state.progress}% complete
                    </Text>
                  ) : null}
                </Stack>
              </Flex>
            </Card>
          ) : null}

          {/* Feedback prompt (#33) */}
          {feedbackState && !feedbackState.submitted ? (
            <Card padding={4} radius={2} tone="positive">
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

          {/* Results */}
          {state.status === 'completed' && state.outputs.length > 0 && !feedbackState ? (
            <Stack space={3}>
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
                            text={selecting ? 'Saving...' : 'Use this'}
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
                  text={selecting ? 'Saving...' : `Use ${selectedOutputIds.size} selected`}
                  tone="positive"
                  icon={CheckmarkCircleIcon}
                  onClick={handleUseSelected}
                  disabled={selecting}
                />
              ) : null}

              {/* Regenerate */}
              <Inline space={2}>
                <Button
                  text="Regenerate"
                  tone="default"
                  icon={ResetIcon}
                  mode="ghost"
                  onClick={handleReset}
                  fontSize={1}
                />
              </Inline>
            </Stack>
          ) : null}
        </Stack>
      </Box>
      </TabPanel>
    </Dialog>
  );
}
