import type { LaminaOAuthConfig } from '../types.js';

const DEFAULT_STORAGE_KEY = 'lamina_oauth';

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

  const redirectUri =
    config.redirectUri || `${window.location.origin}/lamina/callback`;
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
}

export function clearToken(config: LaminaOAuthConfig): void {
  localStorage.removeItem(storageKey(config));
}

/**
 * Builds the OAuth authorization URL and opens it in a popup.
 * The popup will redirect back to `redirectUri` with a `code` parameter.
 *
 * If `config.clientId` is not provided, this resolves it dynamically via
 * `/oauth/register` (cached in localStorage on first call). That makes the
 * function async — callers must `await` it.
 */
export async function startOAuthFlow(
  config: LaminaOAuthConfig,
  baseUrl: string,
): Promise<Window | null> {
  const clientId = await resolveClientId(config, baseUrl);
  const redirectUri =
    config.redirectUri || `${window.location.origin}/lamina/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'api',
  });
  const authUrl = `${baseUrl}/oauth/authorize?${params.toString()}`;

  return window.open(
    authUrl,
    'lamina-oauth',
    'width=600,height=700,popup=yes',
  );
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

  const redirectUri =
    config.redirectUri || `${window.location.origin}/lamina/callback`;

  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
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
        // Refresh token rejected (revoked, expired, network error)
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
