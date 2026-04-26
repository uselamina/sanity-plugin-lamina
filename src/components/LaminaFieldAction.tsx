import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { EditIcon, LaunchIcon } from '@sanity/icons';
import { Button, Flex } from '@sanity/ui';
import { useClient, useFormValue } from 'sanity';
import { setDocumentContext } from '../lib/documentContext.js';

interface LaminaAssetMeta {
  source?: { name?: string; url?: string };
  description?: string;
}

interface LaminaImageInputProps {
  value?: {
    asset?: {
      _ref?: string;
    };
  };
  renderDefault: (props: Record<string, unknown>) => ReactNode;
  [key: string]: unknown;
}

export function LaminaImageInput(props: LaminaImageInputProps) {
  const { value, renderDefault, ...rest } = props;
  const client = useClient({ apiVersion: '2024-01-01' });
  const [runUrl, setRunUrl] = useState<string | null>(null);
  const [previousBrief, setPreviousBrief] = useState<string | null>(null);

  // Track document context for the embed iframe
  const documentTitle = useFormValue(['title']) as string | undefined;
  const documentId = useFormValue(['_id']) as string | undefined;
  const documentType = useFormValue(['_type']) as string | undefined;

  useEffect(() => {
    if (documentId && documentType) {
      setDocumentContext({
        documentId,
        documentType,
        documentTitle: documentTitle ?? null,
        fieldName: null,
        fieldType: 'image',
      });
    }
  }, [documentId, documentType, documentTitle]);

  const assetRef = value?.asset?._ref ?? null;

  useEffect(() => {
    if (!assetRef) {
      setRunUrl(null);
      setPreviousBrief(null);
      return;
    }

    let cancelled = false;
    client
      .fetch<LaminaAssetMeta | null>(
        '*[_id == $id][0]{ source, description }',
        { id: assetRef },
      )
      .then((result) => {
        if (cancelled) return;
        if (result?.source?.name === 'lamina' && result.source.url) {
          setRunUrl(result.source.url);
          setPreviousBrief(result.description ?? null);
        } else {
          setRunUrl(null);
          setPreviousBrief(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRunUrl(null);
          setPreviousBrief(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, assetRef]);

  const handleOpenInLamina = useCallback(() => {
    if (runUrl) {
      window.open(runUrl, '_blank', 'noopener');
    }
  }, [runUrl]);

  // Trigger the asset source dialog with previous brief pre-filled via
  // a custom event that GenerateDialog listens for.
  const handleRegenerate = useCallback(() => {
    // Dispatch a custom event that the asset source dialog can pick up
    // to pre-fill the brief from the previous generation.
    window.dispatchEvent(
      new CustomEvent('lamina:regenerate', {
        detail: { brief: previousBrief },
      }),
    );
    // Find and click the native "Generate with Lamina" asset source button
    // to open the dialog. This traverses Sanity's DOM to trigger the picker.
    const el = (rest as Record<string, unknown>).elementProps as
      | { id?: string }
      | undefined;
    if (el?.id) {
      const wrapper = document.getElementById(el.id);
      const changeBtn = wrapper?.closest('[data-testid="file-input"]')
        ?.querySelector('button[data-testid="file-input-upload-button"]')
        ?? wrapper?.closest('[data-testid="image-input"]')
          ?.querySelector('button[data-testid="file-input-upload-button"]');
      if (changeBtn instanceof HTMLElement) {
        changeBtn.click();
      }
    }
  }, [previousBrief, rest]);

  return (
    <>
      {renderDefault({ ...rest, value, renderDefault })}
      {runUrl ? (
        <Flex paddingTop={2} gap={2}>
          <Button
            text={previousBrief ? 'Regenerate' : 'Edit in Lamina'}
            icon={EditIcon}
            mode="ghost"
            tone="primary"
            fontSize={1}
            padding={2}
            onClick={previousBrief ? handleRegenerate : handleOpenInLamina}
          />
          {previousBrief ? (
            <Button
              icon={LaunchIcon}
              mode="ghost"
              fontSize={1}
              padding={2}
              title="Open original run in Lamina"
              onClick={handleOpenInLamina}
            />
          ) : null}
        </Flex>
      ) : null}
    </>
  );
}
