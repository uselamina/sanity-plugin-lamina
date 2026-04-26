import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { EditIcon } from '@sanity/icons';
import { Button, Flex } from '@sanity/ui';
import { useClient, useFormValue } from 'sanity';
import { setDocumentContext } from '../lib/documentContext.js';

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
      .fetch<{ source?: { name?: string; url?: string } } | null>(
        '*[_id == $id][0]{ source }',
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
        if (!cancelled) setRunUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [client, assetRef]);

  const handleEdit = useCallback(() => {
    if (runUrl) {
      window.open(runUrl, '_blank', 'noopener');
    }
  }, [runUrl]);

  return (
    <>
      {renderDefault({ ...rest, value, renderDefault })}
      {runUrl ? (
        <Flex paddingTop={2}>
          <Button
            text="Edit in Lamina"
            icon={EditIcon}
            mode="ghost"
            tone="primary"
            fontSize={1}
            padding={2}
            onClick={handleEdit}
          />
        </Flex>
      ) : null}
    </>
  );
}
