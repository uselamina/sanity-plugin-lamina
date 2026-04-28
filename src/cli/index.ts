#!/usr/bin/env node

/**
 * sanity-lamina CLI.
 *
 * Programmatic Lamina operations from the terminal.
 *
 * Usage:
 *   npx sanity-lamina generate --query '...' --field heroImage --brief '...'
 *   npx sanity-lamina fill-document <documentId>
 *   npx sanity-lamina score
 *   npx sanity-lamina apps
 *   npx sanity-lamina credits
 *
 * Closes #77.
 */

import { parseArgs } from 'node:util';
import { createLaminaSanityClient } from '../headless/client.js';
import type { FillProgressEvent } from '../headless/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  process.stdout.write(`${msg}\n`);
}

function logProgress(event: FillProgressEvent) {
  const icon = event.status === 'patched' ? '\u2713'
    : event.status === 'failed' ? '\u2717'
      : event.status === 'skipped' ? '-'
        : '\u2026';
  const doc = event.documentTitle || event.documentId;
  log(`  ${icon} ${doc} / ${event.fieldName}: ${event.status}${event.error ? ` (${event.error})` : ''}`);
}

function die(msg: string): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

function printUsage() {
  log(`
sanity-lamina — Programmatic media generation with Lamina + Sanity

COMMANDS
  generate          Bulk generate media for documents matching a GROQ query
  fill-document     Fill empty media fields on a single document
  score             Score existing Lamina-generated assets
  apps              List available Lamina apps
  credits           Check credit balance

GLOBAL OPTIONS
  --api-key         Lamina API key         (env: LAMINA_API_KEY)
  --project         Sanity project ID      (env: SANITY_PROJECT_ID)
  --dataset         Sanity dataset          (env: SANITY_DATASET, default: production)
  --token           Sanity API token       (env: SANITY_TOKEN)
  --json            Output as JSON
  --help            Show this help

EXAMPLES
  npx sanity-lamina generate \\
    --query '*[_type == "product" && !defined(heroImage)]' \\
    --field heroImage \\
    --brief 'Product lifestyle photo for {{title}}'

  npx sanity-lamina fill-document product-123 --enhance

  npx sanity-lamina score --limit 50
`.trim());
}

// ---------------------------------------------------------------------------
// Client factory from CLI args
// ---------------------------------------------------------------------------

interface GlobalOpts {
  apiKey?: string;
  project?: string;
  dataset?: string;
  token?: string;
  json?: boolean;
}

