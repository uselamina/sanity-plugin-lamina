import { useCallback, useState } from 'react';
import { ResetIcon } from '@sanity/icons';
import type { DocumentActionComponent, DocumentActionProps } from 'sanity';
import { useClient } from 'sanity';

/**
 * Finds all Lamina-sourced asset references in a document by
 * querying for assets whose `source.name` is "lamina".
 */
async function findLaminaAssets(
  client: ReturnType<typeof useClient>,
  documentId: string,
): Promise<Array<{ fieldPath: string; runId: string; runUrl: string }>> {
  // Query all image/file assets referenced by this document that have Lamina source metadata
  const result = await client.fetch<
    Array<{ path: string; source: { name: string; id: string; url: string } }>
  >(
    `*[_id == $id][0]{
      "refs": array::compact([
        ...(*[_id == ^._id][0]{"_type": _type}),
      ])
    }`,
    { id: documentId },
  );

  // For now, we use a simpler approach: fetch the document and walk its asset references
  const doc = await client.fetch('*[_id == $id][0]', { id: documentId });
  if (!doc) return [];

  const assets: Array<{ fieldPath: string; runId: string; runUrl: string }> = [];

  function walk(obj: unknown, path: string) {
    if (!obj || typeof obj !== 'object') return;
    const record = obj as Record<string, unknown>;

    // Check if this is an image/file field with an asset reference
    if (record._type === 'image' || record._type === 'file') {
      // We'll need to look up the asset document to check source metadata
      return;
    }

    for (const [key, value] of Object.entries(record)) {
      if (key.startsWith('_')) continue;
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${path}.${key}[${i}]`));
      } else if (typeof value === 'object' && value !== null) {
        walk(value, `${path}.${key}`);
      }
    }
  }

  walk(doc, '');
  return assets;
}

export function createRegenerateAction(): DocumentActionComponent {
  const RegenerateAction: DocumentActionComponent = (
    props: DocumentActionProps,
  ) => {
    const { id: documentId, published } = props;
    const client = useClient({ apiVersion: '2024-01-01' });
    const [checking, setChecking] = useState(false);
    const [hasLaminaAssets, setHasLaminaAssets] = useState<boolean | null>(null);

    const handleClick = useCallback(async () => {
      setChecking(true);

      try {
        // Query for any assets in this document with lamina source
        const query = `*[_id == $id][0]{
          "assetRefs": array::compact([
            mainImage.asset->.source,
            image.asset->.source,
            file.asset->.source,
            poster.asset->.source,
            thumbnail.asset->.source,
            hero.asset->.source,
            cover.asset->.source,
            media.asset->.source
          ])
        }`;

        const result = await client.fetch<{
          assetRefs: Array<{ name?: string; id?: string; url?: string } | null>;
        }>(query, { id: documentId });

        const laminaRefs = (result?.assetRefs || []).filter(
          (ref) => ref?.name === 'lamina',
        );

        if (laminaRefs.length > 0) {
          // Open the first Lamina asset's run URL
          const firstRef = laminaRefs[0];
          if (firstRef?.url) {
            window.open(firstRef.url, '_blank', 'noopener');
          }
        }

        setHasLaminaAssets(laminaRefs.length > 0);
      } finally {
        setChecking(false);
      }
    }, [client, documentId]);

    // Don't show the action if there's no published document
    if (!published) return null;

    return {
      label: checking ? 'Checking...' : 'Edit in Lamina',
      icon: ResetIcon,
      onHandle: handleClick,
      disabled: checking,
    };
  };

  return RegenerateAction;
}
