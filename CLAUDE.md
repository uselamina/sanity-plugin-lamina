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

## What's implemented (v0.1.0)

- [x] Package scaffold with TypeScript, builds cleanly
- [x] `laminaPlugin()` with `definePlugin` — registers asset source, tool, document action
- [x] `LaminaProvider` / `useLamina()` React context for SDK client
- [x] `GenerateDialog` — brief input, modality selector, generate button, polling progress, output preview grid, "Use this" button
- [x] `LaminaAssetSource` — registered for both `form.image` and `form.file`
- [x] `LaminaTool` — iframe embed with postMessage listener, save-to-Sanity flow, "Open in new tab" fallback
- [x] `regenerateAction` — detects Lamina assets, opens run URL

## What needs work

### Critical (must fix before first real use)

1. **`/embed` route on Lamina side** — `LaminaTool` loads `{baseUrl}/embed?token=...` which doesn't exist yet. Need to add a chromeless (no sidebar/nav) render of the Lamina editor at this route in the main Lamina app (`cirbuk/react-flow-integration`). The iframe should be able to receive the API token via URL param or postMessage handshake.

2. **postMessage protocol on Lamina side** — The Lamina editor needs to emit `lamina:asset-ready` messages when a user finishes a generation and wants to send it to Sanity. Shape: `{ type: 'lamina:asset-ready', url, runId, mediaType, filename }`. This must be implemented in the Lamina React app.

3. **CORS on `cdn.uselamina.ai`** — The asset source uses `kind: 'url'` which means Sanity Studio fetches the URL client-side to upload it. The CDN must respond with `Access-Control-Allow-Origin: *` (or at least allow the Studio host).

4. **Document action: generic asset discovery** — `regenerateAction.tsx` currently hardcodes field names (`mainImage`, `image`, `file`, `poster`, etc.) in the GROQ query. This should be replaced with a schema-aware approach that walks the document's schema to find all image/file fields, then resolves their asset references. Use `useSchema()` from Sanity to get the schema at runtime.

### Important improvements

5. **needsInput handling in GenerateDialog** — When `content.create()` returns `needsInput` (the selected app requires parameters the brief didn't cover), the dialog just shows an error message. It should render dynamic input fields based on `needsInput.missing[]` (each has `name`, `type`, `description`, `accept`). The `Parameter` type from `@uselamina/sdk` describes these.

6. **App picker** — Before generating, let users optionally browse/select a specific Lamina app via `client.apps.list()` or `client.apps.discover()`. Show app name, description, capabilities. Pass `appId` to `content.create()`.

7. **Re-generation dialog** — Instead of just opening the run URL in a new tab, the "Edit in Lamina" action should open a dialog that shows the original brief and outputs, lets the user modify the brief, and re-generates in place. Query the original run via `client.runs.get(runId)` to get context.

8. **Multiple output selection** — When `selectionType === 'multiple'`, let users select several outputs at once and return them all via `onSelect()`.

9. **Error states and edge cases** — Add proper error UI for: invalid/expired API key, rate limiting (429), network failures, timeout after 30 minutes of polling. The SDK throws `LaminaAuthError` and `LaminaRateLimitError` which should be caught and shown with specific messages.

10. **Credit balance display** — Before generating, call `client.apps.estimate(appId)` if an app is selected, and show estimated credit cost + current balance. Warn if the balance is insufficient (`affordable: false`).

### Nice to have

11. **OAuth per-user auth** — The `LaminaPluginOptions.oauth` field is defined in types but not implemented. Would need: OAuth redirect flow, token storage (localStorage or Sanity user metadata), token refresh. Lamina has MCP OAuth infra (`mcpOAuthService.ts`) that can be extended.

12. **Asset browser in Studio Tool** — Add a tab/panel in `LaminaTool` that shows previously generated Lamina assets in the Sanity dataset (query for assets where `source.name === 'lamina'`).

13. **Sanity field-level "Edit in Lamina" button** — Register a custom input component (or field action) that shows an "Edit in Lamina" icon button directly on image fields that have Lamina source metadata. More discoverable than the document action.

14. **Webhook-based completion** — Instead of polling `runs.wait()`, support webhook delivery for faster notification. Would need the Studio or a backend to expose a webhook endpoint.

15. **`@sanity/plugin-kit` migration** — For publishing to npm and Sanity Exchange, scaffold with `npx @sanity/plugin-kit init` for proper bundling (CJS + ESM), semantic-release, and testing setup.

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
