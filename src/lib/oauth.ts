import type { LaminaOAuthConfig } from '../types.js';

const DEFAULT_STORAGE_KEY = 'lamina_oauth';

interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

function storageKey(config: LaminaOAuthConfig): string {
  return config.storageKey ?? DEFAULT_STORAGE_KEY;
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
 */
export function startOAuthFlow(
  config: LaminaOAuthConfig,
  baseUrl: string,
): Window | null {
  const redirectUri =
    config.redirectUri || `${window.location.origin}/lamina/callback`;
  const params = new URLSearchParams({
    client_id: config.clientId,
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
 */
export async function exchangeCode(
  config: LaminaOAuthConfig,
  baseUrl: string,
  code: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const redirectUri =
    config.redirectUri || `${window.location.origin}/lamina/callback`;

  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: config.clientId,
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
 * Refreshes an expired token using the refresh token.
 */
export async function refreshAccessToken(
  config: LaminaOAuthConfig,
  baseUrl: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: config.clientId,
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
