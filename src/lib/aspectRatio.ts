/**
 * Aspect ratio detection from Sanity field names.
 *
 * Maps common field naming conventions (e.g. heroImage, ogImage) to the
 * closest valid Lamina API aspect ratio value so generated assets match
 * the intended placement without manual editor intervention.
 */

/** Valid aspect ratio values accepted by the Lamina content.create() API. */
export type LaminaAspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '4:5' | 'auto';

export const ASPECT_RATIO_OPTIONS: readonly { value: LaminaAspectRatio | ''; label: string }[] = [
  { value: '', label: 'Auto-detect' },
  { value: '1:1', label: '1:1 (Square)' },
  { value: '16:9', label: '16:9 (Landscape)' },
  { value: '9:16', label: '9:16 (Portrait)' },
  { value: '4:3', label: '4:3 (Classic)' },
  { value: '4:5', label: '4:5 (Vertical)' },
  { value: 'auto', label: 'Auto (let Lamina decide)' },
] as const;

/**
 * Field-name-to-raw-ratio mapping.  The ratio values here are the *ideal*
 * dimensions for the field; they get mapped to the nearest valid API value
 * via {@link closestApiRatio}.
 */
const FIELD_ASPECT_RATIOS: Record<string, string> = {
  ogImage: '1200:630',
  socialImage: '1200:630',
  instagramPost: '1:1',
  instagramStory: '9:16',
  storyImage: '9:16',
  heroImage: '16:9',
  hero: '16:9',
  banner: '16:9',
  thumbnail: '1:1',
  avatar: '1:1',
  logo: '1:1',
  poster: '4:5',
  coverImage: '16:9',
};

/**
 * Map an arbitrary width:height ratio string to the closest valid
 * {@link LaminaAspectRatio}.
 */
function closestApiRatio(raw: string): LaminaAspectRatio {
  const parts = raw.split(':');
  if (parts.length !== 2) return 'auto';

  const w = Number(parts[0]);
  const h = Number(parts[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || h === 0) return 'auto';

  const target = w / h;

  const candidates: { ratio: LaminaAspectRatio; value: number }[] = [
    { ratio: '1:1', value: 1 },
    { ratio: '16:9', value: 16 / 9 },
    { ratio: '9:16', value: 9 / 16 },
    { ratio: '4:3', value: 4 / 3 },
    { ratio: '4:5', value: 4 / 5 },
  ];

  let best = candidates[0]!;
  let bestDist = Math.abs(target - best.value);

  for (const c of candidates) {
    const dist = Math.abs(target - c.value);
    if (dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }

  return best.ratio;
}

/**
 * Friendly label for detected ratios, mapping field names to human-readable
 * descriptions.
 */
const FIELD_LABELS: Record<string, string> = {
  ogImage: 'OG image',
  socialImage: 'social image',
  instagramPost: 'Instagram post',
  instagramStory: 'Instagram story',
  storyImage: 'story image',
  heroImage: 'hero image',
  hero: 'hero',
  banner: 'banner',
  thumbnail: 'thumbnail',
  avatar: 'avatar',
  logo: 'logo',
  poster: 'poster',
  coverImage: 'cover image',
};

export interface DetectedAspectRatio {
  ratio: LaminaAspectRatio;
  /** Human-readable explanation, e.g. "16:9 (hero image)" */
  label: string;
}

/**
 * Detect the best aspect ratio for a given field name.
 *
 * @returns The detected ratio and a human-readable label, or `null` when
 *          the field name is unknown or not provided.
 */
export function detectAspectRatio(fieldName?: string): DetectedAspectRatio | null {
  if (!fieldName) return null;

  const rawRatio = FIELD_ASPECT_RATIOS[fieldName];
  if (!rawRatio) return null;

  const ratio = closestApiRatio(rawRatio);
  const fieldLabel = FIELD_LABELS[fieldName] ?? fieldName;

  return {
    ratio,
    label: `${ratio} (${fieldLabel})`,
  };
}
