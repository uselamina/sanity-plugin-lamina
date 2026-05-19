/**
 * "Generate all media" document action.
 *
 * Scans the document schema for empty image/file fields, builds contextual
 * briefs for each, runs parallel generations, and lets the editor review
 * and approve results per-field before patching the document.
 *
 * Closes #70.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RocketIcon, CheckmarkCircleIcon, CloseIcon, EditIcon, ResetIcon } from '@sanity/icons';
import { Box, Button, Card, Flex, Grid, Inline, Label, Spinner, Stack, Text, TextArea } from '@sanity/ui';
import type {
  DocumentActionComponent,
  DocumentActionProps,
  ObjectSchemaType,
  SchemaType,
  SanityDocument,
} from 'sanity';
import { useClient, useSchema } from 'sanity';
import { useLamina } from '../lib/LaminaContext.js';
import { buildSchemaAwarePrompt, getFieldMeta, extractSiblingContext } from '../lib/schemaContext.js';
import { enhanceBrief } from '../lib/briefEnhancer.js';
import { detectAspectRatio } from '../lib/aspectRatio.js';
import type { GeneratedOutput } from '../types.js';
import type { ExecutionOutput, LaminaCreateParams } from '@uselamina/sdk';

/** An image/file field discovered in the document schema. */
interface AssetField {
  name: string;
  /** Human-readable label. */
  label: string;
  /** 'image' or 'file'. */
  type: 'image' | 'file';
  /** Schema-level description. */
  description: string | null;
}

/** State for a single field's generation. */
interface FieldGenState {
  field: AssetField;
  brief: string;
  status: 'pending' | 'generating' | 'completed' | 'failed' | 'approved' | 'rejected';
  outputs: GeneratedOutput[];
  selectedOutputIndex: number;
  error: string | null;
}

/**
 * Recursively collects all top-level image/file fields from a schema type.
 */
