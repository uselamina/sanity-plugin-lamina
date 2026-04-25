import { useCallback, useRef, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Dialog,
  Flex,
  Grid,
  Inline,
  Label,
  Select,
  Spinner,
  Stack,
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
} from '@sanity/icons';
import type { AssetFromSource, AssetSourceComponentProps } from 'sanity';
import type {
  AppSummary as SdkAppSummary,
  ExecutionOutput,
  ExecutionStatus,
  LaminaCreateParams,
  MissingInput,
} from '@uselamina/sdk';
import { LaminaAuthError, LaminaRateLimitError } from '@uselamina/sdk';
import { useLamina } from '../lib/LaminaContext.js';
import type { GeneratedOutput, GenerationState } from '../types.js';

const MODALITIES = [
  { value: '', label: 'Auto-detect' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
] as const;

/** 30 minutes in milliseconds. */
const GENERATION_TIMEOUT_MS = 30 * 60 * 1000;

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

function ParameterField({
  param,
  value,
  onChange,
}: {
  param: MissingInput;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
}) {
  const label = param.description || param.name;

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

export function GenerateDialog(props: AssetSourceComponentProps) {
  const {
    assetType: rawAssetType,
    selectionType,
    onSelect,
    onClose,
  } = props;

  const assetType = rawAssetType === 'image' ? 'image' : 'file';
  const { client } = useLamina();
  const [brief, setBrief] = useState('');
  const [modality, setModality] = useState('');
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

  // App picker state
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [selectedAppName, setSelectedAppName] = useState<string | null>(null);
  const [appPicker, setAppPicker] = useState<AppPickerState>({
    expanded: false,
    loading: false,
    apps: [],
    error: null,
    mode: 'list',
  });

  const abortRef = useRef<AbortController | null>(null);

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

  const handleSelectApp = useCallback((app: AppEntry) => {
    setSelectedAppId((prev) => (prev === app.appId ? null : app.appId));
    setSelectedAppName((prev) => (prev === app.name ? null : app.name));
  }, []);

  const handleClearAppSelection = useCallback(() => {
    setSelectedAppId(null);
    setSelectedAppName(null);
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

      const runResult = await client.runs.run(appId, { inputs: collectedInputs });
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
  }, [needsInputCtx, selectedAppId, collectedInputs, client]);

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

      const createParams: LaminaCreateParams = {
        brief: brief.trim(),
        modality: resolvedModality,
        ...(selectedAppId ? { appId: selectedAppId } : {}),
      };

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
  }, [brief, modality, assetType, selectedAppId, client]);

  const handleSelectOutput = useCallback(
    (output: GeneratedOutput) => {
      const asset: AssetFromSource = {
        kind: 'url',
        value: output.url,
        assetDocumentProps: {
          originalFilename: `lamina-${state.runId ?? 'gen'}-${output.id}.${
            output.mimeType?.split('/')[1] || 'png'
          }`,
          source: {
            name: 'lamina',
            id: state.runId ?? output.id,
            url: `https://app.uselamina.ai/runs/${state.runId ?? output.id}`,
          },
          description: brief,
          creditLine: 'Generated by Lamina',
        } as AssetFromSource['assetDocumentProps'],
      };
      onSelect([asset]);
    },
    [state.runId, brief, onSelect],
  );

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
  }, []);

  const isIdle = state.status === 'idle' || state.status === 'failed';

  return (
    <Dialog
      id="lamina-generate"
      header="Generate with Lamina"
      onClose={onClose}
      width={2}
      open
    >
      <Box padding={4}>
        <Stack space={4}>
          {/* Brief input */}
          <Stack space={2}>
            <Label size={1}>Describe what you need</Label>
            <TextArea
              value={brief}
              onChange={(e) => setBrief(e.currentTarget.value)}
              placeholder="Product photo of white sneakers on marble surface, lifestyle aesthetic"
              rows={3}
              disabled={state.status === 'generating'}
            />
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

          {/* Action buttons */}
          {isIdle ? (
            <Button
              text="Generate"
              tone="primary"
              onClick={handleGenerate}
              disabled={!brief.trim()}
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

          {/* Results */}
          {state.status === 'completed' && state.outputs.length > 0 ? (
            <Stack space={3}>
              <Label size={1}>Generated assets</Label>
              <Grid columns={state.outputs.length > 1 ? 2 : 1} gap={3}>
                {state.outputs.map((output) => (
                  <Card
                    key={output.id}
                    padding={2}
                    radius={2}
                    border
                    style={{ cursor: 'pointer' }}
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
                      <Inline space={2}>
                        <Button
                          text="Use this"
                          tone="positive"
                          icon={CheckmarkCircleIcon}
                          onClick={() => handleSelectOutput(output)}
                          fontSize={1}
                          padding={2}
                        />
                      </Inline>
                    </Stack>
                  </Card>
                ))}
              </Grid>

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
    </Dialog>
  );
}
