import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Card, Flex, Stack, Text, Button, Spinner } from '@sanity/ui';
import { LaunchIcon } from '@sanity/icons';
import { useClient } from 'sanity';
import { useLamina } from '../lib/LaminaContext.js';

const LAMINA_ORIGIN = 'https://app.uselamina.ai';

interface LaminaMessage {
  type: 'lamina:asset-ready' | 'lamina:editor-close';
  url?: string;
  runId?: string;
  mediaType?: 'image' | 'video';
  brief?: string;
  filename?: string;
}

function isLaminaMessage(data: unknown): data is LaminaMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    typeof (data as LaminaMessage).type === 'string' &&
    (data as LaminaMessage).type.startsWith('lamina:')
  );
}

export function LaminaTool() {
  const { options } = useLamina();
  const sanityClient = useClient({ apiVersion: '2024-01-01' });
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const baseUrl = options.baseUrl || LAMINA_ORIGIN;
  const embedUrl = `${baseUrl}/embed?token=${encodeURIComponent(options.apiKey ?? '')}`;

  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      if (event.origin !== baseUrl) return;
      if (!isLaminaMessage(event.data)) return;

      const msg = event.data;

      if (msg.type === 'lamina:asset-ready' && msg.url) {
        setSaving(true);
        setErrorMessage(null);
        try {
          const type = msg.mediaType === 'video' ? 'file' : 'image';

          let response: Response;
          try {
            response = await fetch(msg.url);
          } catch (fetchErr) {
            const detail =
              fetchErr instanceof TypeError
                ? 'This is likely a CORS issue on cdn.uselamina.ai. Ask your Lamina admin to allow the Studio origin.'
                : 'Network request failed.';
            throw new Error(`Failed to download asset: ${detail}`);
          }

          if (!response.ok) {
            throw new Error(
              `Failed to download asset: HTTP ${response.status} ${response.statusText}`,
            );
          }

          const blob = await response.blob();

          try {
            await sanityClient.assets.upload(type, blob, {
              filename: msg.filename || `lamina-${msg.runId || 'asset'}`,
              source: {
                name: 'lamina',
                id: msg.runId || '',
              },
            });
          } catch (uploadErr) {
            const reason =
              uploadErr instanceof Error ? uploadErr.message : 'Unknown error';
            throw new Error(`Failed to upload asset to Sanity: ${reason}`);
          }

          setLastSaved(msg.filename || msg.runId || 'asset');
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Failed to save asset.';
          setErrorMessage(message);
          console.error('[sanity-plugin-lamina] Failed to save asset:', err);
        } finally {
          setSaving(false);
        }
      }
    },
    [baseUrl, sanityClient],
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);

  const handleOpenExternal = useCallback(() => {
    window.open(baseUrl, '_blank', 'noopener');
  }, [baseUrl]);

  return (
    <Flex direction="column" style={{ height: '100%' }}>
      {/* Toolbar */}
      <Card padding={2} borderBottom>
        <Flex align="center" justify="space-between">
          <Flex align="center" gap={2}>
            <Text size={1} weight="medium">
              Lamina Editor
            </Text>
            {saving ? (
              <Flex align="center" gap={2}>
                <Spinner />
                <Text size={1} muted>
                  Saving to Sanity...
                </Text>
              </Flex>
            ) : null}
            {lastSaved && !saving ? (
              <Text size={1} muted>
                Saved: {lastSaved}
              </Text>
            ) : null}
            {errorMessage ? (
              <Card padding={2} radius={2} tone="critical">
                <Text size={1}>{errorMessage}</Text>
              </Card>
            ) : null}
          </Flex>
          <Button
            text="Open in new tab"
            icon={LaunchIcon}
            mode="ghost"
            fontSize={1}
            padding={2}
            onClick={handleOpenExternal}
          />
        </Flex>
      </Card>

      {/* Embedded editor */}
      <Box flex={1} style={{ position: 'relative' }}>
        <iframe
          ref={iframeRef}
          src={embedUrl}
          title="Lamina Editor"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            border: 'none',
          }}
          allow="clipboard-write"
        />
      </Box>
    </Flex>
  );
}