function collectAssetFields(schemaType: SchemaType | undefined): AssetField[] {
  if (!schemaType) return [];
  const fields: AssetField[] = [];

  if ('fields' in schemaType && Array.isArray((schemaType as ObjectSchemaType).fields)) {
    for (const field of (schemaType as ObjectSchemaType).fields) {
      let current: SchemaType | undefined = field.type;
      while (current) {
        if (current.name === 'image' || current.name === 'file') {
          const label = field.type.title
            || field.name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
          const description = (field.type as unknown as Record<string, unknown>).description as string | null ?? null;
          fields.push({
            name: field.name,
            label,
            type: current.name as 'image' | 'file',
            description,
          });
          break;
        }
        current = current.type;
      }
    }
  }

  return fields;
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

/** Maximum concurrent generation requests. */
const CONCURRENCY = 3;

export function createGenerateAllAction(): DocumentActionComponent {
  const GenerateAllAction: DocumentActionComponent = (
    props: DocumentActionProps,
  ) => {
    const { id: documentId, type: documentType, published, draft } = props;
    const schema = useSchema();
    const sanityClient = useClient({ apiVersion: '2024-01-01' });
    const [showDialog, setShowDialog] = useState(false);

    let laminaCtx: ReturnType<typeof useLamina> | null = null;
    try {
      laminaCtx = useLamina();
    } catch {
      // useLamina throws if not inside LaminaProvider — this action is
      // registered globally but may render outside the provider context.
    }

    const schemaType = schema.get(documentType);
    const allFields = useMemo(() => collectAssetFields(schemaType), [schemaType]);
    const doc = (draft || published) as SanityDocument | null;
    const hasDocument = Boolean(doc);

    // Find which fields are empty (no asset reference)
    const emptyFields = useMemo(() => {
      if (!doc) return allFields;
      return allFields.filter((f) => {
        const value = (doc as Record<string, unknown>)[f.name] as Record<string, unknown> | undefined;
        if (!value) return true;
        // An image/file field with no asset reference has no _ref in .asset
        const asset = value.asset as Record<string, unknown> | undefined;
        return !asset?._ref;
      });
    }, [allFields, doc]);

    // Build initial briefs for each empty field
    const documentTitle = doc
      ? ((doc as Record<string, unknown>).title as string) ?? ((doc as Record<string, unknown>).name as string) ?? null
      : null;

    const [fieldStates, setFieldStates] = useState<FieldGenState[]>([]);
    const [phase, setPhase] = useState<'review' | 'generating' | 'results'>('review');
    const abortRef = useRef<AbortController | null>(null);

    // Initialize field states when dialog opens
    useEffect(() => {
      if (!showDialog) return;
      const states = emptyFields.map((field): FieldGenState => {
        const siblingValues = extractSiblingContext(schemaType, (name) => {
          if (!doc) return undefined;
          return (doc as Record<string, unknown>)[name];
        });
        const fieldMeta = getFieldMeta(schemaType, field.name);
        const prompt = buildSchemaAwarePrompt(fieldMeta, siblingValues, documentType, documentTitle ?? undefined);
        return {
          field,
          brief: prompt || `${field.label} for ${documentType}${documentTitle ? `: ${documentTitle}` : ''}`,
          status: 'pending',
          outputs: [],
          selectedOutputIndex: 0,
          error: null,
        };
      });
      setFieldStates(states);
      setPhase('review');
    }, [showDialog, emptyFields, schemaType, documentType, documentTitle, doc]);

    const handleBriefChange = useCallback((fieldName: string, newBrief: string) => {
      setFieldStates((prev) =>
        prev.map((s) => (s.field.name === fieldName ? { ...s, brief: newBrief } : s)),
      );
    }, []);

    const handleRemoveField = useCallback((fieldName: string) => {
      setFieldStates((prev) => prev.filter((s) => s.field.name !== fieldName));
    }, []);

    const handleGenerateAll = useCallback(async () => {
      if (!laminaCtx) return;
      const { client, options } = laminaCtx;

      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      setPhase('generating');

      const pending = [...fieldStates.filter((s) => s.status === 'pending')];
      const inFlight = new Set<string>();

      async function processField(fs: FieldGenState) {
        if (abort.signal.aborted) return;
        inFlight.add(fs.field.name);

        setFieldStates((prev) =>
          prev.map((s) => (s.field.name === fs.field.name ? { ...s, status: 'generating' } : s)),
        );

        try {
          // Enhance brief
          const enhanced = await enhanceBrief(client, fs.brief, {
            modality: fs.field.type === 'file' ? 'video' : 'image',
            documentType,
            documentTitle: documentTitle ?? undefined,
            fieldName: fs.field.name,
          });
          if (abort.signal.aborted) return;

          const detectedRatio = detectAspectRatio(fs.field.name);

          const createParams: LaminaCreateParams & { aspectRatio?: string; metadata?: Record<string, string> } = {
            brief: enhanced?.enhanced ?? fs.brief,
            modality: fs.field.type === 'file' ? 'video' : 'image',
            ...(detectedRatio ? { aspectRatio: detectedRatio.ratio } : {}),
            ...(options.webhookUrl ? { webhookUrl: options.webhookUrl } : {}),
            metadata: {
              documentType,
              ...(documentTitle ? { documentTitle } : {}),
              fieldName: fs.field.name,
              bulkGeneration: 'true',
            },
          };

          const createResult = await client.content.create(createParams);
          if (abort.signal.aborted) return;

          // SDK now returns a discriminated union — `needs_input` mode has no
          // runId (waits on caller to supply the missing inputs). Bulk
          // generation can't render a per-field form, so treat needs_input as
          // a soft failure that asks the user to add detail to the brief.
          const data = createResult.data as { runId?: string; status?: string };
          const runId = data.runId;
          if (!runId) {
            setFieldStates((prev) =>
              prev.map((s) =>
                s.field.name === fs.field.name
                  ? { ...s, status: 'failed', error: 'No run started. Try a more specific brief.' }
                  : s,
              ),
            );
            return;
          }

          const result = await client.runs.wait(runId, {
            intervalMs: 3000,
            timeoutMs: 10 * 60 * 1000, // 10 min per field in bulk
          });
          if (abort.signal.aborted) return;

          if (result.data.status === 'failed') {
            setFieldStates((prev) =>
              prev.map((s) =>
                s.field.name === fs.field.name
                  ? { ...s, status: 'failed', error: result.data.errorMessage || 'Generation failed.' }
                  : s,
              ),
            );
            return;
          }

          const outputs = result.data.outputs
            .map(toGeneratedOutput)
            .filter((o): o is GeneratedOutput => o !== null);

          setFieldStates((prev) =>
            prev.map((s) =>
              s.field.name === fs.field.name
                ? { ...s, status: 'completed', outputs, error: outputs.length === 0 ? 'No outputs' : null }
                : s,
            ),
          );
        } catch (err) {
          if (abort.signal.aborted) return;
          setFieldStates((prev) =>
            prev.map((s) =>
              s.field.name === fs.field.name
                ? { ...s, status: 'failed', error: err instanceof Error ? err.message : 'Unknown error' }
                : s,
            ),
          );
        } finally {
          inFlight.delete(fs.field.name);
        }
      }

      // Process with concurrency limit
      let idx = 0;
      async function runNext(): Promise<void> {
        while (idx < pending.length && !abort.signal.aborted) {
          if (inFlight.size >= CONCURRENCY) {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          const current = pending[idx++];
          processField(current);
        }
      }

      await runNext();
      // Wait for in-flight to finish
      while (inFlight.size > 0 && !abort.signal.aborted) {
        await new Promise((r) => setTimeout(r, 500));
      }

      if (!abort.signal.aborted) {
        setPhase('results');
      }
    }, [fieldStates, laminaCtx, documentType, documentTitle]);

    const handleApprove = useCallback((fieldName: string) => {
      setFieldStates((prev) =>
        prev.map((s) => (s.field.name === fieldName ? { ...s, status: 'approved' } : s)),
      );
    }, []);

    const handleReject = useCallback((fieldName: string) => {
      setFieldStates((prev) =>
        prev.map((s) => (s.field.name === fieldName ? { ...s, status: 'rejected' } : s)),
      );
    }, []);

    const handleSelectOutput = useCallback((fieldName: string, index: number) => {
      setFieldStates((prev) =>
        prev.map((s) => (s.field.name === fieldName ? { ...s, selectedOutputIndex: index } : s)),
      );
    }, []);

    const handleCommitApproved = useCallback(async () => {
      if (!laminaCtx) return;
      const { client } = laminaCtx;
      const approved = fieldStates.filter((s) => s.status === 'approved' && s.outputs.length > 0);
      if (approved.length === 0) return;

      for (const fs of approved) {
        const output = fs.outputs[fs.selectedOutputIndex] ?? fs.outputs[0];
        if (!output) continue;

        try {
          // Transfer asset to get a stable CDN URL
          const mediaType = output.type === 'video' ? 'video' : 'image';
          let cdnUrl = output.url;
          try {
            const transfer = await client.publishing.transferAsset({
              sourceUrl: output.url,
              mediaType: mediaType as 'image' | 'video',
              filename: `lamina-bulk-${fs.field.name}-${output.id}`,
            });
            cdnUrl = transfer.data.cdnUrl;
          } catch {
            // Fall back to direct URL
          }

          // Upload to Sanity
          const assetType = fs.field.type === 'file' ? 'file' : 'image';
          const response = await fetch(cdnUrl);
          const blob = await response.blob();
          const extension = output.mimeType?.split('/')[1] || 'png';
          const file = new File([blob], `lamina-${fs.field.name}.${extension}`, {
            type: output.mimeType || 'image/png',
          });

          const asset = await sanityClient.assets.upload(assetType, file, {
            filename: `lamina-${fs.field.name}.${extension}`,
            source: {
              name: 'lamina',
              id: output.id,
              url: output.url,
            },
            description: fs.brief,
            creditLine: 'Generated by Lamina',
          });

          // Patch the document field
          await sanityClient
            .patch(documentId)
            .set({
              [fs.field.name]: {
                _type: fs.field.type,
                asset: {
                  _type: 'reference',
                  _ref: asset._id,
                },
              },
            })
            .commit();
        } catch {
          // Best-effort — individual field failures don't block others
        }
      }

      setShowDialog(false);
    }, [fieldStates, laminaCtx, sanityClient, documentId]);

    const handleClick = useCallback(() => {
      setShowDialog(true);
    }, []);

    const handleClose = useCallback(() => {
      abortRef.current?.abort();
      setShowDialog(false);
    }, []);

    // Only show if the document type has 2+ image/file fields
    if (allFields.length < 2 || !hasDocument) return null;

    const approvedCount = fieldStates.filter((s) => s.status === 'approved').length;
    const completedCount = fieldStates.filter((s) => s.status === 'completed' || s.status === 'approved' || s.status === 'rejected').length;
    const totalCount = fieldStates.length;

    return {
      label: 'Generate all media',
      icon: RocketIcon,
      onHandle: handleClick,
      dialog: showDialog
        ? {
            type: 'dialog' as const,
            header: `Generate all media (${emptyFields.length} empty fields)`,
            onClose: handleClose,
            content: (
              <Box padding={4}>
                <Stack space={4}>
                  {/* Phase: Review briefs before generating */}
                  {phase === 'review' ? (
                    <>
                      <Text size={1} muted>
                        Review and edit the briefs for each empty media field, then generate all at once.
                      </Text>
                      {fieldStates.length === 0 ? (
                        <Card padding={3} radius={2} tone="positive">
                          <Flex align="center" gap={2}>
                            <CheckmarkCircleIcon />
                            <Text size={1}>All media fields are already filled.</Text>
                          </Flex>
                        </Card>
                      ) : (
                        <Stack space={3}>
                          {fieldStates.map((fs) => (
                            <Card key={fs.field.name} padding={3} radius={2} border>
                              <Stack space={2}>
                                <Flex align="center" justify="space-between">
                                  <Stack space={1}>
                                    <Text size={1} weight="medium">{fs.field.label}</Text>
                                    <Text size={0} muted>
                                      {fs.field.type === 'file' ? 'Video/file' : 'Image'} — {fs.field.name}
                                    </Text>
                                  </Stack>
                                  <Button
                                    icon={CloseIcon}
                                    mode="bleed"
                                    fontSize={0}
                                    padding={1}
                                    title="Remove from batch"
                                    onClick={() => handleRemoveField(fs.field.name)}
                                  />
                                </Flex>
                                <TextArea
                                  value={fs.brief}
                                  onChange={(e) => handleBriefChange(fs.field.name, e.currentTarget.value)}
                                  rows={2}
                                  fontSize={1}
                                />
                              </Stack>
                            </Card>
                          ))}
                          <Button
                            text={`Generate ${fieldStates.length} assets`}
                            icon={RocketIcon}
                            tone="primary"
                            onClick={handleGenerateAll}
                            disabled={fieldStates.length === 0 || !laminaCtx}
                          />
                        </Stack>
                      )}
                    </>
                  ) : null}

                  {/* Phase: Generating */}
                  {phase === 'generating' ? (
                    <>
                      <Flex align="center" gap={2}>
                        <Spinner />
                        <Text size={1}>Generating {totalCount} assets...</Text>
                      </Flex>
                      <Stack space={2}>
                        {fieldStates.map((fs) => (
                          <Card
                            key={fs.field.name}
                            padding={2}
                            radius={2}
                            border
                            tone={
                              fs.status === 'completed' ? 'positive'
                                : fs.status === 'failed' ? 'critical'
                                  : fs.status === 'generating' ? 'primary'
                                    : 'default'
                            }
                          >
                            <Flex align="center" gap={2}>
                              {fs.status === 'generating' ? <Spinner /> : null}
                              {fs.status === 'completed' ? <CheckmarkCircleIcon /> : null}
                              <Text size={1}>
                                {fs.field.label}
                                {fs.status === 'generating' ? ' — generating...' : ''}
                                {fs.status === 'completed' ? ` — ${fs.outputs.length} output(s)` : ''}
                                {fs.status === 'failed' ? ` — ${fs.error}` : ''}
                                {fs.status === 'pending' ? ' — queued' : ''}
                              </Text>
                            </Flex>
                          </Card>
                        ))}
                      </Stack>
                      <Button
                        text="Cancel"
                        mode="ghost"
                        onClick={() => {
                          abortRef.current?.abort();
                          setPhase('results');
                        }}
                      />
                    </>
                  ) : null}

                  {/* Phase: Results — approve/reject per field */}
                  {phase === 'results' ? (
                    <>
                      <Text size={1} muted>
                        Review the generated assets. Approve the ones you want to use.
                      </Text>
                      <Stack space={3}>
                        {fieldStates.map((fs) => (
                          <Card
                            key={fs.field.name}
                            padding={3}
                            radius={2}
                            border
                            tone={
                              fs.status === 'approved' ? 'positive'
                                : fs.status === 'rejected' ? 'critical'
                                  : fs.status === 'failed' ? 'critical'
                                    : 'default'
                            }
                          >
                            <Stack space={2}>
                              <Text size={1} weight="medium">{fs.field.label}</Text>
                              <Text size={0} muted>{fs.brief}</Text>

                              {fs.status === 'failed' ? (
                                <Text size={0} style={{ color: 'var(--card-badge-critical-fg-color)' }}>
                                  {fs.error}
                                </Text>
                              ) : null}

                              {(fs.status === 'completed' || fs.status === 'approved' || fs.status === 'rejected') && fs.outputs.length > 0 ? (
                                <>
                                  <Grid columns={Math.min(fs.outputs.length, 3)} gap={2}>
                                    {fs.outputs.map((output, idx) => (
                                      <Card
                                        key={output.id}
                                        padding={1}
                                        radius={2}
                                        border
                                        tone={fs.selectedOutputIndex === idx ? 'primary' : 'default'}
                                        style={{ cursor: 'pointer' }}
                                        onClick={() => handleSelectOutput(fs.field.name, idx)}
                                      >
                                        {output.type === 'video' ? (
                                          <video
                                            src={output.url}
                                            style={{ width: '100%', borderRadius: 4, maxHeight: 120, objectFit: 'contain' }}
                                          />
                                        ) : (
                                          <img
                                            src={output.url}
                                            alt={output.label}
                                            style={{ width: '100%', borderRadius: 4, maxHeight: 120, objectFit: 'contain' }}
                                          />
                                        )}
                                      </Card>
                                    ))}
                                  </Grid>
                                  {fs.status === 'completed' ? (
                                    <Inline space={2}>
                                      <Button
                                        text="Approve"
                                        icon={CheckmarkCircleIcon}
                                        tone="positive"
                                        fontSize={0}
                                        padding={2}
                                        onClick={() => handleApprove(fs.field.name)}
                                      />
                                      <Button
                                        text="Reject"
                                        icon={CloseIcon}
                                        mode="ghost"
                                        fontSize={0}
                                        padding={2}
                                        onClick={() => handleReject(fs.field.name)}
                                      />
                                    </Inline>
                                  ) : null}
                                  {fs.status === 'approved' ? (
                                    <Text size={0} style={{ color: 'var(--card-badge-positive-fg-color)' }}>Approved</Text>
                                  ) : null}
                                  {fs.status === 'rejected' ? (
                                    <Text size={0} muted>Rejected</Text>
                                  ) : null}
                                </>
                              ) : null}
                            </Stack>
                          </Card>
                        ))}
                      </Stack>

                      <Flex align="center" justify="space-between">
                        <Text size={1} muted>
                          {approvedCount} of {completedCount} approved
                        </Text>
                        <Inline space={2}>
                          <Button
                            text="Back to edit"
                            icon={EditIcon}
                            mode="ghost"
                            onClick={() => {
                              setFieldStates((prev) =>
                                prev.map((s) => ({ ...s, status: 'pending' as const, outputs: [], error: null })),
                              );
                              setPhase('review');
                            }}
                          />
                          <Button
                            text={`Save ${approvedCount} asset${approvedCount !== 1 ? 's' : ''} to document`}
                            icon={CheckmarkCircleIcon}
                            tone="positive"
                            onClick={handleCommitApproved}
                            disabled={approvedCount === 0}
                          />
                        </Inline>
                      </Flex>
                    </>
                  ) : null}
                </Stack>
              </Box>
            ),
          }
        : null,
    };
  };

  return GenerateAllAction;
}
