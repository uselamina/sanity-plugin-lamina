import { RocketIcon } from '@sanity/icons';
import type { AssetSource } from 'sanity';
import { GenerateDialog } from './GenerateDialog.js';

/**
 * Sanity asset source definition for Lamina.
 * Appears as "Generate with Lamina" in image/file field dropdowns.
 */
export const laminaAssetSource: AssetSource = {
  name: 'lamina',
  title: 'Generate with Lamina',
  icon: RocketIcon,
  component: GenerateDialog,
};
