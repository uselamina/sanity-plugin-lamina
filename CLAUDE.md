# sanity-plugin-lamina

Sanity Studio plugin that lets content editors generate and manage media assets with Lamina directly inside Sanity Studio.

**GitHub issue:** cirbuk/react-flow-integration#807

## What this plugin does

Three Sanity Studio extension points:

1. **Asset Source** — "Generate with Lamina" appears in every image/file field dropdown. User types a brief, Lamina generates media, user clicks "Use this" to save it as a Sanity asset.
2. **Studio Tool** — "Lamina" tab in top Studio nav. Embeds the full Lamina editor via iframe. Outputs are saved back to Sanity via postMessage bridge.
3. **Document Action** — "Edit in Lamina" appears in the document action bar. Detects Lamina-sourced assets (via `source.name === 'lamina'` metadata) and opens the original run for editing.

## Architecture

```
src/
├── index.ts                          # Public exports
├── plugin.tsx                        # definePlugin entry — registers all 3 surfaces
├── types.ts                          # LaminaPluginOptions, GenerationState, GeneratedOutput
├── lib/
│   └── LaminaContext.tsx             # React context providing LaminaClient from @uselamina/sdk
├── components/
│   ├── LaminaAssetSource.tsx         # AssetSource definition { name, title, icon, component }
│   └── GenerateDialog.tsx            # The generation UI: brief → generate → poll → preview → select
├── tool/
│   └── LaminaTool.tsx               # Studio tool: iframe embed + postMessage bridge + save-to-Sanity
└── actions/
    └── regenerateAction.tsx          # Document action: finds Lamina assets, opens run URL
```

## Key dependencies

- `@uselamina/sdk` — Lamina TypeScript SDK. Provides `LaminaClient` with `.content.create()`, `.runs.wait()`, `.apps.discover()`.
- `sanity` — Sanity Studio v3+ APIs: `definePlugin`, `AssetSource`, `DocumentActionComponent`, `useClient`.
- `@sanity/ui` — UI components (Dialog, Card, Button, etc.) for native Sanity look.
- `@sanity/icons` — Icon set for buttons and nav.

## How the SDK is used

The plugin wraps `@uselamina/sdk` in a React context (`LaminaProvider` / `useLamina()`). The SDK client is created once from the `apiKey` option and shared across all surfaces.

### Generation flow (GenerateDialog)

```
1. client.content.create({ brief, modality })     → returns { runId, selectedApp, ... }
2. client.runs.wait(runId, { onPoll })             → polls every 3s until completed/failed
3. Map ExecutionOutput[] → GeneratedOutput[]        → extract url, type, dimensions
4. User clicks "Use this" → onSelect([{ kind: 'url', value: cdnUrl, assetDocumentProps }])
```

The `assetDocumentProps.source` field stores `{ name: 'lamina', id: runId, url: runUrl }` so assets are traceable.

### Studio Tool (LaminaTool)

Embeds `{baseUrl}/embed?token={apiKey}` in an iframe. Listens for `postMessage` events:

- `lamina:asset-ready` — fetches the URL as a blob, uploads to Sanity via `client.assets.upload()`
- `lamina:editor-close` — no-op currently

### Document Action (regenerateAction)

Queries the document for asset references with `source.name === 'lamina'`, then opens the run URL in a new tab. Currently uses a hardcoded list of common field names for the GROQ query.

## Lamina API reference

Base URL: `https://app.uselamina.ai`
Auth: `x-api-key` header (SDK handles this)

| Endpoint | SDK method | Purpose |
|---|---|---|
| `POST /v1/content/create` | `client.content.create(params)` | Start generation from a brief |
| `GET /v1/runs/:runId` | `client.runs.get(runId)` | Check run status |
| `POST /v1/apps/:appId/runs` | `client.runs.run(appId, params)` | Run a specific app directly |
| `GET /v1/apps` | `client.apps.list()` | List available apps |
| `POST /v1/apps/discover` | `client.apps.discover({ intent })` | AI-powered app matching |

