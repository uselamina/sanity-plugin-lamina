# Lamina for Sanity

Generate and manage media assets with [Lamina](https://uselamina.ai) in Sanity -- as a Studio UI plugin, a headless Node.js API, a CLI tool, or a webhook-driven automation.

```bash
npm install sanity-plugin-lamina
```

## Two modes, one package

| Mode | Import | Requires React? | Use case |
|------|--------|-----------------|----------|
| **Studio plugin** | `sanity-plugin-lamina` | Yes | Editors generating media inside Sanity Studio |
| **Headless API** | `sanity-plugin-lamina/headless` | No | Scripts, pipelines, migrations, serverless functions |
| **Webhook handler** | `sanity-plugin-lamina/webhooks` | No | Auto-generate media on document events |
| **CLI** | `npx sanity-lamina` | No | Terminal-based bulk generation and scoring |

---

## Table of contents

- [Studio plugin](#studio-plugin)
  - [Quick start](#quick-start)
  - [Configuration options](#configuration-options)
  - [Asset source (Generate Dialog)](#asset-source)
  - [Prompt intelligence](#prompt-intelligence)
  - [Studio tool](#studio-tool)
  - [Document actions](#document-actions)
  - [Field-level input](#field-level-input)
  - [OAuth](#oauth)
- [Headless API](#headless-api)
  - [Setup](#headless-setup)
  - [Generate for a document](#generate-for-a-document)
  - [Bulk fill empty media](#bulk-fill-empty-media)
  - [Standalone generation](#standalone-generation)
  - [Upload to Sanity](#upload-to-sanity)
  - [Score assets](#score-assets)
  - [Intelligence API](#intelligence-api)
- [CLI reference](#cli-reference)
  - [generate](#cli-generate)
  - [fill-document](#cli-fill-document)
  - [score](#cli-score)
  - [apps](#cli-apps)
  - [credits](#cli-credits)
- [Webhook handler](#webhook-handler)
  - [Setup with Vercel](#webhook-vercel)
  - [Trigger configuration](#webhook-triggers)
  - [Template syntax](#template-syntax)
- [Recipes](#recipes)
  - [Content migration with media generation](#recipe-migration)
  - [CI pipeline: generate on publish](#recipe-ci)
  - [Multi-brand content generation](#recipe-multi-brand)
  - [Quality gate: score before publish](#recipe-quality-gate)
- [Architecture](#architecture)
- [Development](#development)
- [License](#license)

---

## Studio plugin

### Quick start

```ts
// sanity.config.ts
import { defineConfig } from 'sanity'
import { laminaPlugin } from 'sanity-plugin-lamina'

export default defineConfig({
  plugins: [
    laminaPlugin({
      apiKey: process.env.SANITY_STUDIO_LAMINA_API_KEY!,
    }),
  ],
})
```

This registers three surfaces in your Studio:

1. **Asset source** -- "Generate with Lamina" in every image/file field picker
2. **Studio tool** -- "Lamina" tab in the top nav with embedded editor + asset browser
3. **Document actions** -- "Edit in Lamina" and "Generate all media" in the action bar

### Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | -- | Lamina API key (team-level). Required unless OAuth is configured. |
| `baseUrl` | `string` | `https://app.uselamina.ai` | Lamina API base URL. |
| `oauth` | `{ clientId, redirectUri?, storageKey? }` | -- | OAuth config for per-user authentication. |
| `enableTool` | `boolean` | `true` | Register the Lamina Editor as a Studio tool. |
| `enableDocumentAction` | `boolean` | `true` | Register document actions. |
| `webhookUrl` | `string` | -- | Webhook URL for generation completion events. |
| `presets` | `Record<string, LaminaPreset>` | Built-in defaults | Per-field generation presets. |

#### Presets

Map field names to generation parameters. Custom presets override the built-in defaults (`ogImage`, `socialImage`, `storyImage`, `thumbnail`, `avatar`).

```ts
laminaPlugin({
  apiKey: '...',
  presets: {
    heroImage: { aspectRatio: '16:9', modality: 'image' },
    productVideo: { aspectRatio: '9:16', modality: 'video', platform: 'instagram' },
    logo: { aspectRatio: '1:1', modality: 'image', appId: 'app_logo_generator' },
  },
})
```

### Asset source

Click "Generate with Lamina" in any image or file field to open the Generate Dialog:

1. **Describe what you need** -- type a brief or pick from AI suggestions
2. **Select output type** -- image, video, or auto-detect
3. **Optionally pick an app** -- browse or AI-match Lamina apps with cost estimates
4. **Generate** -- the plugin calls the Lamina API and shows real-time progress
5. **Use this** -- saves the output as a Sanity asset with Lamina source metadata

The "From library" tab lets you reuse previously generated Lamina assets with search, type filtering, and document-scoped views.

### Prompt intelligence

The Generate Dialog includes three intelligence features that improve prompt quality:

**Auto-enhance brief** -- An "Enhance brief" toggle (on by default) rewrites your rough prompt into an optimized generation prompt before sending it to the API. Shows a preview of the enhanced version during generation.

**Typeahead suggestions** -- As you type (8+ characters), debounced suggestions appear as clickable chips below the textarea. Cached per context to avoid redundant API calls.

**Schema-aware templates** -- Reads your Sanity schema at runtime via `useSchema()` to generate context-rich prompts. If your schema has field descriptions, sibling fields like `category` or `tags`, or validation rules, the plugin uses them to build better prompts automatically.

### Studio tool

The "Lamina" tab in the top nav provides:

- **Editor** -- Embedded Lamina editor via iframe. Assets generated here are saved to Sanity via postMessage bridge.
- **Assets** -- Browse all Lamina-generated assets with thumbnails, search, type filtering, and infinite scroll.

### Document actions

**Edit in Lamina** -- Finds all image/file fields with Lamina source metadata and opens the original run for editing.

**Generate all media** -- Scans the document for empty image/file fields, builds contextual briefs for each, and runs parallel generations. Presents a 3-phase workflow:

1. **Review** -- Editable briefs per field, auto-generated from schema context
2. **Generate** -- Parallel generation with per-field progress indicators
3. **Results** -- Approve/reject per field, then save approved assets to the document

### Field-level input

Every image/file field gets an inline "Edit in Lamina" button that detects Lamina-sourced assets and opens the original run.

### OAuth

For per-user authentication instead of (or alongside) a team API key:

```ts
laminaPlugin({
  oauth: {
    clientId: 'your-lamina-oauth-client-id',
    redirectUri: 'https://your-studio.sanity.studio/lamina/callback',
  },
})
```

Users without a team API key see a "Sign in with Lamina" button.

---

## Headless API

The headless API wraps `@uselamina/sdk` and `@sanity/client` into high-level operations for programmatic content generation. No React or browser required.

<a id="headless-setup"></a>

### Setup

```ts
import { createLaminaSanityClient } from 'sanity-plugin-lamina/headless'

const lamina = createLaminaSanityClient({
  laminaApiKey: process.env.LAMINA_API_KEY,
  sanityProjectId: 'your-project-id',
  sanityDataset: 'production',
  sanityToken: process.env.SANITY_TOKEN,
})
```

Or pass a pre-configured Sanity client:

```ts
import { createClient } from '@sanity/client'
import { createLaminaSanityClient } from 'sanity-plugin-lamina/headless'

const sanityClient = createClient({
  projectId: 'abc123',
  dataset: 'production',
  token: process.env.SANITY_TOKEN,
  apiVersion: '2024-01-01',
  useCdn: false,
})

const lamina = createLaminaSanityClient({
  laminaApiKey: process.env.LAMINA_API_KEY,
  sanityClient,
})
```

#### Configuration

| Option | Env var fallback | Description |
|--------|-----------------|-------------|
| `laminaApiKey` | `LAMINA_API_KEY` | Lamina API key |
| `laminaBaseUrl` | -- | API base URL (default: `https://app.uselamina.ai`) |
| `sanityProjectId` | `SANITY_PROJECT_ID` | Sanity project ID |
| `sanityDataset` | `SANITY_DATASET` | Dataset (default: `production`) |
| `sanityToken` | `SANITY_TOKEN` | Sanity API token with write access |
| `sanityClient` | -- | Pre-configured `@sanity/client` instance |
| `defaultBrandProfileId` | -- | Default brand profile for all generations |
| `defaultCampaignId` | -- | Default campaign for all generations |
| `webhookUrl` | -- | Webhook URL for completion notifications |

### Generate for a document

The highest-level operation. Generates media for a specific field on a document, uploads to Sanity, and patches the document -- all in one call.

```ts
const result = await lamina.generateForDocument('product-123', 'heroImage', {
  brief: 'Lifestyle product photo on marble surface',
  // Optional overrides:
  modality: 'image',
  aspectRatio: '16:9',
  brandProfileId: 'bp_123',
})

console.log(result.sanityAssetId)  // 'image-abc123-1200x630-png'
console.log(result.patched)        // true
console.log(result.finalBrief)     // The enhanced brief that was actually sent
```

If you omit the `brief`, one is auto-generated from the document's title, type, and field name.

### Bulk fill empty media

The workhorse for content operations at scale. Finds documents via GROQ, identifies empty media fields, generates assets, and patches documents.

```ts
const result = await lamina.fillEmptyMedia({
  query: '*[_type == "product" && !defined(mainImage)]{ _id, _type, title, mainImage, category }',
  fieldMapping: {
    mainImage: 'Product photo of {{title}}, {{category}} category',
  },
  concurrency: 5,
  enhance: true,
  brandProfileId: 'bp_123',
  onProgress: (event) => {
    console.log(`${event.documentId} / ${event.fieldName}: ${event.status}`)
  },
})

console.log(`${result.fieldsGenerated} generated, ${result.fieldsFailed} failed`)
```

#### Dry run

Preview what would happen without generating or patching:

```ts
const result = await lamina.fillEmptyMedia({
  query: '*[_type == "product" && !defined(mainImage)]',
  fieldMapping: { mainImage: 'Product photo: {{title}}' },
  dryRun: true,
})

for (const doc of result.results) {
  for (const field of doc.fields) {
    console.log(`Would generate: ${field.brief}`)
  }
}
```

### Standalone generation

Generate content without uploading to Sanity. Useful for previewing, testing, or custom upload flows.

```ts
const result = await lamina.generate({
  brief: 'Social media banner for summer sale',
  modality: 'image',
  aspectRatio: '16:9',
  enhance: true,
})

for (const output of result.outputs) {
  console.log(`${output.type}: ${output.url} (${output.dimensions?.width}x${output.dimensions?.height})`)
}
```

### Upload to Sanity

Upload a URL to Sanity as an asset and optionally patch a document field.

```ts
const uploaded = await lamina.uploadToSanity({
  url: 'https://cdn.uselamina.ai/outputs/abc123.png',
  type: 'image',
  filename: 'hero-image',
  description: 'Product lifestyle photo',
  documentId: 'product-123',
  fieldName: 'heroImage',
})

console.log(uploaded.assetId)  // 'image-abc123-...'
console.log(uploaded.patched)  // true
```

### Score assets

Score existing Lamina-generated assets for quality and relevance.

```ts
const scores = await lamina.scoreAssets({
  query: '*[_type == "sanity.imageAsset" && source.name == "lamina"][0..49]{ _id, url, description }',
  platform: 'instagram',
})

for (const s of scores) {
  console.log(`${s.assetId}: score ${s.score} — "${s.brief}"`)
}
```

### Intelligence API

Access Lamina's intelligence features programmatically.

```ts
// Content trends
const trends = await lamina.intelligence.trends({
  category: 'fashion',
  platform: 'instagram',
  windowDays: 30,
})

// Performance prediction
const prediction = await lamina.intelligence.predict({
  concept: 'Minimalist product flat-lay with neutral tones',
  platform: 'instagram',
  modality: 'image',
})

// AI recommendations
const recs = await lamina.intelligence.recommendations({
  brandProfileId: 'bp_123',
  platform: 'instagram',
  limit: 5,
})

// Brand context
const brand = await lamina.intelligence.getBrandContext('bp_123')
```

### Accessing underlying clients

For advanced use cases, access the raw SDK clients directly:

```ts
// Lamina SDK client
const apps = await lamina.lamina.apps.list()

// Sanity client
const docs = await lamina.sanity.fetch('*[_type == "product"][0..9]')
```

---

## CLI reference

```bash
npx sanity-lamina --help
```

All commands read configuration from environment variables or CLI flags:

| Flag | Env var | Description |
|------|---------|-------------|
| `--api-key` | `LAMINA_API_KEY` | Lamina API key |
| `--project` | `SANITY_PROJECT_ID` | Sanity project ID |
| `--dataset` | `SANITY_DATASET` | Sanity dataset (default: `production`) |
| `--token` | `SANITY_TOKEN` | Sanity API token |
| `--json` | -- | Output as JSON (for piping) |

<a id="cli-generate"></a>

### `generate`

Bulk generate media for documents matching a GROQ query.

```bash
npx sanity-lamina generate \
  --query '*[_type == "product" && !defined(heroImage)]' \
  --field heroImage \
  --brief 'Product lifestyle photo for {{title}}' \
  --concurrency 5

# Dry run -- see what would be generated
npx sanity-lamina generate \
  --query '*[_type == "product" && !defined(heroImage)]' \
  --field heroImage \
  --brief 'Product photo: {{title}}' \
  --dry-run

# With brand profile
npx sanity-lamina generate \
  --query '*[_type == "blogPost" && !defined(coverImage)]' \
  --field coverImage \
  --brief 'Blog cover: {{title}}' \
  --brand-profile bp_123
```

<a id="cli-fill-document"></a>

### `fill-document`

Fill all empty media fields on a single document.

```bash
npx sanity-lamina fill-document product-123
npx sanity-lamina fill-document product-123 --brand-profile bp_123 --no-enhance
```

<a id="cli-score"></a>

### `score`

Score existing Lamina-generated assets.

```bash
npx sanity-lamina score
npx sanity-lamina score --limit 50 --platform instagram
npx sanity-lamina score --json | jq '.[] | select(.score < 5)'
```

<a id="cli-apps"></a>

### `apps`

List available Lamina apps.

```bash
npx sanity-lamina apps
npx sanity-lamina apps --json
```

<a id="cli-credits"></a>

### `credits`

Check credit balance.

```bash
npx sanity-lamina credits
```

---

## Webhook handler

Auto-generate media when documents are created or updated in Sanity.

<a id="webhook-vercel"></a>

### Setup with Vercel

```ts
// api/lamina-webhook.ts
import { createLaminaWebhookHandler } from 'sanity-plugin-lamina/webhooks'

export default createLaminaWebhookHandler({
  laminaApiKey: process.env.LAMINA_API_KEY!,
  sanityProjectId: process.env.SANITY_PROJECT_ID!,
  sanityToken: process.env.SANITY_TOKEN!,
  sanityWebhookSecret: process.env.SANITY_WEBHOOK_SECRET,

  triggers: [
    {
      filter: '_type == "product"',
      fields: {
        heroImage: 'Product lifestyle photo for {{title}}',
        thumbnail: 'Product thumbnail, square crop, {{title}}',
        ogImage: 'Social share image for {{title}}',
      },
      onlyIfEmpty: true,
      enhance: true,
      brandProfileId: 'bp_123',
    },
    {
      filter: '_type == "blogPost"',
      fields: {
        coverImage: 'Blog cover illustration: {{title}}',
      },
      onlyIfEmpty: true,
    },
  ],

  onGenerated: (documentId, fieldName) => {
    console.log(`Generated ${fieldName} for ${documentId}`)
  },
  onError: (documentId, fieldName, error) => {
    console.error(`Failed ${fieldName} for ${documentId}: ${error}`)
  },
})
```

Then configure a Sanity webhook pointing to your function URL:

1. Go to **sanity.io/manage** > your project > **API** > **Webhooks**
2. Create a new webhook with:
   - **URL**: `https://your-site.vercel.app/api/lamina-webhook`
   - **Trigger on**: Create, Update
   - **Filter**: `_type in ["product", "blogPost"]`
   - **Secret**: Generate one and set it as `SANITY_WEBHOOK_SECRET`
   - **Projection**: `{ _id, _type, title, ... }` (include fields referenced in your templates)

<a id="webhook-triggers"></a>

### Trigger configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `filter` | `string` | -- | GROQ-like filter expression (e.g. `_type == "product"`) |
| `fields` | `Record<string, string>` | -- | Field name to brief template mapping |
| `onlyIfEmpty` | `boolean` | `true` | Only generate if the field has no asset |
| `enhance` | `boolean` | `true` | Auto-enhance briefs before generation |
| `brandProfileId` | `string` | -- | Brand profile for this trigger |
| `campaignId` | `string` | -- | Campaign for this trigger |

<a id="template-syntax"></a>

### Template syntax

Brief strings support `{{fieldName}}` placeholders resolved from the document:

```
'Product photo of {{title}}'           -> 'Product photo of Nike Air Max 90'
'{{category}} product on {{color}}'    -> 'Running product on white'
'Blog cover: {{title}}'               -> 'Blog cover: How to Choose Running Shoes'
```

Nested fields use dot notation: `{{category.title}}`.

---

## Recipes

<a id="recipe-migration"></a>

### Content migration with media generation

Generate images for every product imported from a CSV:

```ts
import { createLaminaSanityClient } from 'sanity-plugin-lamina/headless'
import { createClient } from '@sanity/client'
import { parse } from 'csv-parse/sync'
import { readFileSync } from 'fs'

const lamina = createLaminaSanityClient({
  laminaApiKey: process.env.LAMINA_API_KEY,
  sanityProjectId: 'abc123',
  sanityToken: process.env.SANITY_TOKEN,
  defaultBrandProfileId: 'bp_brand',
})

const sanity = lamina.sanity
const rows = parse(readFileSync('products.csv'), { columns: true })

for (const row of rows) {
  // Create the document
  const doc = await sanity.create({
    _type: 'product',
    title: row.name,
    price: Number(row.price),
    category: row.category,
  })

  // Generate and attach hero image
  await lamina.generateForDocument(doc._id, 'heroImage', {
    brief: `${row.category} product photo: ${row.name}, lifestyle setting`,
    aspectRatio: '16:9',
  })

  // Generate thumbnail
  await lamina.generateForDocument(doc._id, 'thumbnail', {
    brief: `Product thumbnail: ${row.name}, clean white background`,
    aspectRatio: '1:1',
  })

  console.log(`Created ${doc._id} with media`)
}
```

<a id="recipe-ci"></a>

### CI pipeline: generate on publish

Run in a GitHub Action or similar:

```bash
# Find all blog posts published in the last hour without cover images
npx sanity-lamina generate \
  --query '*[_type == "blogPost" && !defined(coverImage) && dateTime(_updatedAt) > dateTime(now()) - 60*60]' \
  --field coverImage \
  --brief 'Blog header illustration: {{title}}' \
  --concurrency 3
```

<a id="recipe-multi-brand"></a>

### Multi-brand content generation

```ts
import { createLaminaSanityClient } from 'sanity-plugin-lamina/headless'

const brands = [
  { profileId: 'bp_brand_a', query: '*[_type == "product" && brand == "A"]' },
  { profileId: 'bp_brand_b', query: '*[_type == "product" && brand == "B"]' },
]

for (const brand of brands) {
  const lamina = createLaminaSanityClient({
    laminaApiKey: process.env.LAMINA_API_KEY,
    sanityProjectId: 'abc123',
    sanityToken: process.env.SANITY_TOKEN,
    defaultBrandProfileId: brand.profileId,
  })

  const result = await lamina.fillEmptyMedia({
    query: `${brand.query} && !defined(heroImage)`,
    fieldMapping: { heroImage: 'Brand product photo: {{title}}' },
    concurrency: 5,
  })

  console.log(`Brand ${brand.profileId}: ${result.fieldsGenerated} generated`)
}
```

<a id="recipe-quality-gate"></a>

### Quality gate: score before publish

```ts
import { createLaminaSanityClient } from 'sanity-plugin-lamina/headless'

const lamina = createLaminaSanityClient({ /* ... */ })

// Score all assets for a document before publishing
const scores = await lamina.scoreAssets({
  query: `*[_type == "sanity.imageAsset" && source.name == "lamina" && source.documentId == "product-123"]{ _id, url, description }`,
  platform: 'instagram',
})

const lowScores = scores.filter((s) => s.score !== null && s.score < 5)
if (lowScores.length > 0) {
  console.warn(`${lowScores.length} assets scored below threshold -- regenerating`)
  for (const asset of lowScores) {
    // Regenerate with the original brief
    await lamina.generateForDocument('product-123', 'heroImage', {
      brief: asset.brief || undefined,
    })
  }
}
```

---

## Architecture

```
sanity-plugin-lamina
|
|-- Studio plugin (import from "sanity-plugin-lamina")
|   |-- Asset Source (GenerateDialog)
|   |-- Studio Tool (LaminaTool)
|   |-- Document Actions (regenerate, generateAll)
|   |-- Field Input (LaminaImageInput)
|   \-- React context (LaminaProvider / useLamina)
|
|-- Headless API (import from "sanity-plugin-lamina/headless")
|   |-- createLaminaSanityClient()
|   |-- generate(), generateForDocument(), fillEmptyMedia()
|   |-- uploadToSanity(), scoreAssets()
|   \-- intelligence.trends/predict/recommendations/getBrandContext
|
|-- Webhook handler (import from "sanity-plugin-lamina/webhooks")
|   \-- createLaminaWebhookHandler()
|
|-- CLI (npx sanity-lamina)
|   \-- generate, fill-document, score, apps, credits
|
\-- Shared lib (used by all layers, no React dependency)
    |-- briefEnhancer.ts    -- Brief enhancement + silent enrichment
    |-- schemaContext.ts     -- Schema introspection utilities
    |-- aspectRatio.ts      -- Field-name-to-ratio detection
    |-- appRouting.ts       -- App selection persistence
    \-- recentBriefs.ts     -- Brief history tracking
```

The Studio plugin depends on React and `@sanity/ui`. The headless layer, webhook handler, and CLI only depend on `@uselamina/sdk` and `@sanity/client` -- no React required.

---

## Development

```bash
npm install
npm run build     # tsc -> dist/
npm run dev       # tsc --watch
```

### Local testing (Studio plugin)

```bash
# In this repo:
npm run dev

# In a Sanity Studio project:
# package.json: "sanity-plugin-lamina": "file:../sanity-lamina"
# sanity.config.ts: plugins: [laminaPlugin({ apiKey: '...' })]
```

### Local testing (headless / CLI)

```bash
# Set environment variables
export LAMINA_API_KEY=your_key
export SANITY_PROJECT_ID=your_project
export SANITY_TOKEN=your_token

# Test CLI
node dist/cli/index.js apps
node dist/cli/index.js credits

# Test headless in a script
node -e "
  import('sanity-plugin-lamina/headless').then(async ({ createLaminaSanityClient }) => {
    const client = createLaminaSanityClient({})
    const apps = await client.lamina.apps.list()
    console.log(apps.data)
  })
"
```

---

## License

MIT -- see [LICENSE](./LICENSE).
