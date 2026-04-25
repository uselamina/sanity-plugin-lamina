import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Flex,
  Grid,
  Spinner,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Text,
} from '@sanity/ui';
import { LaunchIcon, ImageIcon, ResetIcon } from '@sanity/icons';
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

interface LaminaAsset {
  _id: string;
  _type: string;
  url: string;
  originalFilename: string | null;
  mimeType: string | null;
  size: number | null;
  _createdAt: string;
  source: {
    name: string;
    id: string;
    url?: string;
  } | null;
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

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AssetBrowser() {
  const sanityClient = useClient({ apiVersion: '2024-01-01' });
  const [assets, setAssets] = useState<LaminaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAssets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await sanityClient.fetch<LaminaAsset[]>(
        `*[_type in ["sanity.imageAsset", "sanity.fileAsset"] && source.name == "lamina"] | order(_createdAt desc) [0...50] {
          _id,
          _type,
          url,
          originalFilename,
          mimeType,
          size,
          _createdAt,
          source
        }`,
      );
      setAssets(result ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assets');
    } finally {
      setLoading(false);
    }
  }, [sanityClient]);

  useEffect(() => {
    fetchAssets();
  }, [fetchAssets]);

  if (loading) {
    return (
      <Flex align="center" justify="center" padding={5}>
        <Spinner />
      </Flex>
    );
  }

  if (error) {
    return (
      <Box padding={4}>
        <Card padding={3} radius={2} tone="critical">
          <Text size={1}>{error}</Text>
        </Card>
      </Box>
    );
  }

  if (assets.length === 0) {
    return (
      <Flex align="center" justify="center" padding={5} direction="column" gap={3}>
        <ImageIcon />
        <Text size={1} muted>
          No Lamina-generated assets yet
        </Text>
        <Text size={1} muted>
          Generate assets using the editor or image field dropdowns
        </Text>
      </Flex>
    );
  }

  return (
    <Box padding={3} style={{ overflowY: 'auto', height: '100%' }}>
      <Stack space={3}>
        <Flex align="center" justify="space-between">
          <Text size={1} weight="medium">
            {assets.length} Lamina asset{assets.length !== 1 ? 's' : ''}
          </Text>
          <Button
            icon={ResetIcon}
            mode="ghost"
            fontSize={1}
            padding={2}
            text="Refresh"
            onClick={fetchAssets}
          />
        </Flex>
        <Grid columns={3} gap={3}>
          {assets.map((asset) => {
            const isImage = asset._type === 'sanity.imageAsset';
            return (
              <Card key={asset._id} padding={2} radius={2} border>
                <Stack space={2}>
                  {isImage ? (
                    <img
                      src={`${asset.url}?w=200&h=200&fit=crop`}
                      alt={asset.originalFilename ?? ''}
                      style={{
                        width: '100%',
                        aspectRatio: '1',
                        objectFit: 'cover',
                        borderRadius: 4,
                      }}
                    />
                  ) : (
                    <Flex
                      align="center"
                      justify="center"
                      style={{
                        width: '100%',
                        aspectRatio: '1',
                        backgroundColor: 'var(--card-bg2-color)',
                        borderRadius: 4,
                      }}
                    >
                      <Text size={1} muted>
                        {asset.mimeType?.split('/')[1]?.toUpperCase() || 'FILE'}
                      </Text>
                    </Flex>
                  )}
                  <Text size={0} textOverflow="ellipsis">
                    {asset.originalFilename || asset._id}
                  </Text>
                  <Flex align="center" justify="space-between">
                    <Text size={0} muted>
                      {formatFileSize(asset.size)}
                    </Text>
                    {asset.source?.url ? (
                      <Button
                        text="Open run"
                        mode="ghost"
                        fontSize={0}
                        padding={1}
                        onClick={() =>
                          window.open(asset.source!.url, '_blank', 'noopener')
                        }
                      />
                    ) : null}
                  </Flex>
                </Stack>
              </Card>
            );
          })}
        </Grid>
      </Stack>
    </Box>
  );
}

export function LaminaTool() {
  const { options } = useLamina();
  const sanityClient = useClient({ apiVersion: '2024-01-01' });
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'editor' | 'assets'>('editor');

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
          <Flex align="center" gap={3}>
            <TabList space={1}>
              <Tab
                id="lamina-tab-editor"
                label="Editor"
                aria-controls="lamina-panel-editor"
                selected={activeTab === 'editor'}
                onClick={() => setActiveTab('editor')}
                fontSize={1}
                padding={2}
              />
              <Tab
                id="lamina-tab-assets"
                label="Assets"
                aria-controls="lamina-panel-assets"
                selected={activeTab === 'assets'}
                onClick={() => setActiveTab('assets')}
                fontSize={1}
                padding={2}
              />
            </TabList>
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

      {/* Tab content */}
      <Box flex={1} style={{ position: 'relative' }}>
        <TabPanel
          id="lamina-panel-editor"
          aria-labelledby="lamina-tab-editor"
          hidden={activeTab !== 'editor'}
          style={{ position: 'absolute', inset: 0 }}
        >
          <iframe
            ref={iframeRef}
            src={embedUrl}
            title="Lamina Editor"
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
            }}
            allow="clipboard-write"
          />
        </TabPanel>
        <TabPanel
          id="lamina-panel-assets"
          aria-labelledby="lamina-tab-assets"
          hidden={activeTab !== 'assets'}
          style={{ position: 'absolute', inset: 0, overflowY: 'auto' }}
        >
          <AssetBrowser />
        </TabPanel>
      </Box>
    </Flex>
  );
}
