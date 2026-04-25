# Lamina Video & Image Creator for Sanity

Sanity Studio plugin that lets content editors generate and manage media assets with [Lamina](https://uselamina.ai) directly inside Sanity Studio.

## What you can generate

![Product Shoots](https://cdn.sanity.io/images/nxxnxyyr/production/20a6d32531d3b2a5d9cbdd20e5dcd50fe49964d5-1024x1024.jpg?auto=format&fit=max&q=75&w=400)
![Ad Variants](https://cdn.sanity.io/images/nxxnxyyr/production/81940a40ac0879d7d10322b523ce5a2b30eba305-800x1000.jpg?auto=format&fit=max&q=75&w=400)
![Virtual Try-On](https://cdn.sanity.io/images/nxxnxyyr/production/65eea9de797a81786ff7c6fab8b08f08a7865c61-800x1000.jpg?auto=format&fit=max&q=75&w=400)
![Instagram Reels](https://cdn.sanity.io/images/nxxnxyyr/production/38d98d8dca4b633d8135de9c8ee64e2eccfa348d-1080x1920.jpg?auto=format&fit=max&q=75&w=200)

![Campaign Banners](https://cdn.sanity.io/images/nxxnxyyr/production/942f807749bcd6ecbdbfef611c30b78da01dfc1a-1920x1080.jpg?auto=format&fit=max&q=75&w=400)
![Brand Films](https://cdn.sanity.io/images/nxxnxyyr/production/0a68f5d0169cb18a0dd299afeb635e331adc60c9-1920x1080.jpg?auto=format&fit=max&q=75&w=400)

*Product shoots, ad variants, virtual try-ons, reels, campaign banners, brand films -- all generated from a brief.*

## Features

- **Asset Source** -- "Generate with Lamina" appears in every image/file field dropdown. Type a brief, Lamina generates media, click "Use this" to save it as a Sanity asset.
- **Studio Tool** -- "Lamina" tab in top Studio nav with embedded Lamina editor and an asset browser showing all Lamina-generated assets in your dataset.
- **Document Action** -- "Edit in Lamina" appears in the document action bar for documents with Lamina-sourced assets.
- **Field-Level Button** -- "Edit in Lamina" button appears directly on image/file fields that have Lamina source metadata.
- **App Picker** -- Browse or AI-match Lamina apps before generating, with credit cost estimates.
- **Dynamic Inputs** -- When an app needs additional parameters, the dialog renders input fields automatically.
- **Multi-Select** -- Select multiple generated outputs at once when the field supports it.
- **OAuth Support** -- Optional per-user authentication alongside team-level API keys.

## Installation

```bash
npm install sanity-plugin-lamina
```

## Configuration

```ts
// sanity.config.ts
import { defineConfig } from 'sanity'
import { laminaPlugin } from 'sanity-plugin-lamina'

export default defineConfig({
  // ...your config
  plugins: [
    laminaPlugin({
      apiKey: process.env.SANITY_STUDIO_LAMINA_API_KEY!,
    }),
  ],
})
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | -- | Lamina API key (team-level). Required unless OAuth is configured. |
| `baseUrl` | `string` | `https://app.uselamina.ai` | Lamina API base URL. |
| `oauth` | `{ clientId, redirectUri?, storageKey? }` | -- | OAuth config for per-user authentication. |
| `enableTool` | `boolean` | `true` | Register the Lamina Editor as a Studio tool. |
| `enableDocumentAction` | `boolean` | `true` | Register the "Edit in Lamina" document action. |
| `webhookUrl` | `string` | -- | Webhook URL for generation completion events (alternative to polling). |

### OAuth Configuration

For per-user authentication instead of (or alongside) a team API key:

```ts
laminaPlugin({
  oauth: {
    clientId: 'your-lamina-oauth-client-id',
    redirectUri: 'https://your-studio.sanity.studio/lamina/callback', // optional
  },
})
```

Users without a team API key will see a "Sign in with Lamina" button.

## How It Works

### Asset Source (Generate Dialog)

1. Click "Generate with Lamina" in any image or file field
2. Describe what you need in the brief field
3. Optionally select a specific Lamina app or let auto-detect choose
4. Click Generate -- the plugin calls `content.create()` and polls for completion
5. Preview generated outputs and click "Use this" to save as a Sanity asset

Generated assets are tagged with `source.name: 'lamina'` and include the run ID and URL for traceability.

### Studio Tool

The Lamina tab in the top nav provides:

- **Editor tab** -- Embedded Lamina editor via iframe. Assets generated here are automatically saved to Sanity via postMessage bridge.
- **Assets tab** -- Browse all Lamina-generated assets in your Sanity dataset with thumbnails, filenames, and links to the original Lamina run.

### Document Action

The "Edit in Lamina" action uses schema-aware discovery to find all image/file fields in a document (at any nesting depth), checks if their assets have Lamina source metadata, and opens the original run for editing.

## Development

```bash
npm install
npm run build     # tsc -> dist/
npm run dev       # tsc --watch
```

### Local Testing

```bash
# In this repo:
npm run dev

# In a Sanity Studio project:
# Add to package.json: "sanity-plugin-lamina": "file:../sanity-lamina"
# Then add to sanity.config.ts as shown above
```

## Architecture

```
src/
  index.ts                          # Public exports
  plugin.tsx                        # definePlugin -- registers all surfaces
  types.ts                          # Plugin options, generation state types
  lib/
    LaminaContext.tsx                # React context + OAuth login flow
    oauth.ts                        # OAuth token management utilities
  components/
    LaminaAssetSource.tsx           # Asset source definition
    GenerateDialog.tsx              # Generation UI with app picker + multi-select
    LaminaFieldAction.tsx           # Field-level "Edit in Lamina" button
  tool/
    LaminaTool.tsx                  # Studio tool with editor + asset browser tabs
  actions/
    regenerateAction.tsx            # Schema-aware document action
```

## License

MIT -- see [LICENSE](./LICENSE).
