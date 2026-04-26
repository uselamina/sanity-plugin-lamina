import { useCallback, useState } from 'react';
import { ResetIcon, LaunchIcon } from '@sanity/icons';
import { Box, Button, Card, Flex, Stack, Text } from '@sanity/ui';
import type {
  DocumentActionComponent,
  DocumentActionProps,
  ObjectSchemaType,
  SchemaType,
  ArraySchemaType,
  SanityDocument,
} from 'sanity';
import { useClient, useSchema } from 'sanity';

/** A Lamina-sourced asset found in a document. */
interface LaminaAssetRef {
  fieldPath: string;
  runId: string;
  runUrl: string;
}

/**
 * Checks whether a schema type is (or derives from) `image` or `file`.
 */
function isImageOrFileType(schemaType: SchemaType): boolean {
  let current: SchemaType | undefined = schemaType;
  while (current) {
    if (current.name === 'image' || current.name === 'file') {
      return true;
    }
    current = current.type;
  }
  return false;
}

/**
 * Recursively walks a Sanity schema type tree to determine whether it
 * (or any descendant) can contain image/file fields.
 */
function schemaContainsAssetFields(schemaType: SchemaType | undefined): boolean {
  if (!schemaType) return false;
  if (isImageOrFileType(schemaType)) return true;

  if ('fields' in schemaType && Array.isArray((schemaType as ObjectSchemaType).fields)) {
    for (const field of (schemaType as ObjectSchemaType).fields) {
      if (schemaContainsAssetFields(field.type)) return true;
    }
  }

  if ('of' in schemaType && Array.isArray((schemaType as ArraySchemaType).of)) {
    for (const member of (schemaType as ArraySchemaType).of) {
      if (schemaContainsAssetFields(member)) return true;
    }
  }

  return false;
}

/**
 * Walks a fetched Sanity document and collects every `asset._ref` from
 * fields whose runtime `_type` is `image` or `file`.
 */
function collectAssetRefs(
  doc: SanityDocument,
): Array<{ path: string; assetRef: string }> {
  const refs: Array<{ path: string; assetRef: string }> = [];

  function walk(obj: unknown, path: string): void {
    if (!obj || typeof obj !== 'object') return;
    const record = obj as Record<string, unknown>;

    if (
      (record._type === 'image' || record._type === 'file') &&
      record.asset &&
      typeof record.asset === 'object'
    ) {
      const asset = record.asset as Record<string, unknown>;
      if (typeof asset._ref === 'string') {
        refs.push({ path, assetRef: asset._ref });
      }
      return;
    }

    for (const [key, value] of Object.entries(record)) {
      if (key.startsWith('_')) continue;

      const childPath = path ? `${path}.${key}` : key;
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${childPath}[${i}]`));
      } else if (typeof value === 'object' && value !== null) {
        walk(value, childPath);
      }
    }
  }

  walk(doc, '');
  return refs;
}

/**
 * Finds all Lamina-sourced asset references in a document.
 */
async function findLaminaAssets(
  client: ReturnType<typeof useClient>,
  documentId: string,
): Promise<LaminaAssetRef[]> {
  const doc = await client.fetch<SanityDocument | null>(
    '*[_id == $id || _id == $draftId][0]',
    { id: documentId, draftId: `drafts.${documentId}` },
  );
  if (!doc) return [];

  const collected = collectAssetRefs(doc);
  if (collected.length === 0) return [];

  const assetIds = collected.map((c) => c.assetRef);
  const assetSources = await client.fetch<
    Array<{
      _id: string;
      source: { name?: string; id?: string; url?: string } | null;
    }>
  >(
    '*[_id in $ids]{ _id, source }',
    { ids: assetIds },
  );

  const sourceMap = new Map(
    assetSources.map((a) => [a._id, a.source]),
  );

  const results: LaminaAssetRef[] = [];
  for (const { path, assetRef } of collected) {
    const source = sourceMap.get(assetRef);
    if (source?.name === 'lamina' && source.id && source.url) {
      results.push({
        fieldPath: path,
        runId: source.id,
        runUrl: source.url,
      });
    }
  }

  return results;
}

/** Formats a field path for display (e.g. "heroImage" → "Hero Image"). */
function formatFieldPath(path: string): string {
  // Take the last segment for display
  const segments = path.split('.');
  const last = segments[segments.length - 1].replace(/\[\d+\]$/, '');
  return last.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}

export function createRegenerateAction(): DocumentActionComponent {
  const RegenerateAction: DocumentActionComponent = (
    props: DocumentActionProps,
  ) => {
    const { id: documentId, type: documentType, published, draft } = props;
    const client = useClient({ apiVersion: '2024-01-01' });
    const schema = useSchema();
    const [checking, setChecking] = useState(false);
    const [pickerAssets, setPickerAssets] = useState<LaminaAssetRef[] | null>(null);

    const schemaType = schema.get(documentType);
    const canHaveAssets = schemaContainsAssetFields(schemaType);
    const hasDocument = Boolean(published || draft);

    const handleClick = useCallback(async () => {
      setChecking(true);
      try {
        const laminaAssets = await findLaminaAssets(client, documentId);
        if (laminaAssets.length === 1) {
          window.open(laminaAssets[0].runUrl, '_blank', 'noopener');
        } else if (laminaAssets.length > 1) {
          setPickerAssets(laminaAssets);
        }
      } finally {
        setChecking(false);
      }
    }, [client, documentId]);

    const handleClosePicker = useCallback(() => {
      setPickerAssets(null);
    }, []);

    if (!canHaveAssets || !hasDocument) return null;

    return {
      label: checking ? 'Checking...' : 'Edit in Lamina',
      icon: ResetIcon,
      onHandle: handleClick,
      disabled: checking,
      dialog: pickerAssets
        ? {
            type: 'dialog' as const,
            header: 'Edit in Lamina',
            onClose: handleClosePicker,
            content: (
              <Box padding={4}>
                <Stack space={3}>
                  <Text size={1} muted>
                    This document has {pickerAssets.length} Lamina-generated assets.
                    Choose which one to edit:
                  </Text>
                  {pickerAssets.map((asset) => (
                    <Card
                      key={`${asset.fieldPath}-${asset.runId}`}
                      padding={3}
                      radius={2}
                      border
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        window.open(asset.runUrl, '_blank', 'noopener');
                        setPickerAssets(null);
                      }}
                    >
                      <Flex align="center" justify="space-between">
                        <Stack space={2}>
                          <Text size={1} weight="medium">
                            {formatFieldPath(asset.fieldPath)}
                          </Text>
                          <Text size={0} muted>
                            {asset.fieldPath}
                          </Text>
                        </Stack>
                        <Button
                          icon={LaunchIcon}
                          mode="ghost"
                          fontSize={1}
                          padding={2}
                          title="Open in Lamina"
                        />
                      </Flex>
                    </Card>
                  ))}
                </Stack>
              </Box>
            ),
          }
        : null,
    };
  };

  return RegenerateAction;
}
