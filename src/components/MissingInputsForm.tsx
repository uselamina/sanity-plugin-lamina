/**
 * MissingInputsForm
 *
 * Renders the agent-emitted form spec (FormField[]) for inputs the agent could
 * not draft. The agent decides per-field which widget the plugin should use:
 *
 *   - 'text'   → <TextInput>
 *   - 'select' → <Select>
 *   - 'image'  → URL paste + "Upload image" (Sanity asset upload)
 *   - 'video'  → URL paste + "Upload video"
 *   - 'audio'  → URL paste + "Upload audio"
 *
 * Media kinds support BOTH a URL paste (for external assets) AND a one-click
 * upload that pushes the chosen file to Sanity's asset CDN — the resulting
 * CDN URL is then used as the form field value. The workflow server fetches
 * that public URL during dispatch; no proxy needed for public datasets.
 *
 * The component is a pure renderer — no widget dispatching, no type collapse,
 * no fallbacks. All widget decisions were made upstream and validated server-side.
 */

import {
  Box,
  Button,
  Card,
  Flex,
  Inline,
  Label,
  Select,
  Spinner,
  Stack,
  Text,
  TextInput,
} from '@sanity/ui';
import { CheckmarkIcon, UploadIcon, WarningOutlineIcon } from '@sanity/icons';
import type { FormField, PreviewWarning } from '@uselamina/sdk';
import React, { useCallback, useRef, useState } from 'react';
import { useClient } from 'sanity';

interface MissingInputsFormProps {
  /** Display name of the chosen app (shown in the form header). */
  appName: string;
  /** Optional 1-line agent rationale for picking this app — shown muted under the header. */
  appRationale: string | null;
  /** Agent-emitted form spec — one entry per input the agent couldn't draft. */
  form: FormField[];
  /**
   * Optional warnings the agent raised about user dialog settings the chosen
   * app cannot honor (e.g., aspect ratio when the app's output shape is fixed).
   * Rendered above the form as muted info notes.
   */
  warnings?: PreviewWarning[];
  /** Current values keyed by field name (parent owns the state). */
  values: Record<string, unknown>;
  /** Called as the user edits a field. */
  onChangeValue: (name: string, value: unknown) => void;
  /** Called when the user clicks Generate. Parent dispatches the run. */
  onConfirm: () => void;
  /** Called when the user cancels the form. */
  onCancel: () => void;
}

export function MissingInputsForm({
  appName,
  appRationale,
  form,
  warnings,
  values,
  onChangeValue,
  onConfirm,
  onCancel,
}: MissingInputsFormProps) {
  // Every form field is here because the workflow CANNOT run without it
  // (parameter has no default, agent couldn't infer). Generate is enabled
  // only when every field has a non-empty value.
  const allFilled = form.every((field) => {
    const v = values[field.name];
    if (v == null) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    return true;
  });

  return (
    <Card padding={4} radius={3} tone="default" border>
      <Stack space={4}>
        <Stack space={2}>
          <Text size={2} weight="semibold">
            A few more details
          </Text>
          {appRationale ? (
            <Text size={1} muted>
              {appRationale}
            </Text>
          ) : (
            <Text size={1} muted>
              {appName} needs a couple of things only you can provide.
            </Text>
          )}
        </Stack>

        <WarningsList warnings={warnings} />

        <Stack space={4}>
          {form.map((field) => (
            <FieldRow
              key={field.name}
              field={field}
              value={values[field.name]}
              onChange={(v) => onChangeValue(field.name, v)}
            />
          ))}
        </Stack>

        <Inline space={2}>
          <Button text="Generate" tone="primary" onClick={onConfirm} disabled={!allFilled} />
          <Button text="Cancel" mode="bleed" onClick={onCancel} />
        </Inline>
      </Stack>
    </Card>
  );
}

// ─── Warnings list (muted info notes above the form) ───────────────────────

function WarningsList({ warnings }: { warnings?: PreviewWarning[] }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <Card padding={3} radius={2} tone="caution" border>
      <Stack space={2}>
        {warnings.map((w, i) => (
          <Flex key={`${w.field}-${i}`} align="flex-start" gap={2}>
            <Box style={{ flexShrink: 0, paddingTop: 2 }}>
              <WarningOutlineIcon />
            </Box>
            <Text size={1}>{w.message}</Text>
          </Flex>
        ))}
      </Stack>
    </Card>
  );
}

