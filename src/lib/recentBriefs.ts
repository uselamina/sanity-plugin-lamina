/**
 * Stores the last few successful briefs per document-type + field-name.
 * Used to show "Recently used" suggestion chips in the GenerateDialog.
 * Tracks usage count so frequently-used briefs sort higher (#61).
 */

const PREFIX = 'lamina_recent_';
const MAX_RECENT = 10;

export interface RecentBrief {
  brief: string;
  timestamp: number;
  appId?: string;
  /** Number of times this brief has been used successfully. */
  useCount: number;
}

function makeRecentBriefsKey(documentType?: string, fieldName?: string): string {
  return `${PREFIX}${documentType ?? '_any'}_${fieldName ?? '_default'}`;
}

export function getRecentBriefs(documentType?: string, fieldName?: string): RecentBrief[] {
  const key = makeRecentBriefsKey(documentType, fieldName);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentBrief[];
    // Sort by useCount descending, then by timestamp descending
    return parsed.sort((a, b) => (b.useCount || 1) - (a.useCount || 1) || b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

export function saveRecentBrief(
  documentType: string | undefined,
  fieldName: string | undefined,
  brief: string,
  appId?: string,
): void {
  if (!brief.trim()) return;
  const key = makeRecentBriefsKey(documentType, fieldName);
  try {
    const existing = getRecentBriefs(documentType, fieldName);
    const match = existing.find((r) => r.brief === brief.trim());
    const entry: RecentBrief = {
      brief: brief.trim(),
      timestamp: Date.now(),
      appId,
      useCount: (match?.useCount || 0) + 1,
    };
    const updated = [
      entry,
      ...existing.filter((r) => r.brief !== brief.trim()),
    ].slice(0, MAX_RECENT);
    localStorage.setItem(key, JSON.stringify(updated));
  } catch {
    // localStorage unavailable
  }
}

export function clearRecentBriefs(documentType?: string, fieldName?: string): void {
  try {
    localStorage.removeItem(makeRecentBriefsKey(documentType, fieldName));
  } catch {
    // localStorage unavailable
  }
}
