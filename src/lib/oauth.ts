import type { LaminaOAuthConfig } from '../types.js';

const DEFAULT_STORAGE_KEY = 'lamina_oauth';
const TOKEN_CHANGE_EVENT = 'lamina:oauth-token-change';

interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * Full stored-tokens shape returned by `getStoredTokens`.
 * Used by the refresh logic in LaminaContext.
 */
export interface StoredTokens {
  accessToken: string;
  /** ms timestamp; null when expiry was not provided by the auth server. */
  expiresAt: number | null;
  refreshToken: string | null;
}

function storageKey(config: LaminaOAuthConfig): string {
  return config.storageKey ?? DEFAULT_STORAGE_KEY;
}

/**
 * localStorage key for the dynamically-registered OAuth client_id.
 * Stored separately from the tokens so they have independent lifecycles
 * (clearing tokens on logout shouldn't force re-registration).
 */
function clientIdStorageKey(config: LaminaOAuthConfig): string {
  return `${storageKey(config)}_client_id`;
}

function dispatchTokenChange(config: LaminaOAuthConfig): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(TOKEN_CHANGE_EVENT, {
      detail: { key: storageKey(config) },
    }),
  );
}

function getStoredClientId(config: LaminaOAuthConfig): string | null {
  try {
    return localStorage.getItem(clientIdStorageKey(config));
  } catch {
    return null;
  }
}

function storeClientId(config: LaminaOAuthConfig, clientId: string): void {
  try {
    localStorage.setItem(clientIdStorageKey(config), clientId);
  } catch {
    // localStorage unavailable — stays in memory for this session only
  }
}

/**
 * Default OAuth redirect target. Must point at the Lamina-hosted callback
 * page (which postMessages the auth code back to the Studio opener and
 * self-closes) — NOT at the Studio's own origin, which has no such page.
 */
function defaultRedirectUri(baseUrl: string): string {
  return `${baseUrl}/oauth/callback`;
}

/** sessionStorage key for the in-flight PKCE code_verifier. */
function verifierStorageKey(config: LaminaOAuthConfig): string {
  return `${storageKey(config)}_verifier`;
}

// ─── PKCE (RFC 7636) ────────────────────────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function deriveCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Returns the OAuth client_id, resolving in this order:
 *   1. `config.clientId` if explicitly provided in plugin config
 *   2. Cached client_id from localStorage (set by a previous registration)
 *   3. Fresh registration via POST /oauth/register, then cache + return
 *
 * The dynamic-registration step is what eliminates the need for plugin
 * customers to email Lamina for a client_id — the Studio self-registers on
 * first login.
 */
async function resolveClientId(
  config: LaminaOAuthConfig,
  baseUrl: string,
): Promise<string> {
  if (config.clientId) return config.clientId;

  const cached = getStoredClientId(config);
  if (cached) return cached;

  const redirectUri = config.redirectUri || defaultRedirectUri(baseUrl);
  const clientName = `Sanity Studio (${window.location.hostname})`;

  const response = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
    }),
  });

  if (!response.ok) {
    throw new Error(`OAuth client registration failed (${response.status})`);
  }

  const data = (await response.json()) as { client_id: string };
  if (!data?.client_id) {
    throw new Error('OAuth client registration returned no client_id');
  }

  storeClientId(config, data.client_id);
  return data.client_id;
}

/**
 * Reads the full stored-tokens record without touching localStorage on expiry.
 * Returns null only when nothing is stored or the JSON is malformed.
 *
 * Distinct from `getStoredToken` (which clears expired entries and returns
 * just the access token string). Callers that want to refresh use this one
 * so they can inspect `expiresAt` and `refreshToken`.
 */
export function getStoredTokens(config: LaminaOAuthConfig): StoredTokens | null {
  try {
    const raw = localStorage.getItem(storageKey(config));
    if (!raw) return null;
    const tokens: OAuthTokens = JSON.parse(raw);
    if (!tokens?.accessToken) return null;
    return {
      accessToken: tokens.accessToken,
      expiresAt: typeof tokens.expiresAt === 'number' ? tokens.expiresAt : null,
      refreshToken: typeof tokens.refreshToken === 'string' ? tokens.refreshToken : null,
    };
  } catch {
    return null;
  }
}

export function getStoredToken(config: LaminaOAuthConfig): string | null {
  try {
    const raw = localStorage.getItem(storageKey(config));
    if (!raw) return null;
    const tokens: OAuthTokens = JSON.parse(raw);
    if (tokens.expiresAt && Date.now() > tokens.expiresAt) {
      // Token expired — clear and return null
      localStorage.removeItem(storageKey(config));
      return null;
    }
    return tokens.accessToken;
  } catch {
    return null;
  }
}

export function storeToken(
  config: LaminaOAuthConfig,
  accessToken: string,
  refreshToken?: string,
  expiresInSeconds?: number,
): void {
  const tokens: OAuthTokens = {
    accessToken,
    refreshToken,
    expiresAt: expiresInSeconds
      ? Date.now() + expiresInSeconds * 1000
      : undefined,
  };
  localStorage.setItem(storageKey(config), JSON.stringify(tokens));
  dispatchTokenChange(config);
}

export function clearToken(config: LaminaOAuthConfig): void {
  localStorage.removeItem(storageKey(config));
  dispatchTokenChange(config);
}

/**
 * Notifies the listener whenever the stored token for this config changes —
 * either from a sibling Studio tab (browser `storage` event, fired on every
 * tab EXCEPT the one that wrote) or from this same tab (custom event we
 * dispatch from `storeToken` / `clearToken`, since `storage` doesn't fire in
 * the writing tab).
 *
 * Listener is parameterless to match `useSyncExternalStore`'s contract — it
 * just signals "re-read the snapshot." Consumers should call `getStoredToken`
 * to read the current value.
 *
 * Returns an unsubscribe function for cleanup.
 */