Key types from `@uselamina/sdk`:
- `LaminaCreateParams` — `{ brief, platform?, modality?, appId?, inputs?, autoQuality? }`
- `LaminaCreateResult` — `{ runId, workflowId, workflowName, selectedApp, needsInput? }`
- `ExecutionStatus` — `{ runId, status, outputs[], errorMessage, quality? }`
- `ExecutionOutput` — `{ id, type, value, mimeType, dimensions?, durationSeconds? }`

## What's implemented

- [x] Package scaffold with TypeScript, builds cleanly
- [x] `laminaPlugin()` with `definePlugin` — registers all surfaces
- [x] `LaminaProvider` / `useLamina()` React context with OAuth fallback
- [x] `GenerateDialog` — brief, modality, app picker, generate, poll, preview, select
- [x] `GenerateDialog` — needsInput handling with dynamic form fields
- [x] `GenerateDialog` — app picker with `apps.list()` and `apps.discover()`
- [x] `GenerateDialog` — credit balance display with cost estimates
- [x] `GenerateDialog` — multi-select support when `selectionType === 'multiple'`
- [x] `GenerateDialog` — error handling for auth, rate limit, network, timeout
- [x] `LaminaAssetSource` — registered for both `form.image` and `form.file`
- [x] `LaminaTool` — Editor tab (iframe embed + postMessage bridge) + Assets tab (asset browser)
- [x] `LaminaTool` — granular error handling for CORS/fetch and upload failures
- [x] `regenerateAction` — schema-aware asset discovery + batch source query
- [x] `LaminaImageInput` — field-level "Edit in Lamina" button on image/file fields
- [x] OAuth per-user auth — token storage, exchange, refresh, login UI
- [x] Webhook URL support via `webhookUrl` plugin option
- [x] README.md and LICENSE for npm/Sanity Exchange publishing
- [x] PostMessage auth handshake — iframe loads `/embed` without token, credentials sent via `lamina:auth` message after `lamina:embed-ready`
- [x] OAuth token preference — postMessage handshake uses OAuth token when available, falls back to API key
- [x] Document context via postMessage — sends `lamina:context` with schema type, field type, brand profile, modality after auth
- [x] Brand profile and campaign selection — GenerateDialog fetches `/v1/brand-profiles` and `/v1/campaigns`, passes to `content.create()`
- [x] Batch generation UI — "Generate variants" toggle with count (2-5), runs parallel `content.create()` calls
- [x] Webhook passthrough — passes `webhookUrl` to `runs.run()` when configured
- [x] Video preview in asset browser — `<video>` element with autoplay loop for `video/*` assets
- [x] Asset browser filtering — type filter (All/Images/Videos), filename search, cursor-based pagination with infinite scroll

## Lamina-side dependencies (in progress in cirbuk/react-flow-integration)

1. `/embed` route for Studio Tool iframe
2. `postMessage` protocol (`lamina:embed-ready`, `lamina:auth`, `lamina:context`, `lamina:asset-ready`, `lamina:editor-close`)
3. CORS on `cdn.uselamina.ai` for client-side asset fetch

## Build & test

```bash
npm install
npm run build     # tsc → dist/
npm run dev       # tsc --watch
```

To test in a Sanity Studio locally:
```bash
# In this repo:
npm run dev

# In a Sanity Studio project:
# Add to package.json: "sanity-plugin-lamina": "file:../sanity-lamina"
# Then in sanity.config.ts:
# import { laminaPlugin } from 'sanity-plugin-lamina'
# plugins: [laminaPlugin({ apiKey: process.env.SANITY_STUDIO_LAMINA_API_KEY })]
```

## Conventions

- All Sanity UI must use `@sanity/ui` components (not raw HTML or other UI libs) to match Studio look.
- Use `@sanity/icons` for all icons.
- Follow existing Sanity plugin patterns: `definePlugin`, callback-style `assetSources` (to append, not replace), `useClient` for Sanity API calls.
- TypeScript strict mode. No `any` except where Sanity's own types force it (asset source component prop forwarding).
- File extensions: `.js` in imports (NodeNext module resolution).
- The plugin must work with Sanity Studio v3+ and React 18/19.
