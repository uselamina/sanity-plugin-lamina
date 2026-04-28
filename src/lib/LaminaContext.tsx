import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LaminaClient } from '@uselamina/sdk';
import { Button, Card, Flex, Stack, Text, Spinner } from '@sanity/ui';
import type { LaminaPluginOptions } from '../types.js';
import {
  exchangeCode,
  getStoredToken,
  prepareOAuthFlow,
  refreshIfNeeded,
  storeToken,
  subscribeToTokenChanges,
} from './oauth.js';

const LAMINA_ORIGIN = 'https://app.uselamina.ai';

/**
 * How often to re-check whether the OAuth access token needs a refresh.
 * 4 min lines up well with the 5-min refresh buffer in `refreshIfNeeded`,
 * so we always have one timer fire before the access token expires.
 */
const REFRESH_CHECK_INTERVAL_MS = 4 * 60 * 1000;

interface LaminaContextValue {
  client: LaminaClient;
  options: LaminaPluginOptions;
  /** The resolved API key or OAuth access token used by the client. */
  token: string;
}

const Ctx = createContext<LaminaContextValue | null>(null);

export function useLamina(): LaminaContextValue {
  const value = useContext(Ctx);
  if (!value) {
    throw new Error(
      'useLamina() must be used inside <LaminaProvider>. ' +
        'Make sure laminaPlugin() is added to your sanity.config.',
    );
  }
  return value;
}

