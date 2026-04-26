/**
 * Stores the last few successful briefs per document-type + field-name.
 * Used to show "Recently used" suggestion chips in the GenerateDialog.
 */

const PREFIX = 'lamina_recent_';
const MAX_RECENT = 5;

interface RecentBrief {
  brief: string;
  timestamp: number;
  appId?: string;
}

export function getRecentBriefs(documentType?: string, fieldName?: string): RecentBrief[] {
  const key = `${PREFIX}${documentType ?? '_any'}_${fieldName ?? '_default'}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return JSON.parse(raw) as RecentBrief[];
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
  const key = `${PREFIX}${documentType ?? '_any'}_${fieldName ?? '_default'}`;
  try {
    const existing = getRecentBriefs(documentType, fieldName);
    const updated = [
      { brief: brief.trim(), timestamp: Date.now(), appId },
      ...existing.filter((r) => r.brief !== brief.trim()),
    ].slice(0, MAX_RECENT);
    localStorage.setItem(key, JSON.stringify(updated));
  } catch {
    // localStorage unavailable
  }
}
