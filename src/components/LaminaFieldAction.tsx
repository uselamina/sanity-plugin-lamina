import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { EditIcon } from '@sanity/icons';
import { Button, Flex } from '@sanity/ui';
import { useClient, useFormValue } from 'sanity';
import { setDocumentContext } from '../lib/documentContext.js';

interface LaminaAssetMeta {
  source?: { name?: string; url?: string };
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

function findInputRoot(elementId: string | undefined): HTMLElement | null {
  if (!elementId) return null;
  const el = document.getElementById(elementId);
  if (!el) return null;
  return (
    el.closest('[data-testid="image-input"]') ||
    el.closest('[data-testid="file-input"]') ||
    el.closest('[data-ui="FormField"]') ||
    el.closest('[data-testid*="field"]') ||
    el.parentElement
  ) as HTMLElement | null;
}

function clickElement(el: Element | null): boolean {
  if (el instanceof HTMLElement) {
    el.click();
    return true;
  }
  return false;
}

function findButtonByExactText(root: ParentNode, text: string): HTMLElement | null {
  const normalizedText = text.trim().toLowerCase();
  const candidates = Array.from(root.querySelectorAll('button, [role="button"], [role="menuitem"]'));
  return (
    candidates.find((el) => {
      const label = [
        el.textContent,
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
      ]
        .filter(Boolean)
        .join(' ')
        .trim()
        .toLowerCase();
      return label === normalizedText;
    }) as HTMLElement | undefined
  ) ?? null;
}

function clickLaminaAssetSourceOption(root: ParentNode): boolean {
  // Sanity renders Lamina either as an asset-source target
  // (`data-asset-source-name="lamina"`) or as a browse menu item
  // (`file-input-browse-button-lamina`) depending on whether the field
  // already has an image/file.
  return (
    clickElement(root.querySelector('[data-asset-source-name="lamina"]')) ||
    clickElement(root.querySelector('[data-testid="file-input-browse-button-lamina"]')) ||
    clickElement(findButtonByExactText(root, 'Generate with Lamina'))
  );
}

function clickNativeAssetSourceOpener(root: HTMLElement): boolean {
  // Existing image/file fields use the action menu. Empty fields usually show
  // browse/upload buttons. Keep this scoped to the current field root; never
  // click a generic button elsewhere in the document.
  return (
    clickElement(root.querySelector('button[data-testid="options-menu-button"]')) ||
    clickElement(root.querySelector('button[data-testid="file-input-multi-browse-button"]')) ||
    clickElement(root.querySelector('button[data-testid^="file-input-upload-button"]')) ||
    clickElement(findButtonByExactText(root, 'Browse')) ||
    clickElement(findButtonByExactText(root, 'Select')) ||
    clickElement(findButtonByExactText(root, 'Upload'))
  );
}

function openLaminaAssetSource(elementId: string | undefined): boolean {
  const root = findInputRoot(elementId);
  if (!root) return false;

  // If Sanity already rendered the Lamina option, click it directly.
  if (clickLaminaAssetSourceOption(root)) return true;

  // Otherwise open the current field's native asset-source menu, then select
  // the Lamina option from the portal-rendered menu.
  if (!clickNativeAssetSourceOpener(root)) return false;

  for (const delay of [0, 75, 200, 500]) {
    window.setTimeout(() => {
      clickLaminaAssetSourceOption(document.body);
    }, delay);
  }
  return true;
}

export function LaminaImageInput(props: LaminaImageInputProps) {
  const { value, renderDefault, ...rest } = props;
  const client = useClient({ apiVersion: '2024-01-01' });
  const [runUrl, setRunUrl] = useState<string | null>(null);

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
        } else {
          setRunUrl(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRunUrl(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, assetRef]);

  // Trigger the same native asset-source dialog as "Generate with Lamina".
  // Do not prefill from the existing Sanity asset's `description`: that field
  // stores the old generation prompt, so using it here would resurrect stale
  // prompts even after the user clears Lamina's local cache.
  const handleRegenerate = useCallback(() => {
    // Open the same native Sanity asset-source flow as "Generate with Lamina".
    // We intentionally don't render GenerateDialog directly here: Sanity owns
    // the asset-source `onSelect` plumbing that writes the chosen asset into
    // the image/file field.
    const el = (rest as Record<string, unknown>).elementProps as
      | { id?: string }
      | undefined;

    const opened = openLaminaAssetSource(el?.id);
    if (!opened) {
      console.warn('[lamina/regenerate] Could not find Sanity asset-source picker for this field');
    }
  }, [rest]);

  return (
    <>
      {renderDefault({ ...rest, value, renderDefault })}
      {runUrl ? (
        <Flex paddingTop={2} gap={2}>
          <Button
            text="Regenerate"
            icon={EditIcon}
            mode="ghost"
            tone="primary"
            fontSize={1}
            padding={2}
            onClick={handleRegenerate}
          />
        </Flex>
      ) : null}
    </>
  );
}
