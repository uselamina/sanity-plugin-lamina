import { definePlugin, type Tool } from 'sanity';
import { RocketIcon } from '@sanity/icons';
import { laminaAssetSource } from './components/LaminaAssetSource.js';
import { LaminaProvider } from './lib/LaminaContext.js';
import { LaminaTool } from './tool/LaminaTool.js';
import { createRegenerateAction } from './actions/regenerateAction.js';
import type { LaminaPluginOptions } from './types.js';

/**
 * Sanity Studio plugin for generating and managing media assets with Lamina.
 *
 * @example
 * ```ts
 * // sanity.config.ts
 * import { defineConfig } from 'sanity'
 * import { laminaPlugin } from 'sanity-plugin-lamina'
 *
 * export default defineConfig({
 *   plugins: [
 *     laminaPlugin({
 *       apiKey: process.env.SANITY_STUDIO_LAMINA_API_KEY!,
 *     }),
 *   ],
 * })
 * ```
 */
export const laminaPlugin = definePlugin<LaminaPluginOptions>((options) => {
  const enableTool = options.enableTool !== false;
  const enableDocumentAction = options.enableDocumentAction !== false;

  const tools: Tool[] = enableTool
    ? [
        {
          name: 'lamina',
          title: 'Lamina',
          icon: RocketIcon,
          component: () => (
            <LaminaProvider options={options}>
              <LaminaTool />
            </LaminaProvider>
          ),
        },
      ]
    : [];

  return {
    name: 'sanity-plugin-lamina',

    tools,

    form: {
      image: {
        assetSources: (prev) => [
          ...prev,
          {
            ...laminaAssetSource,
            component: (props: Record<string, unknown>) => (
              <LaminaProvider options={options}>
                <laminaAssetSource.component {...(props as any)} />
              </LaminaProvider>
            ),
          },
        ],
      },
      file: {
        assetSources: (prev) => [
          ...prev,
          {
            ...laminaAssetSource,
            component: (props: Record<string, unknown>) => (
              <LaminaProvider options={options}>
                <laminaAssetSource.component {...(props as any)} />
              </LaminaProvider>
            ),
          },
        ],
      },
    },

    document: enableDocumentAction
      ? {
          actions: (prev) => [...prev, createRegenerateAction()],
        }
      : undefined,
  };
});
