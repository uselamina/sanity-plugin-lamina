import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LaminaClient } from '@uselamina/sdk';
import { Button, Card, Flex, Stack, Text, Spinner } from '@sanity/ui';
import type { LaminaPluginOptions } from '../types.js';
import {
  clearToken,
  exchangeCode,
  getStoredToken,
  startOAuthFlow,
  storeToken,
} from './oauth.js';

const LAMINA_ORIGIN = 'https://app.uselamina.ai';

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

    const popup = startOAuthFlow(options.oauth, baseUrl);

    if (!popup) {
      setError('Failed to open login popup. Please allow popups for this site.');
      setLoading(false);
      return;
    }

    // Listen for the callback
    const handleMessage = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
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
          <Card padding={2} radius={2} tone="critical">
            <Text size={1}>{error}</Text>
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

  // Sync when options change
  useEffect(() => {
    const token = options.oauth ? getStoredToken(options.oauth) : null;
    setResolvedKey(options.apiKey || token);
  }, [options.apiKey, options.oauth]);

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
