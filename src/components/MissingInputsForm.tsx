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
      <Stack space={5}>
        <Stack space={3}>
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

        <Stack space={5}>
          {form.map((field, idx) => (
            <Box
              key={field.name}
              style={
                idx > 0
                  ? {
                      paddingTop: 16,
                      borderTop: '1px solid var(--card-border-color)',
                    }
                  : undefined
              }
            >
              <FieldRow
                field={field}
                value={values[field.name]}
                onChange={(v) => onChangeValue(field.name, v)}
              />
            </Box>
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

// ─── Field rendering ────────────────────────────────────────────────────────
//
// Strict separation between agent data and plugin UI:
//
//   Agent emits:     { name, question, kind, options?, suggestedDefault? }
//   Plugin renders:  header (label + helper + filled checkmark) + widget
//
// The plugin owns ALL visual decisions — label styling, helper-text demotion,
// spacing, which widget per kind. The agent NEVER authors UI strings beyond
// the optional natural-language `question` which the plugin chooses to render
// as muted helper text below the label.
//
// FieldRow is a thin dispatcher. Each widget is a self-contained component
// that renders one kind. Adding a new kind = adding one widget component +
// one branch in the dispatcher.

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  return (
    <Stack space={3}>
      <FieldHeader field={field} value={value} />
      <FieldWidget field={field} value={value} onChange={onChange} />
    </Stack>
  );
}

function FieldHeader({ field, value }: { field: FormField; value: unknown }) {
  const label = prettifyFieldLabel(field.name);
  const isFilled = typeof value === 'string' ? value.trim().length > 0 : value != null;
  // The agent's question is supporting context, not the primary label. Hide
  // it when it duplicates the label or is empty — the plugin decides when
  // helper text is informative.
  const helperText =
    field.question && field.question.trim() && field.question.trim() !== label
      ? field.question.trim()
      : null;

  return (
    <Stack space={2}>
      <Flex align="center" gap={2}>
        <Text size={1} weight="semibold">
          {label}
        </Text>
        {isFilled ? (
          <Text size={1} style={{ color: 'var(--card-badge-positive-fg-color)' }}>
            <CheckmarkIcon />
          </Text>
        ) : null}
      </Flex>
      {helperText ? (
        <Text size={0} muted>
          {helperText}
        </Text>
      ) : null}
    </Stack>
  );
}

function FieldWidget({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  switch (field.kind) {
    case 'image':
    case 'video':
    case 'audio':
      return <MediaWidget field={field} value={value} onChange={onChange} />;
    case 'select':
      return <SelectWidget field={field} value={value} onChange={onChange} />;
    case 'text':
    default:
      return <TextWidget field={field} value={value} onChange={onChange} />;
  }
}

// One widget per kind. Each is self-contained and decides its own internal
// layout. They all share the same {field, value, onChange} contract so the
// dispatcher above is a straight switch.

function MediaWidget({
  field,
  value,
  onChange,
}: {
  field: FormField & { kind: 'image' | 'video' | 'audio' };
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const stringValue = toStringInputValue(value);
  return (
    <Card padding={3} radius={2} tone="transparent" border>
      <Stack space={3}>
        <TextInput
          value={stringValue}
          onChange={(e) => onChange(e.currentTarget.value)}
          placeholder={placeholderFor(field)}
          border={false}
        />
        <Flex align="center" gap={2} wrap="wrap">
          <UploadButton kind={field.kind} onUploaded={onChange} />
          <SuggestedDefaultButton field={field} value={value} onChange={onChange} />
        </Flex>
      </Stack>
    </Card>
  );
}

function SelectWidget({
  field,
  value,
  onChange,
}: {
  field: FormField & { kind: 'select' };
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const stringValue = toStringInputValue(value);
  return (
    <Select value={stringValue} onChange={(e) => onChange(e.currentTarget.value)}>
      <option value="">— pick one —</option>
      {field.options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </Select>
  );
}

function TextWidget({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const stringValue = toStringInputValue(value);
  return (
    <Stack space={2}>
      <TextInput
        value={stringValue}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholderFor(field)}
      />
      <SuggestedDefaultButton field={field} value={value} onChange={onChange} />
    </Stack>
  );
}

// One-tap "use suggested default" chip — only renders when the form field
// carries a non-null suggestedDefault. Returns null otherwise so callers
// can drop it unconditionally without spread guards.
function SuggestedDefaultButton({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (!field.suggestedDefault) return null;
  const stringValue = toStringInputValue(value);
  const isAcceptingSuggested = stringValue === String(field.suggestedDefault.value);
  return (
    <Button
      mode="bleed"
      tone={isAcceptingSuggested ? 'positive' : 'default'}
      fontSize={1}
      padding={2}
      text={
        isAcceptingSuggested
          ? `Using ${field.suggestedDefault.label}`
          : `Use ${field.suggestedDefault.label}`
      }
      icon={isAcceptingSuggested ? CheckmarkIcon : undefined}
      onClick={() => onChange(field.suggestedDefault!.value)}
    />
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

function prettifyFieldLabel(name: string): string {
  if (!name) return '';
  // If the name already contains spaces, it's an author-set display name
  // (e.g., "Product image") — leave it as-is.
  if (/\s/.test(name)) return name;
  // Otherwise it's a snake_case / camelCase key — convert to Title Case once.
  const spaced = name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
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
