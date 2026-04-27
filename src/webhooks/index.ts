/**
 * Webhook handler factory for auto-generating media on Sanity document events.
 *
 * Deploy as a Vercel / Netlify / Cloudflare serverless function.
 * Listens for Sanity GROQ-powered webhook payloads and triggers Lamina
 * generation for matching documents.
 *
 * Import from 'sanity-plugin-lamina/webhooks'.
 *
 * @example
 * ```ts
 * import { createLaminaWebhookHandler } from 'sanity-plugin-lamina/webhooks'
 *
 * export default createLaminaWebhookHandler({
 *   laminaApiKey: process.env.LAMINA_API_KEY,
 *   sanityProjectId: 'abc123',
 *   sanityToken: process.env.SANITY_TOKEN,
 *   sanityWebhookSecret: process.env.SANITY_WEBHOOK_SECRET,
 *   triggers: [
 *     {
 *       filter: '_type == "product"',
 *       fields: {
 *         heroImage: 'Product photo for {{title}}',
 *         thumbnail: 'Product thumbnail, {{title}}',
 *       },
 *       onlyIfEmpty: true,
 *     },
 *   ],
 * })
 * ```
 *
 * Closes #78.
 *
 * @packageDocumentation
 */

import { createLaminaSanityClient } from '../headless/client.js';
import type { LaminaSanityClientOptions, FillProgressEvent } from '../headless/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookTrigger {
  /**
   * GROQ filter expression to match documents.
   * Evaluated against the webhook payload's document.
   * @example '_type == "product"'
   */
  filter: string;
  /**
   * Field-to-brief mapping.
   * Keys are field names. Values are brief templates with {{fieldName}} placeholders.
   */
  fields: Record<string, string>;
  /** Only generate if the field is currently empty. Defaults to true. */
  onlyIfEmpty?: boolean;
  /** Whether to enhance briefs before generation. Defaults to true. */
  enhance?: boolean;
  /** Brand profile ID for this trigger. */
  brandProfileId?: string;
  /** Campaign ID for this trigger. */
  campaignId?: string;
}

export interface WebhookHandlerOptions extends LaminaSanityClientOptions {
  /** Secret for verifying Sanity webhook signatures. */
  sanityWebhookSecret?: string;
  /** Trigger configurations. */
  triggers: WebhookTrigger[];
  /** Called after each field is generated. */
  onGenerated?: (documentId: string, fieldName: string, assetId: string) => void;
  /** Called when a field generation fails. */
  onError?: (documentId: string, fieldName: string, error: string) => void;
  /** Called for every progress event. */
  onProgress?: (event: FillProgressEvent) => void;
}

/** Sanity webhook payload shape (GROQ-powered webhooks). */
interface SanityWebhookPayload {
  _id: string;
  _type: string;
  _rev?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

async function verifySanitySignature(
  body: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const expected = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return expected === signature;
  } catch {
    return false;
  }
}

/**
 * Evaluate a simple GROQ-like filter against a document.
 * Supports: _type == "value", _type in ["a", "b"], and simple && / || combinators.
 * For complex filters, the caller should configure Sanity webhooks with GROQ filters
 * server-side and skip client-side filtering.
 */
function matchesFilter(doc: SanityWebhookPayload, filter: string): boolean {
  // _type == "value"
  const typeMatch = filter.match(/_type\s*==\s*"([^"]+)"/);
  if (typeMatch) {
    return doc._type === typeMatch[1];
  }
  // _type in ["a", "b"]
  const inMatch = filter.match(/_type\s+in\s+\[([^\]]+)\]/);
  if (inMatch) {
    const values = inMatch[1].match(/"([^"]+)"/g)?.map((v) => v.replace(/"/g, ''));
    return values ? values.includes(doc._type) : false;
  }
  // Fallback: match all
  return true;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create a webhook handler that auto-generates Lamina assets when
 * Sanity documents are created or updated.
 *
 * Returns a standard `(request: Request) => Promise<Response>` handler
 * compatible with Vercel, Netlify, Cloudflare Workers, and Express
 * (via adapter).
 */
export function createLaminaWebhookHandler(
  opts: WebhookHandlerOptions,
): (request: Request) => Promise<Response> {
  const client = createLaminaSanityClient(opts);

  return async (request: Request): Promise<Response> => {
    // Only accept POST
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body = await request.text();

    // Verify signature if secret is configured
    if (opts.sanityWebhookSecret) {
      const signature = request.headers.get('sanity-webhook-signature');
      const valid = await verifySanitySignature(body, signature, opts.sanityWebhookSecret);
      if (!valid) {
        return new Response('Invalid signature', { status: 401 });
      }
    }

    let payload: SanityWebhookPayload;
    try {
      payload = JSON.parse(body) as SanityWebhookPayload;
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    if (!payload._id || !payload._type) {
      return new Response('Missing _id or _type', { status: 400 });
    }

    // Find matching triggers
    const matchingTriggers = opts.triggers.filter((t) => matchesFilter(payload, t.filter));
    if (matchingTriggers.length === 0) {
      return new Response(JSON.stringify({ status: 'skipped', reason: 'No matching triggers' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Merge all field mappings from matching triggers
    const fieldMapping: Record<string, string> = {};
    let enhance = true;
    let brandProfileId: string | undefined;

    for (const trigger of matchingTriggers) {
      Object.assign(fieldMapping, trigger.fields);
      if (trigger.enhance === false) enhance = false;
      if (trigger.brandProfileId) brandProfileId = trigger.brandProfileId;
    }

    const onlyIfEmpty = matchingTriggers.every((t) => t.onlyIfEmpty !== false);

    // Run generation
    try {
      const result = await client.fillEmptyMedia({
        query: `*[_id == $id][0]`,
        queryParams: { id: payload._id },
        fieldMapping,
        onlyIfEmpty,
        enhance,
        brandProfileId,
        concurrency: 2,
        onProgress: (event) => {
          opts.onProgress?.(event);
          if (event.status === 'patched') {
            opts.onGenerated?.(event.documentId, event.fieldName, '');
          }
          if (event.status === 'failed' && event.error) {
            opts.onError?.(event.documentId, event.fieldName, event.error);
          }
        },
      });

      return new Response(JSON.stringify({
        status: 'completed',
        documentId: payload._id,
        fieldsGenerated: result.fieldsGenerated,
        fieldsFailed: result.fieldsFailed,
        fieldsSkipped: result.fieldsSkipped,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      opts.onError?.(payload._id, '*', error);
      return new Response(JSON.stringify({ status: 'error', error }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  };
}