function createClientFromArgs(opts: GlobalOpts) {
  return createLaminaSanityClient({
    laminaApiKey: opts.apiKey,
    sanityProjectId: opts.project,
    sanityDataset: opts.dataset || undefined,
    sanityToken: opts.token,
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdGenerate(args: string[], globalOpts: GlobalOpts) {
  const { values } = parseArgs({
    args,
    options: {
      query: { type: 'string', short: 'q' },
      field: { type: 'string', short: 'f' },
      brief: { type: 'string', short: 'b' },
      concurrency: { type: 'string', short: 'c' },
      'brand-profile': { type: 'string' },
      enhance: { type: 'boolean', default: true },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: false,
  });

  if (!values.query) die('--query is required. Example: \'*[_type == "product" && !defined(heroImage)]\'');
  if (!values.field && !values.brief) die('--field or --brief is required');

  const client = createClientFromArgs(globalOpts);
  const fieldMapping: Record<string, string> = {};
  if (values.field && values.brief) {
    fieldMapping[values.field as string] = values.brief as string;
  }

  log(`Querying documents: ${values.query}`);

  const result = await client.fillEmptyMedia({
    query: values.query as string,
    fieldMapping: Object.keys(fieldMapping).length > 0 ? fieldMapping : undefined,
    concurrency: values.concurrency ? parseInt(values.concurrency as string, 10) : 3,
    enhance: values.enhance as boolean,
    brandProfileId: values['brand-profile'] as string | undefined,
    dryRun: values['dry-run'] as boolean,
    onProgress: globalOpts.json ? undefined : logProgress,
  });

  if (globalOpts.json) {
    log(JSON.stringify(result, null, 2));
  } else {
    log('');
    log(`Done. ${result.documentsProcessed} documents processed.`);
    log(`  Generated: ${result.fieldsGenerated}`);
    log(`  Skipped:   ${result.fieldsSkipped}`);
    log(`  Failed:    ${result.fieldsFailed}`);
  }
}

async function cmdFillDocument(args: string[], globalOpts: GlobalOpts) {
  const documentId = args[0];
  if (!documentId) die('Document ID is required. Usage: sanity-lamina fill-document <documentId>');

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      enhance: { type: 'boolean', default: true },
      'brand-profile': { type: 'string' },
      concurrency: { type: 'string', short: 'c' },
    },
    strict: false,
  });

  const client = createClientFromArgs(globalOpts);

  log(`Filling empty media for document: ${documentId}`);

  const result = await client.fillEmptyMedia({
    query: `*[_id == $id || _id == "drafts." + $id]`,
    queryParams: { id: documentId },
    concurrency: values.concurrency ? parseInt(values.concurrency as string, 10) : 3,
    enhance: values.enhance as boolean,
    brandProfileId: values['brand-profile'] as string | undefined,
    onProgress: globalOpts.json ? undefined : logProgress,
  });

  if (globalOpts.json) {
    log(JSON.stringify(result, null, 2));
  } else {
    log('');
    log(`Done. ${result.fieldsGenerated} generated, ${result.fieldsSkipped} skipped, ${result.fieldsFailed} failed.`);
  }
}

async function cmdScore(args: string[], globalOpts: GlobalOpts) {
  const { values } = parseArgs({
    args,
    options: {
      query: { type: 'string', short: 'q' },
      limit: { type: 'string', short: 'l' },
      platform: { type: 'string' },
    },
    strict: false,
  });

  const client = createClientFromArgs(globalOpts);

  log('Scoring Lamina assets...');

  const scores = await client.scoreAssets({
    query: values.query as string | undefined,
    limit: values.limit ? parseInt(values.limit as string, 10) : 100,
    platform: values.platform as string | undefined,
  });

  if (globalOpts.json) {
    log(JSON.stringify(scores, null, 2));
  } else {
    if (scores.length === 0) {
      log('No Lamina assets found.');
      return;
    }
    log(`\n${'Asset ID'.padEnd(42)} ${'Score'.padEnd(8)} Brief`);
    log('-'.repeat(80));
    for (const s of scores) {
      const score = s.score !== null ? String(s.score) : 'N/A';
      const brief = s.brief ? (s.brief.length > 30 ? `${s.brief.substring(0, 30)}...` : s.brief) : '-';
      log(`${s.assetId.padEnd(42)} ${score.padEnd(8)} ${brief}`);
    }
    log(`\n${scores.length} assets scored.`);
  }
}

async function cmdApps(_args: string[], globalOpts: GlobalOpts) {
  const client = createClientFromArgs(globalOpts);

  const result = await client.lamina.apps.list();
  const apps = result.data ?? [];

  if (globalOpts.json) {
    log(JSON.stringify(apps, null, 2));
  } else {
    if (apps.length === 0) {
      log('No apps available.');
      return;
    }
    log(`\n${'App ID'.padEnd(30)} ${'Name'.padEnd(25)} Description`);
    log('-'.repeat(90));
    for (const app of apps) {
      const desc = app.description ? (app.description.length > 30 ? `${app.description.substring(0, 30)}...` : app.description) : '-';
      log(`${app.appId.padEnd(30)} ${app.name.padEnd(25)} ${desc}`);
    }
    log(`\n${apps.length} apps available.`);
  }
}

async function cmdCredits(_args: string[], globalOpts: GlobalOpts) {
  const client = createClientFromArgs(globalOpts);

  // Use any app to get credit balance from estimate
  const appsResult = await client.lamina.apps.list();
  const firstApp = appsResult.data?.[0];

  if (!firstApp) {
    log('No apps available to check credits.');
    return;
  }

  const estimate = await client.lamina.apps.estimate(firstApp.appId);
  const data = estimate.data;

  if (globalOpts.json) {
    log(JSON.stringify(data, null, 2));
  } else {
    log(`\nCredit balance: ${data.currentBalance}`);
    log(`Est. cost per generation (${firstApp.name}): ${data.estimatedCredits.expected} credits`);
    log(`Affordable: ${data.affordable ? 'Yes' : 'No'}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  // Parse global flags first
  const globalFlagIndices = new Set<number>();
  const globalOpts: GlobalOpts = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--api-key' && args[i + 1]) { globalOpts.apiKey = args[i + 1]; globalFlagIndices.add(i); globalFlagIndices.add(i + 1); i++; }
    else if (args[i] === '--project' && args[i + 1]) { globalOpts.project = args[i + 1]; globalFlagIndices.add(i); globalFlagIndices.add(i + 1); i++; }
    else if (args[i] === '--dataset' && args[i + 1]) { globalOpts.dataset = args[i + 1]; globalFlagIndices.add(i); globalFlagIndices.add(i + 1); i++; }
    else if (args[i] === '--token' && args[i + 1]) { globalOpts.token = args[i + 1]; globalFlagIndices.add(i); globalFlagIndices.add(i + 1); i++; }
    else if (args[i] === '--json') { globalOpts.json = true; globalFlagIndices.add(i); }
    else if (args[i] === '--help' || args[i] === '-h') { printUsage(); process.exit(0); }
  }

  const remaining = args.filter((_, i) => !globalFlagIndices.has(i));
  const command = remaining[0];
  const commandArgs = remaining.slice(1);

  if (!command) {
    printUsage();
    process.exit(0);
  }

  try {
    switch (command) {
      case 'generate':
        await cmdGenerate(commandArgs, globalOpts);
        break;
      case 'fill-document':
        await cmdFillDocument(commandArgs, globalOpts);
        break;
      case 'score':
        await cmdScore(commandArgs, globalOpts);
        break;
      case 'apps':
        await cmdApps(commandArgs, globalOpts);
        break;
      case 'credits':
        await cmdCredits(commandArgs, globalOpts);
        break;
      default:
        die(`Unknown command: ${command}. Run 'sanity-lamina --help' for usage.`);
    }
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}

main();
