# Lamina Video & Image Creator for Sanity

Sanity Studio plugin that lets content editors generate and manage media assets with [Lamina](https://uselamina.ai) directly inside Sanity Studio.

![Lamina Plugin Demo](screenshots/lamina-plugin-demo.gif)

## Features

- **Asset Source** — "Generate with Lamina" appears in every image/file field dropdown. Type a brief, Lamina generates media, click "Use this" to save it as a Sanity asset.
- **Context-Aware Briefs** — Auto-suggests briefs from document title, field name, and schema type. No prompt engineering needed.
- **Aspect Ratio Detection** — Detects target aspect ratio from field name (e.g. `heroImage` → 16:9, `ogImage` → 16:9) and passes it to the API.
- **Studio Tool** — "Lamina" tab in top Studio nav with embedded Lamina editor and a filterable asset browser.
- **Document Actions** — "Edit in Lamina" reopens the original generation run; "Generate all media" fills every empty image/file field on a document in a single pass.
- **From Library** — Reuse previously generated Lamina assets directly from the Generate dialog.
- **Output Presets** — Configure per-field generation presets (aspect ratio, modality, platform) via plugin config.
- **Batch Generation** — Generate 2–5 variants at once with the "Generate variants" toggle.
- **App Picker** — Browse or auto-match Lamina apps before generating, with credit cost estimates.
- **Smart History** — Recently used briefs appear as suggestion chips. App selections are remembered per field.
- **Quality Feedback** — Rate outputs after saving to improve future generation quality.
- **Brand & Campaign** — Apply brand profiles and campaign context to keep outputs on-brand.
- **Per-Editor OAuth** *(optional)* — Each editor authorises individually instead of sharing a workspace API key. The plugin self-registers with Lamina on first sign-in — no manual setup needed.

## Installation

```bash
npm install sanity-plugin-lamina
```

## Quick start (API key — recommended)

1. Sign up at [app.uselamina.ai](https://app.uselamina.ai) (or log in to an existing workspace).
2. **Workspace settings → API Keys → Create API Key.** Leave the scope at the default (`workflow`) — it's the right one for the plugin.
3. Copy the `lma_…` value.
4. In your Sanity Studio:

   ```ts
   // sanity.config.ts
   import {defineConfig} from 'sanity'
   import {laminaPlugin} from 'sanity-plugin-lamina'

   export default defineConfig({
     // ...your project config
     plugins: [
       laminaPlugin({
         apiKey: process.env.SANITY_STUDIO_LAMINA_API_KEY!,
       }),
     ],
   })
   ```

5. Add the key to `.env.development` (and your hosting platform's env for prod):

   ```
   SANITY_STUDIO_LAMINA_API_KEY=lma_…
   ```

6. `npm run dev` — open any image or file field. "Generate with Lamina ✨" appears in the upload dropdown.

> **Note for multi-environment teams:** the same API key works across local, staging, and production. Use one key per workspace, set in each environment's env vars.

## Configuration options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | — | Lamina API key (team-level). Required unless `oauth` is configured. |
| `baseUrl` | `string` | `https://app.uselamina.ai` | Lamina API base URL. Override for self-hosted instances. |
| `oauth` | `LaminaOAuthConfig` | — | Per-editor OAuth instead of a shared API key. See [Advanced: per-editor authentication](#advanced-per-editor-authentication) below. |
| `enableTool` | `boolean` | `true` | Register the "Lamina" tab in the Studio top nav. |
| `enableDocumentAction` | `boolean` | `true` | Register "Edit in Lamina" + "Generate all media" document actions. |
| `webhookUrl` | `string` | — | Webhook URL for generation completion events (alternative to polling). |
| `presets` | `Record<string, LaminaPreset>` | — | Per-field-name generation hints (aspect ratio, modality, platform). |

## How it works

### Asset Source (Generate Dialog)

1. Click "Generate with Lamina" in any image or file field
2. Describe what you need in the brief field (auto-filled from schema context)
3. Optionally pick a specific Lamina app or let auto-detect choose
4. Click Generate — the plugin calls `content.create()` and polls until done
5. Preview generated outputs and click "Use this" to save as a Sanity asset

Saved assets are tagged with `source.name: 'lamina'` and include the run ID and URL for traceability.

### Studio Tool

The "Lamina" tab in the top nav provides:

- **Editor** — Embedded Lamina editor via iframe. Assets generated here are sent back into Sanity via a postMessage bridge.
- **Assets browser** — All Lamina-generated assets in your dataset with thumbnails, filenames, and run links. Filter by type (images/videos), search by filename, scroll to load more.

### Document actions

- **Edit in Lamina** — Detects Lamina-sourced assets on the current document (at any nesting depth) and opens the original run for editing.
- **Generate all media** — Scans for empty image/file fields and runs schema-aware generations for each in parallel.

## Advanced: per-editor authentication

Use OAuth when you want each editor to authorise individually instead of sharing one workspace API key. Common reasons:

- Per-editor audit trails on generation history
- Revoke one editor's access without rotating the team key
- Compliance teams that don't allow shared service credentials

```ts
laminaPlugin({
  oauth: {},
})
```

That's it — every field on `oauth` is optional. `clientId` is filled in by the plugin self-registering with Lamina on first sign-in (cached in localStorage). `redirectUri` defaults to `https://app.uselamina.ai/oauth/callback`, which is the page that posts the auth code back to your Studio popup.

You only need to set anything inside `oauth: { ... }` in two niche cases:

- `clientId` — if the Lamina ops team has pre-provisioned a client_id for you (compliance / audit-trail reasons).
- `redirectUri` — only if you self-host the Lamina backend at a different domain. Don't point this at your Studio's own origin — there's no callback page there, and the popup would have nowhere to land.

What changes for editors:

- A "Sign in with Lamina" button appears the first time they open the Studio.
- Clicking it opens a popup → consent screen on Lamina → on approve, the popup closes and the plugin stores per-user tokens in `localStorage`.
- The plugin silently refreshes tokens before they expire (every ~4 minutes the plugin checks; refresh kicks in 5 min before access-token expiry).
- After 30 days of no activity, the user re-authorises.

If you want both options available — fall back to OAuth when no API key is configured — pass both:

```ts
laminaPlugin({
  apiKey: process.env.SANITY_STUDIO_LAMINA_API_KEY,
  oauth: {},
})
```

> **First-run registration:** On the first "Sign in with Lamina" click, the plugin POSTs to `/oauth/register` with the Studio's redirect URI. Lamina returns a fresh `client_id` which is cached locally. No manual coordination with the Lamina team needed.

## Development

```bash
npm install
npm run build     # tsc -> dist/
npm run dev       # tsc --watch
```

### Local testing against a Studio

```bash
# In this repo:
npm run build

# In a Sanity Studio project (e.g. lamina-cms):
npm i ../sanity-plugin-lamina   # or `npm link` for live edits
```

## Architecture

```
src/
  index.ts                          # Public exports
  plugin.tsx                        # definePlugin — registers all surfaces
  types.ts                          # LaminaPluginOptions, LaminaOAuthConfig, GenerationState
  lib/
    LaminaContext.tsx               # React context, OAuth login UI, refresh wiring
    oauth.ts                        # Token storage, refresh, dynamic client registration
    schemaContext.ts                # Schema-aware brief enrichment
    briefEnhancer.ts                # /v1/content/brief integration
    useTypeahead.ts                 # Debounced brief typeahead
    aspectRatio.ts                  # Field-name → aspect-ratio detection
    appRouting.ts                   # Per-field app preferences (localStorage)
    recentBriefs.ts                 # Recent-briefs history (localStorage)
    documentContext.ts              # Last-viewed-document store for postMessage
    useLaminaAssets.ts              # GROQ helper to query Lamina-sourced assets
  components/
    LaminaAssetSource.tsx           # AssetSource definition
    GenerateDialog.tsx              # Generation UI with app picker + multi-select
    LaminaFieldAction.tsx           # Field-level action button
    AssetPickerGrid.tsx             # Filterable grid of past Lamina assets
  tool/
    LaminaTool.tsx                  # Embedded Studio tool (iframe + postMessage)
  actions/
    regenerateAction.tsx            # "Edit in Lamina" document action
    generateAllAction.tsx           # "Generate all media" bulk action
```

## License

MIT — see [LICENSE](./LICENSE).
