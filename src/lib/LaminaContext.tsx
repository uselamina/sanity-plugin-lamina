import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { LaminaClient } from '@uselamina/sdk';
import type { LaminaPluginOptions } from '../types.js';

interface LaminaContextValue {
  client: LaminaClient;
  options: LaminaPluginOptions;
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

export function LaminaProvider({
  options,
  children,
}: {
  options: LaminaPluginOptions;
  children: ReactNode;
}) {
  const client = useMemo(() => {
    if (!options.apiKey) {
      throw new Error(
        'sanity-plugin-lamina: apiKey is required. ' +
          'Pass it via laminaPlugin({ apiKey }) or set SANITY_STUDIO_LAMINA_API_KEY.',
      );
    }
    return new LaminaClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
    });
  }, [options.apiKey, options.baseUrl]);

  const value = useMemo<LaminaContextValue>(
    () => ({ client, options }),
    [client, options],
  );

  return <Ctx value={value}>{children}</Ctx>;
}