export function subscribeToTokenChanges(
  config: LaminaOAuthConfig,
  listener: () => void,
): () => void {
  const key = storageKey(config);
  const handler = (event: StorageEvent) => {
    if (event.key !== key) return;
    listener();
  };
  const sameTabHandler = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key !== key) return;
    listener();
  };
  window.addEventListener('storage', handler);
  window.addEventListener(TOKEN_CHANGE_EVENT, sameTabHandler);
  return () => {
    window.removeEventListener('storage', handler);
    window.removeEventListener(TOKEN_CHANGE_EVENT, sameTabHandler);
  };
}

/**
 * Resolves the OAuth client_id (registering dynamically if needed), generates
 * a PKCE pair, stashes the verifier in sessionStorage, and returns the
 * authorize URL.
 *
 * Does NOT open the popup — that's the caller's job, and they must do it
 * synchronously inside the user-gesture event (a click) BEFORE awaiting this
 * function. Otherwise Safari/Firefox/Chrome will classify the popup as
 * non-user-initiated and block it. Recommended pattern:
 *
 *   const popup = window.open('about:blank', 'lamina-oauth', features); // sync
 *   const url = await prepareOAuthFlow(config, baseUrl);                // async
 *   popup.location.href = url;                                          // navigate
 */
export async function prepareOAuthFlow(
  config: LaminaOAuthConfig,
  baseUrl: string,
): Promise<string> {
  const clientId = await resolveClientId(config, baseUrl);
  const redirectUri = config.redirectUri || defaultRedirectUri(baseUrl);

  // Generate a PKCE pair, stash the verifier in sessionStorage so
  // `exchangeCode` can read it back when the popup returns.
  const verifier = generateCodeVerifier();
  const challenge = await deriveCodeChallenge(verifier);
  sessionStorage.setItem(verifierStorageKey(config), verifier);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Space-separated per RFC 6749 §3.3. Must match the values in
    // server/services/mcpOAuthService.ts MCP_OAUTH_SCOPES — anything else
    // gets rejected by validateScopes() as "Unsupported MCP OAuth scope".
    scope: 'lamina:creative:read lamina:creative:write lamina:brand:read',
  });
  return `${baseUrl}/oauth/authorize?${params.toString()}`;
}

/**
 * Exchanges an authorization code for tokens.
 *
 * Uses the client_id resolved at login time — it's already in localStorage by
 * the time this runs, so no extra registration call is made here.
 */
export async function exchangeCode(
  config: LaminaOAuthConfig,
  baseUrl: string,
  code: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const clientId = config.clientId ?? getStoredClientId(config);
  if (!clientId) {
    throw new Error('OAuth client_id missing — login flow not initialised');
  }

  const redirectUri = config.redirectUri || defaultRedirectUri(baseUrl);

  // Pull and consume the PKCE verifier stashed by `startOAuthFlow`. If it's
  // gone, the user likely refreshed the Studio mid-flow — restart sign-in.
  const verifier = sessionStorage.getItem(verifierStorageKey(config));
  if (!verifier) {
    throw new Error('Missing PKCE verifier — please start the sign-in flow again.');
  }
  sessionStorage.removeItem(verifierStorageKey(config));

  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`OAuth token exchange failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Returns a valid access token, refreshing it if it's near expiry.
 *
 * - Returns the stored access token if it has more than `REFRESH_BUFFER_MS`
 *   left before expiring.
 * - Otherwise, if a refresh token is available, calls `/oauth/token` to mint a
 *   fresh pair, stores the new tokens, and returns the new access token.
 * - Returns null when there's nothing stored, no refresh token to use, or the
 *   refresh attempt fails — in which case the caller should re-trigger the
 *   OAuth login flow.
 *
 * Concurrency: parallel callers that hit the function while a refresh is in
 * flight all `await` the same in-flight promise. Without this, two callers
 * would each POST to /oauth/token, the first would succeed and rotate the
 * refresh token, the second would 400 with "invalid refresh token" and we'd
 * incorrectly clear the stored credentials.
 */
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh if access token expires within 5 min

let inFlight: Promise<string | null> | null = null;

export function refreshIfNeeded(
  config: LaminaOAuthConfig,
  baseUrl: string,
): Promise<string | null> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const stored = getStoredTokens(config);
      if (!stored) return null;

      // Plenty of life left — no refresh needed
      if (stored.expiresAt !== null && stored.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
        return stored.accessToken;
      }

      // No refresh token → can't recover, force re-login
      if (!stored.refreshToken) {
        clearToken(config);
        return null;
      }

      try {
        const fresh = await refreshAccessToken(config, baseUrl, stored.refreshToken);
        storeToken(config, fresh.accessToken, fresh.refreshToken, fresh.expiresIn);
        return fresh.accessToken;
      } catch {
        // Refresh failed. Common cause: another Studio tab refreshed first
        // and rotated our refresh token. Re-read storage before clearing —
        // if the sibling tab landed a fresh token, use it instead of forcing
        // the user to re-authenticate.
        const recheck = getStoredTokens(config);
        if (
          recheck &&
          recheck.expiresAt !== null &&
          recheck.expiresAt - Date.now() > REFRESH_BUFFER_MS &&
          recheck.accessToken !== stored.accessToken
        ) {
          return recheck.accessToken;
        }
        clearToken(config);
        return null;
      }
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Refreshes an expired token using the refresh token.
 */
export async function refreshAccessToken(
  config: LaminaOAuthConfig,
  baseUrl: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const clientId = config.clientId ?? getStoredClientId(config);
  if (!clientId) {
    throw new Error('OAuth client_id missing — cannot refresh');
  }

  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}
