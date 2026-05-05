/**
 * DecisionCard — multi-app picker rendered when previewRun returns `needs_choice`.
 *
 * The 'app' and 'freestyle' modes are auto-dispatched by GenerateDialog (or
 * routed to MissingInputsForm when the agent's `form` is non-empty), so this
 * component only handles the multi-app picker. The `agent_failed` mode has its
 * own inline render in GenerateDialog.
 */

import {
  Button,
  Card,
  Flex,
  Inline,
  Stack,
  Text,
} from '@sanity/ui';
import type { LaminaClient, PreviewRunResult } from '@uselamina/sdk';
import React from 'react';

interface DecisionCardProps {
  preview: PreviewRunResult;
  editedInputs: Record<string, unknown>;
  onEditInput: (name: string, value: unknown) => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** Called when the user picks a candidate from the needs_choice multi-picker. */
  onPickCandidate: (appId: string) => void;
  laminaClient: LaminaClient;
}

export function DecisionCard(props: DecisionCardProps) {
  const { preview } = props;
  if (preview.mode !== 'needs_choice') return null;
  return <NeedsChoiceDecisionCard {...props} preview={preview} />;
}

function NeedsChoiceDecisionCard({
  preview,
  onPickCandidate,
  onCancel,
}: DecisionCardProps & { preview: Extract<PreviewRunResult, { mode: 'needs_choice' }> }) {
  return (
    <Card padding={4} radius={2} tone="caution" border>
      <Stack space={3}>
        <Text size={2} weight="semibold">
          Multiple apps could fit — pick one
        </Text>
        <Text size={1} muted>
          {preview.reason}
        </Text>
        <Stack space={2}>
          {preview.candidates.map((c) => (
            <Card key={c.appId} padding={3} radius={2} tone="default" border>
              <Flex justify="space-between" align="center" gap={2}>
                <Stack space={1}>
                  <Text size={1} weight="semibold">
                    {c.name}
                  </Text>
                  {c.description ? (
                    <Text size={1} muted>
                      {c.description}
                    </Text>
                  ) : null}
                  <Text size={1} muted>
                    {c.missingRequiredInputs.length === 0
                      ? '✓ Ready to run'
                      : `⚠ Needs ${c.missingRequiredInputs.length} more input${c.missingRequiredInputs.length === 1 ? '' : 's'}`}
                  </Text>
                </Stack>
                <Button
                  text="Pick"
                  tone="primary"
                  fontSize={1}
                  onClick={() => onPickCandidate(c.appId)}
                />
              </Flex>
            </Card>
          ))}
        </Stack>
        <Inline space={2}>
          <Button text="Cancel" mode="ghost" onClick={onCancel} />
        </Inline>
      </Stack>
    </Card>
  );
}
