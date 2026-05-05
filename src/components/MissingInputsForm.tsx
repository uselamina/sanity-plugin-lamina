/**
 * MissingInputsForm
 *
 * Renders the agent-emitted form spec (FormField[]) for inputs the agent could
 * not draft. The agent decides per-field which widget the plugin should use —
 * exotic app input types (productPicker, colorPicker, aspectRatio, etc.) are
 * translated by the agent into one of these 5 kinds:
 *
 *   - 'text'   → <TextInput>     (free-form, with optional placeholder)
 *   - 'select' → <Select>        (small fixed value space; options come from agent)
 *   - 'image'  → URL paste       (with optional suggested-default chip)
 *   - 'video'  → URL paste       (same)
 *   - 'audio'  → URL paste       (same)
 *
 * This component is a pure renderer — no widget dispatching, no type collapse,
 * no fallbacks. All decisions were made upstream and validated server-side.
 *
 * Real Sanity asset upload (file picker → CDN URL → server downloads) is
 * deferred — for now the media kinds are URL-paste fields.
 */

import {
  Badge,
  Box,
  Button,
  Card,
  Inline,
  Label,
  Select,
  Stack,
  Text,
  TextInput,
} from '@sanity/ui';
import type { FormField } from '@uselamina/sdk';
import React from 'react';

interface MissingInputsFormProps {
  /** Display name of the chosen app (shown in the form header). */
  appName: string;
  /** Optional 1-line agent rationale for picking this app — shown muted under the header. */
  appRationale: string | null;
  /** Agent-emitted form spec — one entry per input the agent couldn't draft. */
  form: FormField[];
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
  values,
  onChangeValue,
  onConfirm,
  onCancel,
}: MissingInputsFormProps) {
  // Disable Generate until every field has a non-empty value. The form
  // contains only required inputs (agent omits optionals), so all need filling.
  const allFilled = form.every((field) => {
    const v = values[field.name];
    if (v == null) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    return true;
  });

  return (
    <Card padding={4} radius={2} tone="primary" border>
      <Stack space={4}>
        <Stack space={2}>
          <Text size={2} weight="semibold">
            {appName} needs a few more things
          </Text>
          {appRationale ? (
            <Text size={1} muted>
              {appRationale}
            </Text>
          ) : null}
        </Stack>

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
          <Button text="Cancel" mode="ghost" onClick={onCancel} />
        </Inline>
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
  const hasDefault = !!field.suggestedDefault;
  const isAcceptingDefault =
    hasDefault && stringValue === String(field.suggestedDefault!.value);

  return (
    <Stack space={2}>
      <Inline space={2}>
        <Label size={1}>{field.question}</Label>
        <Badge tone="caution" fontSize={0}>
          required
        </Badge>
        {field.kind === 'image' || field.kind === 'video' || field.kind === 'audio' ? (
          <Badge tone="default" fontSize={0}>
            {field.kind}
          </Badge>
        ) : null}
      </Inline>

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

      {hasDefault ? (
        <Box>
          <Button
            mode={isAcceptingDefault ? 'default' : 'ghost'}
            tone={isAcceptingDefault ? 'positive' : 'default'}
            fontSize={1}
            padding={2}
            text={
              isAcceptingDefault
                ? `✓ Using ${field.suggestedDefault!.label}`
                : `Use ${field.suggestedDefault!.label}`
            }
            onClick={() => onChange(field.suggestedDefault!.value)}
          />
        </Box>
      ) : null}
    </Stack>
  );
}

function placeholderFor(field: FormField): string {
  switch (field.kind) {
    case 'image':
      return 'Paste an image URL';
    case 'video':
      return 'Paste a video URL';
    case 'audio':
      return 'Paste an audio URL';
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
