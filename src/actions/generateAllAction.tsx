import { useCallback, useState } from 'react';
import { RocketIcon, CheckmarkCircleIcon } from '@sanity/icons';
import { Box, Button, Card, Flex, Spinner, Stack, Text } from '@sanity/ui';
import type {
  DocumentActionComponent,
  DocumentActionProps,
  ObjectSchemaType,
  SchemaType,
} from 'sanity';
import { useSchema } from 'sanity';

/** An image/file field discovered in the document schema. */
interface AssetField {
  name: string;
  /** Human-readable label. */
  label: string;
  /** 'image' or 'file'. */
  type: 'image' | 'file';
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
          fields.push({
            name: field.name,
            label,
            type: current.name as 'image' | 'file',
          });
          break;
        }
        current = current.type;
      }
    }
  }

  return fields;
}

export function createGenerateAllAction(): DocumentActionComponent {
  const GenerateAllAction: DocumentActionComponent = (
    props: DocumentActionProps,
  ) => {
    const { type: documentType, published, draft } = props;
    const schema = useSchema();
    const [showDialog, setShowDialog] = useState(false);

    const schemaType = schema.get(documentType);
    const assetFields = collectAssetFields(schemaType);
    const hasDocument = Boolean(published || draft);

    const handleClick = useCallback(() => {
      setShowDialog(true);
    }, []);

    const handleClose = useCallback(() => {
      setShowDialog(false);
    }, []);

    // Only show if the document type has 2+ image/file fields
    if (assetFields.length < 2 || !hasDocument) return null;

    return {
      label: 'Generate all media',
      icon: RocketIcon,
      onHandle: handleClick,
      dialog: showDialog
        ? {
            type: 'dialog' as const,
            header: 'Generate all Lamina assets',
            onClose: handleClose,
            content: (
              <Box padding={4}>
                <Stack space={4}>
                  <Text size={1} muted>
                    This document has {assetFields.length} image/file fields.
                    Open each field's asset picker to generate media with Lamina:
                  </Text>
                  {assetFields.map((field) => (
                    <Card key={field.name} padding={3} radius={2} border>
                      <Flex align="center" justify="space-between">
                        <Stack space={1}>
                          <Text size={1} weight="medium">
                            {field.label}
                          </Text>
                          <Text size={0} muted>
                            {field.type === 'file' ? 'Video/file field' : 'Image field'} — {field.name}
                          </Text>
                        </Stack>
                      </Flex>
                    </Card>
                  ))}
                  <Text size={0} muted>
                    Tip: Use the "Generate with Lamina" option in each field's
                    asset picker. Presets are applied automatically based on field names.
                  </Text>
                </Stack>
              </Box>
            ),
          }
        : null,
    };
  };

  return GenerateAllAction;
}
