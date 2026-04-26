/**
 * Schema-aware context extraction for intelligent prompt generation.
 *
 * Uses Sanity's schema introspection to read field validation rules,
 * descriptions, and sibling field values to generate richer, more
 * context-aware prompts.
 *
 * Closes #67.
 */

import type { ObjectSchemaType, SchemaType } from 'sanity';

export interface SchemaFieldMeta {
  /** The field name. */
  name: string;
  /** The field title (human-readable). */
  title: string;
  /** The schema-level description, if defined. */
  description: string | null;
  /** The base type ('image' or 'file'). */
  baseType: 'image' | 'file';
  /** Whether hotspot/crop is enabled for the field. */
  hasHotspot: boolean;
  /** Accept filter if defined on a file field (e.g. 'image/*', 'video/*'). */
  acceptFilter: string | null;
}

/**
 * Extract metadata about a specific image/file field from the schema.
 */
export function getFieldMeta(
  schemaType: SchemaType | undefined,
  fieldName: string,
): SchemaFieldMeta | null {
  if (!schemaType || !('fields' in schemaType)) return null;

  const objectType = schemaType as ObjectSchemaType;
  const field = objectType.fields.find((f) => f.name === fieldName);
  if (!field) return null;

  let baseType: 'image' | 'file' | null = null;
  let current: SchemaType | undefined = field.type;
  while (current) {
    if (current.name === 'image') { baseType = 'image'; break; }
    if (current.name === 'file') { baseType = 'file'; break; }
    current = current.type;
  }
  if (!baseType) return null;

  const options = (field.type as unknown as Record<string, unknown>).options as Record<string, unknown> | undefined;
  const hasHotspot = Boolean(options?.hotspot);
  const acceptFilter = (options?.accept as string) ?? null;

  return {
    name: field.name,
    title: field.type.title ?? field.name.replace(/([A-Z])/g, ' $1').trim(),
    description: (field.type as unknown as Record<string, unknown>).description as string | null ?? null,
    baseType,
    hasHotspot,
    acceptFilter,
  };
}

/** A key-value pair extracted from sibling fields. */
export interface SiblingValue {
  fieldName: string;
  title: string;
  value: string;
}

/**
 * Field names commonly useful as context when generating media.
 * These are read from the document to enrich prompts.
 */
const CONTEXT_FIELDS = [
  'title', 'name', 'headline', 'subtitle',
  'category', 'tags', 'color', 'colours', 'colors',
  'brand', 'style', 'theme', 'mood',
  'slug',
] as const;

/**
 * Extract useful sibling field values from the document that could
 * enrich a media generation prompt.
 *
 * @param schemaType The document schema type.
 * @param getFieldValue A callback that reads a field value (typically from useFormValue).
 */
export function extractSiblingContext(
  schemaType: SchemaType | undefined,
  getFieldValue: (fieldName: string) => unknown,
): SiblingValue[] {
  if (!schemaType || !('fields' in schemaType)) return [];

  const objectType = schemaType as ObjectSchemaType;
  const results: SiblingValue[] = [];

  for (const contextField of CONTEXT_FIELDS) {
    const field = objectType.fields.find((f) => f.name === contextField);
    if (!field) continue;

    const value = getFieldValue(contextField);
    if (!value) continue;

    let stringValue: string | null = null;

    if (typeof value === 'string' && value.trim()) {
      stringValue = value.trim();
    } else if (Array.isArray(value)) {
      // Handle arrays like tags: ['tag1', 'tag2']
      const strings = value
        .filter((v): v is string => typeof v === 'string')
        .slice(0, 5);
      if (strings.length > 0) {
        stringValue = strings.join(', ');
      }
      // Handle reference arrays with name/title
      const named = value
        .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
        .map((v) => (v.title || v.name || v.label) as string | undefined)
        .filter((v): v is string => Boolean(v))
        .slice(0, 5);
      if (!stringValue && named.length > 0) {
        stringValue = named.join(', ');
      }
    } else if (typeof value === 'object' && value !== null) {
      // Handle slug objects
      const slug = (value as Record<string, unknown>).current as string | undefined;
      if (slug) stringValue = slug;
    }

    if (stringValue) {
      results.push({
        fieldName: contextField,
        title: field.type.title ?? contextField,
        value: stringValue.substring(0, 100),
      });
    }
  }

  return results;
}

/**
 * Build a context-rich prompt suggestion from schema metadata and
 * sibling field values.
 */
export function buildSchemaAwarePrompt(
  fieldMeta: SchemaFieldMeta | null,
  siblingValues: SiblingValue[],
  documentType: string | undefined,
  documentTitle: string | undefined,
): string | null {
  if (!fieldMeta) return null;

  const parts: string[] = [];

  // Start with the field description if available — it often contains
  // editor-authored instructions like "Product lifestyle photo, square format"
  if (fieldMeta.description) {
    parts.push(fieldMeta.description);
  } else {
    // Fall back to field title
    parts.push(fieldMeta.title);
  }

  // Add document context
  if (documentTitle) {
    const typeLabel = documentType
      ? documentType.replace(/([A-Z])/g, ' $1').toLowerCase().trim()
      : 'content';
    parts.push(`for ${typeLabel}: "${documentTitle}"`);
  }

  // Add select sibling values for richer context
  const category = siblingValues.find((s) => s.fieldName === 'category');
  const tags = siblingValues.find((s) => s.fieldName === 'tags');
  const style = siblingValues.find(
    (s) => s.fieldName === 'style' || s.fieldName === 'theme' || s.fieldName === 'mood',
  );
  const color = siblingValues.find(
    (s) => s.fieldName === 'color' || s.fieldName === 'colours' || s.fieldName === 'colors',
  );

  if (category) parts.push(`category: ${category.value}`);
  if (style) parts.push(`style: ${style.value}`);
  if (color) parts.push(`colors: ${color.value}`);
  if (tags) parts.push(`keywords: ${tags.value}`);

  return parts.join(', ');
}