// ─── One row per form field — pure switch on field.kind ─────────────────────

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const stringValue = toStringInputValue(value);
  const hasSuggested = !!field.suggestedDefault;
  const isAcceptingSuggested =
    hasSuggested && stringValue === String(field.suggestedDefault!.value);
  const isMedia = field.kind === 'image' || field.kind === 'video' || field.kind === 'audio';

  return (
    <Stack space={2}>
      <Flex align="center" gap={2}>
        <Box style={{ flex: 1 }}>
          <Label size={1} muted style={{ fontWeight: 500 }}>
            {field.question}
          </Label>
        </Box>
        {isMedia ? (
          <Text size={0} muted style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {field.kind}
          </Text>
        ) : null}
      </Flex>

      {field.kind === 'select' ? (
        <Select value={stringValue} onChange={(e) => onChange(e.currentTarget.value)}>
          <option value="">— pick one —</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      ) : (
        <TextInput
          value={stringValue}
          onChange={(e) => onChange(e.currentTarget.value)}
          placeholder={placeholderFor(field)}
        />
      )}

      {/* Action row: upload (media kinds only) + suggested-default chip */}
      {isMedia || hasSuggested ? (
        <Inline space={2}>
          {isMedia ? <UploadButton kind={field.kind} onUploaded={onChange} /> : null}
          {hasSuggested ? (
            <Button
              mode="bleed"
              tone={isAcceptingSuggested ? 'positive' : 'default'}
              fontSize={1}
              padding={2}
              text={
                isAcceptingSuggested
                  ? `Using ${field.suggestedDefault!.label}`
                  : `Use ${field.suggestedDefault!.label}`
              }
              icon={isAcceptingSuggested ? CheckmarkIcon : undefined}
              onClick={() => onChange(field.suggestedDefault!.value)}
            />
          ) : null}
        </Inline>
      ) : null}
    </Stack>
  );
}

// ─── Sanity asset upload button (image/video/audio kinds) ──────────────────

const ACCEPT_BY_KIND: Record<'image' | 'video' | 'audio', string> = {
  image: 'image/*',
  video: 'video/*',
  audio: 'audio/*',
};

const SANITY_ASSET_TYPE_BY_KIND: Record<'image' | 'video' | 'audio', 'image' | 'file'> = {
  image: 'image',
  video: 'file', // Sanity stores video as a file asset
  audio: 'file',
};

function UploadButton({
  kind,
  onUploaded,
}: {
  kind: 'image' | 'video' | 'audio';
  onUploaded: (url: string) => void;
}) {
  const sanityClient = useClient({ apiVersion: '2024-01-01' });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePick = useCallback(() => {
    setError(null);
    inputRef.current?.click();
  }, []);

  const handleFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset the input so picking the same file twice in a row still fires onChange.
      e.target.value = '';
      if (!file) return;
      setUploading(true);
      setError(null);
      try {
        const assetType = SANITY_ASSET_TYPE_BY_KIND[kind];
        const asset = await sanityClient.assets.upload(assetType, file, {
          filename: file.name,
        });
        if (asset?.url) {
          onUploaded(asset.url);
        } else {
          setError('Upload succeeded but no URL was returned.');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed.';
        setError(message);
      } finally {
        setUploading(false);
      }
    },
    [kind, onUploaded, sanityClient],
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_BY_KIND[kind]}
        style={{ display: 'none' }}
        onChange={handleFile}
      />
      <Stack space={1}>
        <Button
          mode="bleed"
          fontSize={1}
          padding={2}
          icon={uploading ? undefined : UploadIcon}
          text={uploading ? 'Uploading…' : `Upload ${kind}`}
          onClick={handlePick}
          disabled={uploading}
        />
        {uploading ? (
          <Flex align="center" gap={2}>
            <Spinner muted />
            <Text size={0} muted>
              Uploading to Sanity…
            </Text>
          </Flex>
        ) : null}
        {error ? (
          <Text size={0} style={{ color: 'var(--card-badge-critical-fg-color)' }}>
            {error}
          </Text>
        ) : null}
      </Stack>
    </>
  );
}

function placeholderFor(field: FormField): string {
  switch (field.kind) {
    case 'image':
      return 'Paste an image URL or upload below';
    case 'video':
      return 'Paste a video URL or upload below';
    case 'audio':
      return 'Paste an audio URL or upload below';
    case 'select':
      return '';
    case 'text':
    default:
      return field.kind === 'text' && field.placeholder ? field.placeholder : 'Enter a value';
  }
}

function toStringInputValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return String(value);
}
