/**
 * Remembers which Lamina app was last used for each document-type + field-name
 * combination. Stores in localStorage so the selection persists per-browser.
 */

const PREFIX = 'lamina_app_routing_';

export function getRoutedAppId(documentType?: string, fieldName?: string): string | null {
  if (!documentType) return null;
  const key = `${PREFIX}${documentType}_${fieldName ?? '_default'}`;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveRoutedAppId(
  documentType: string | undefined,
  fieldName: string | undefined,
  appId: string,
): void {
  if (!documentType) return;
  const key = `${PREFIX}${documentType}_${fieldName ?? '_default'}`;
  try {
    localStorage.setItem(key, appId);
  } catch {
    // localStorage unavailable
  }
}

export function clearRoutedAppId(documentType?: string, fieldName?: string): void {
  if (!documentType) return;
  const key = `${PREFIX}${documentType}_${fieldName ?? '_default'}`;
  try {
    localStorage.removeItem(key);
  } catch {
    // localStorage unavailable
  }
}
