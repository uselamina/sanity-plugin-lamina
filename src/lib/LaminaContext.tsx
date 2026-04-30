import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { LaminaClient, LaminaAuthError } from '@uselamina/sdk';
import { Button, Card, Flex, Stack, Text, Spinner } from '@sanity/ui';
import type { LaminaPluginOptions } from '../types.js';
import {
  clearToken,
  exchangeCode,
  getStoredToken,
  prepareOAuthFlow,
  refreshIfNeeded,
  storeToken,
  subscribeToTokenChanges,
} from './oauth.js';
import { gcDialogState } from './dialogStore.js';

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
}: {
  options: LaminaPluginOptions;
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
          // storeToken dispatches the token-change event; useResolvedToken
          // (via useSyncExternalStore) re-reads localStorage in the parent
          // and re-renders, replacing this <OAuthLogin> with the real UI.
          storeToken(
            options.oauth!,
            tokens.accessToken,
            tokens.refreshToken,
            tokens.expiresIn,
          );
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
  }, [options, baseUrl]);

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

/**
 * Reads the active token reactively.
 *
 * localStorage is the single source of truth. `useSyncExternalStore` keeps
 * React in sync with it: this component re-renders whenever `storeToken` or
 * `clearToken` runs (this tab via the custom event, or a sibling tab via
 * `storage`). No `useState` mirror, no callback prop chain — every consumer
 * reads from the same place. An explicit `options.apiKey` short-circuits the
 * store entirely.
 */
function useResolvedToken(options: LaminaPluginOptions): string | null {
  const oauthConfig = options.oauth;
  const explicitKey = options.apiKey;

  const subscribe = useCallback(
    (listener: () => void) => {
      if (explicitKey || !oauthConfig) return () => {};
      return subscribeToTokenChanges(oauthConfig, listener);
    },
    [oauthConfig, explicitKey],
  );

  const getSnapshot = useCallback(() => {
    if (explicitKey) return explicitKey;
    if (!oauthConfig) return null;
    return getStoredToken(oauthConfig);
  }, [explicitKey, oauthConfig]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function LaminaProvider({
  options,
  children,
}: {
  options: LaminaPluginOptions;
  children: ReactNode;
}) {
  const baseUrl = options.baseUrl || LAMINA_ORIGIN;
  const resolvedKey = useResolvedToken(options);

  // Sweep stale dialog-state entries from localStorage exactly once on
  // provider mount. Drops entries past MAX_ENTRY_AGE_MS or with the wrong
  // schema version. Cheap (just walks lamina:dialog:* keys); safe to retry.
  useEffect(() => {
    gcDialogState();
  }, []);

  // Periodic refresh: when the access token nears expiry, mint a new pair
  // via the refresh token. `refreshIfNeeded` writes the new token to
  // localStorage on success, which fires the token-change event, which
  // triggers `useResolvedToken` to re-read — no manual state propagation
  // needed. `refreshIfNeeded` no-ops cheaply when the token still has > 5
  // min of life, so running it on an interval is safe.
  useEffect(() => {
    if (options.apiKey || !options.oauth) return;
    const oauthConfig = options.oauth;

    const check = () => {
      void refreshIfNeeded(oauthConfig, baseUrl);
    };

    check();
    const intervalId = window.setInterval(check, REFRESH_CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [options.apiKey, options.oauth, baseUrl]);

  const client = useMemo(() => {
    if (!resolvedKey) return null;
    const real = new LaminaClient({
      apiKey: resolvedKey,
      baseUrl: options.baseUrl,
    });

    // OAuth-only: when the access token dies (expired or revoked) mid-session,
    // any SDK call returns 401 and surfaces "invalid apiKey" to the user. We
    // intercept those errors at the API surface, drop the dead token from
    // storage, and rethrow. clearToken fires the token-change event, so the
    // useResolvedToken hook re-reads localStorage as null and the provider
    // re-renders to <OAuthLogin> — the user just sees the sign-in screen,
    // not an error toast. No refresh-retry: simpler, and a stale refresh
    // token would land us at the same place anyway.
    if (!options.oauth) return real;
    const oauthConfig = options.oauth;

    const wrapApi = <T extends object>(api: T): T =>
      new Proxy(api, {
        get(target, prop, receiver) {
          const fn = Reflect.get(target, prop, receiver);
          if (typeof fn !== 'function') return fn;
          return async (...args: unknown[]) => {
            try {
              return await (fn as (...a: unknown[]) => unknown).apply(target, args);
            } catch (err) {
              if (err instanceof LaminaAuthError) {
                clearToken(oauthConfig);
              }
              throw err;
            }
          };
        },
      });

    return new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        // Wrap the surface APIs (.content, .apps, .runs, .intelligence, etc.)
        // — they're the only object-typed members the plugin calls into.
        if (value !== null && typeof value === 'object') return wrapApi(value);
        return value;
      },
    });
  }, [resolvedKey, options.baseUrl, options.oauth]);

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
      <OAuthLogin options={options} />
    );
  }

  // resolvedKey is guaranteed non-null here since client is only created when resolvedKey is truthy
  const value: LaminaContextValue = { client, options, token: resolvedKey! };

  return <Ctx value={value}>{children}</Ctx>;
}