function OAuthLogin({
  options,
  onAuthenticated,
}: {
  options: LaminaPluginOptions;
  onAuthenticated: (token: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseUrl = options.baseUrl || LAMINA_ORIGIN;

  const handleLogin = useCallback(() => {
    if (!options.oauth) return;

    setLoading(true);
    setError(null);

    // Open the popup synchronously inside the click handler so the browser
    // counts it as a user gesture. If we awaited DCR or PKCE work first, the
    // window.open after that await would be classified as non-user-initiated
    // and silently blocked by Safari/Firefox/Chrome. We open `about:blank`
    // first and navigate it once the auth URL is ready.
    const popup = window.open(
      'about:blank',
      'lamina-oauth',
      'width=600,height=700,popup=yes',
    );

    if (!popup) {
      setError('Failed to open login popup. Please allow popups for this site.');
      setLoading(false);
      return;
    }

    void (async () => {
      let url: string;
      try {
        url = await prepareOAuthFlow(options.oauth!, baseUrl);
      } catch (err) {
        popup.close();
        setError(
          err instanceof Error ? err.message : 'Failed to start login flow.',
        );
        setLoading(false);
        return;
      }

      popup.location.href = url;

      // Listen for the callback. The OAuth callback page is hosted on the
      // Lamina backend (baseUrl), so messages originate from THERE, not from
      // the Studio's own origin.
      const handleMessage = async (event: MessageEvent) => {
        if (event.origin !== baseUrl) return;
        if (!event.data?.type || event.data.type !== 'lamina:oauth-callback') return;

        const code = event.data.code as string | undefined;
        if (!code) {
          setError('No authorization code received.');
          setLoading(false);
          return;
        }

        try {
          const tokens = await exchangeCode(options.oauth!, baseUrl, code);
          storeToken(
            options.oauth!,
            tokens.accessToken,
            tokens.refreshToken,
            tokens.expiresIn,
          );
          onAuthenticated(tokens.accessToken);
        } catch (err) {
          setError(
            err instanceof Error ? err.message : 'Authentication failed.',
          );
        } finally {
          setLoading(false);
        }
      };

      window.addEventListener('message', handleMessage);

      // Also poll for popup close (user closed without completing)
      const interval = setInterval(() => {
        if (popup.closed) {
          clearInterval(interval);
          window.removeEventListener('message', handleMessage);
          setLoading(false);
        }
      }, 500);
    })();
  }, [options, baseUrl, onAuthenticated]);

  return (
    <Card padding={4}>
      <Stack space={3}>
        <Text size={2} weight="medium">
          Connect to Lamina
        </Text>
        <Text size={1} muted>
          Sign in with your Lamina account to generate and manage media assets.
        </Text>
        {error ? (
          <Card padding={3} radius={2} tone="critical">
            <Stack space={2}>
              <Text size={1}>{error}</Text>
              <Text size={0} muted>
                Look for a popup blocked icon in your browser's address bar and allow popups for this site.
              </Text>
              <Button
                text="Try again"
                mode="ghost"
                onClick={handleLogin}
              />
            </Stack>
          </Card>
        ) : null}
        {loading ? (
          <Flex align="center" gap={2}>
            <Spinner />
            <Text size={1} muted>
              Waiting for authentication...
            </Text>
          </Flex>
        ) : (
          <Button
            text="Sign in with Lamina"
            tone="primary"
            onClick={handleLogin}
          />
        )}
      </Stack>
    </Card>
  );
}

export function LaminaProvider({
  options,
  children,
}: {
  options: LaminaPluginOptions;
  children: ReactNode;
}) {
  // Resolve API key: explicit > stored OAuth token
  const storedToken = options.oauth ? getStoredToken(options.oauth) : null;
  const initialKey = options.apiKey || storedToken;

  const [resolvedKey, setResolvedKey] = useState<string | null>(initialKey);

  const baseUrl = options.baseUrl || LAMINA_ORIGIN;

  // Sync when options change. For OAuth, also proactively refresh the access
  // token if it's near expiry so the user stays logged in past the 1h access
  // token TTL without a manual re-auth click. `refreshIfNeeded` returns:
  //   - the existing token when it's still well within its TTL
  //   - a freshly-rotated token when it succeeded a refresh
  //   - null when the refresh token is missing or rejected (forces re-login)
  //
  // We also schedule a recurring check while OAuth is configured so mid-session
  // expiries (long-running tabs) refresh silently before the access token dies.
  // `refreshIfNeeded` no-ops cheaply when the token still has > 5 min of life.
  useEffect(() => {
    if (options.apiKey) {
      setResolvedKey(options.apiKey);
      return;
    }
    if (!options.oauth) {
      setResolvedKey(null);
      return;
    }

    let cancelled = false;
    const oauthConfig = options.oauth;

    const check = async () => {
      const token = await refreshIfNeeded(oauthConfig, baseUrl);
      if (!cancelled) setResolvedKey(token);
    };

    void check();
    const intervalId = window.setInterval(check, REFRESH_CHECK_INTERVAL_MS);

    // Cross-tab sync: when a sibling Studio tab refreshes or clears the
    // token, mirror that into this tab's state. Without this, tabs race
    // each other on refresh and the loser sees `invalid_grant` because the
    // refresh token has been rotated.
    const unsubscribe = subscribeToTokenChanges(oauthConfig, (token) => {
      if (!cancelled) setResolvedKey(token);
    });

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      unsubscribe();
    };
  }, [options.apiKey, options.oauth, baseUrl]);

  const handleAuthenticated = useCallback((token: string) => {
    setResolvedKey(token);
  }, []);

  const client = useMemo(() => {
    if (!resolvedKey) return null;
    return new LaminaClient({
      apiKey: resolvedKey,
      baseUrl: options.baseUrl,
    });
  }, [resolvedKey, options.baseUrl]);

  // No API key and no OAuth configured — throw
  if (!resolvedKey && !options.oauth) {
    throw new Error(
      'sanity-plugin-lamina: apiKey is required. ' +
        'Pass it via laminaPlugin({ apiKey }) or configure OAuth via laminaPlugin({ oauth: { clientId } }).',
    );
  }

  // No API key but OAuth configured — show login
  if (!client) {
    return (
      <OAuthLogin options={options} onAuthenticated={handleAuthenticated} />
    );
  }

  // resolvedKey is guaranteed non-null here since client is only created when resolvedKey is truthy
  const value: LaminaContextValue = { client, options, token: resolvedKey! };

  return <Ctx value={value}>{children}</Ctx>;
}
