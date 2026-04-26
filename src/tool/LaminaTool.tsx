import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Flex,
  Grid,
  Select,
  Spinner,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Text,
  TextInput,
} from '@sanity/ui';
import { LaunchIcon, ImageIcon, ResetIcon, SearchIcon } from '@sanity/icons';
import { useClient } from 'sanity';
import { useLamina } from '../lib/LaminaContext.js';
const LAMINA_ORIGIN = 'https://app.uselamina.ai';

interface LaminaMessage {
  type: 'lamina:asset-ready' | 'lamina:editor-close' | 'lamina:embed-ready';
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

type AssetTypeFilter = 'all' | 'images' | 'videos';

const PAGE_SIZE = 24;

function buildAssetQuery(filter: AssetTypeFilter, search: string): string {
  const typeConditions: Record<AssetTypeFilter, string> = {
    all: '_type in ["sanity.imageAsset", "sanity.fileAsset"]',
    images: '_type == "sanity.imageAsset"',
    videos: '_type == "sanity.fileAsset" && mimeType match "video/*"',
  };

  const searchCondition = search.trim()
    ? ` && originalFilename match "*${search.trim()}*"`
    : '';

  return `*[${typeConditions[filter]} && source.name == "lamina"${searchCondition}] | order(_createdAt desc)`;
}

function AssetBrowser() {
  const sanityClient = useClient({ apiVersion: '2024-01-01' });
  const [assets, setAssets] = useState<LaminaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<AssetTypeFilter>('all');
  const [search, setSearch] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchAssets = useCallback(async (offset: number, append: boolean) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const query = buildAssetQuery(typeFilter, search);
      const result = await sanityClient.fetch<LaminaAsset[]>(
        `${query} [${offset}...${offset + PAGE_SIZE + 1}] {
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
      const fetched = result ?? [];
      const pageItems = fetched.slice(0, PAGE_SIZE);
      setHasMore(fetched.length > PAGE_SIZE);
      setAssets((prev) => (append ? [...prev, ...pageItems] : pageItems));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assets');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [sanityClient, typeFilter, search]);

  // Reset and fetch when filter or search changes
  useEffect(() => {
    fetchAssets(0, false);
  }, [fetchAssets]);

  const handleLoadMore = useCallback(() => {
    if (!loadingMore && hasMore) {
      fetchAssets(assets.length, true);
    }
  }, [fetchAssets, assets.length, loadingMore, hasMore]);

  // Infinite scroll: load more when scrolled near bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
      if (nearBottom && hasMore && !loadingMore) {
        handleLoadMore();
      }
    };

    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [hasMore, loadingMore, handleLoadMore]);

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

  return (
    <Box padding={3} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Stack space={3} style={{ flexShrink: 0 }}>
        {/* Filters */}
        <Flex align="center" gap={2}>
          <Box style={{ flex: 1 }}>
            <TextInput
              icon={SearchIcon}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              placeholder="Search by filename..."
              fontSize={1}
            />
          </Box>
          <Select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.currentTarget.value as AssetTypeFilter)}
            fontSize={1}
            style={{ width: 130 }}
          >
            <option value="all">All types</option>
            <option value="images">Images</option>
            <option value="videos">Videos</option>
          </Select>
          <Button
            icon={ResetIcon}
            mode="ghost"
            fontSize={1}
            padding={2}
            title="Refresh"
            onClick={() => fetchAssets(0, false)}
          />
        </Flex>

        <Text size={1} weight="medium">
          {assets.length}{hasMore ? '+' : ''} Lamina asset{assets.length !== 1 ? 's' : ''}
        </Text>
      </Stack>

      {assets.length === 0 ? (
        <Flex align="center" justify="center" padding={5} direction="column" gap={3} style={{ flex: 1 }}>
          <ImageIcon />
          <Text size={1} muted>
            {search || typeFilter !== 'all'
              ? 'No assets match your filters'
              : 'No Lamina-generated assets yet'}
          </Text>
          {!search && typeFilter === 'all' ? (
            <Text size={1} muted>
              Generate assets using the editor or image field dropdowns
            </Text>
          ) : null}
        </Flex>
      ) : (
        <Box ref={scrollRef} style={{ flex: 1, overflowY: 'auto', marginTop: 12 }}>
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
                    ) : asset.mimeType?.startsWith('video/') ? (
                      <video
                        src={asset.url}
                        muted
                        loop
                        autoPlay
                        playsInline
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
          {loadingMore ? (
            <Flex align="center" justify="center" padding={4}>
              <Spinner />
            </Flex>
          ) : null}
        </Box>
      )}
    </Box>
  );
}

export function LaminaTool() {
  const { client: laminaClient, options, token } = useLamina();
  const sanityClient = useClient({ apiVersion: '2024-01-01' });
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'editor' | 'assets'>('editor');

  const baseUrl = options.baseUrl || LAMINA_ORIGIN;
  // Load iframe without credentials — auth is handled via postMessage handshake
  const embedUrl = `${baseUrl}/embed`;

  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      if (event.origin !== baseUrl) return;
      if (!isLaminaMessage(event.data)) return;

      const msg = event.data;

      // Step 2: Iframe signals it's ready — send auth credentials via postMessage
      if (msg.type === 'lamina:embed-ready') {
        const iframe = iframeRef.current;
        if (!iframe?.contentWindow) return;

        // Send credential in the field the Lamina-side embedAuthRouter expects:
        // { token } for API keys → validateApiKey path
        // { oauthToken } for OAuth → validateBearerToken path
        const authPayload = options.oauth
          ? { type: 'lamina:auth' as const, oauthToken: token }
          : { type: 'lamina:auth' as const, token };
        iframe.contentWindow.postMessage(authPayload, baseUrl);

        // Send document context (generic for standalone tool)
        iframe.contentWindow.postMessage(
          {
            type: 'lamina:context',
            schemaType: null,
            fieldType: null,
            brandProfileId: null,
            suggestedModality: null,
          },
          baseUrl,
        );
        return;
      }

      if (msg.type === 'lamina:asset-ready' && msg.url) {
        setSaving(true);
        setErrorMessage(null);
        try {
          const assetType = msg.mediaType === 'video' ? 'file' : 'image';
          const mediaType: 'image' | 'video' = msg.mediaType === 'video' ? 'video' : 'image';
          const filename = msg.filename || `lamina-${msg.runId || 'asset'}`;

          // Proxy through transferAsset to avoid CORS issues with cdn.uselamina.ai
          let downloadUrl = msg.url;
          try {
            const transferred = await laminaClient.publishing.transferAsset({
              sourceUrl: msg.url,
              mediaType,
              filename,
            });
            downloadUrl = transferred.data.cdnUrl;
          } catch {
            // Fall back to direct URL if transferAsset isn't available
          }

          let response: Response;
          try {
            response = await fetch(downloadUrl);
          } catch (fetchErr) {
            const detail =
              fetchErr instanceof TypeError
                ? 'Failed to download asset. The CDN may not allow cross-origin requests from this Studio.'
                : 'Network request failed.';
            throw new Error(detail);
          }

          if (!response.ok) {
            throw new Error(
              `Failed to download asset: HTTP ${response.status} ${response.statusText}`,
            );
          }

          const blob = await response.blob();

          try {
            await sanityClient.assets.upload(assetType, blob, {
              filename,
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

          setLastSaved(filename);
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
    [baseUrl, laminaClient, sanityClient, token, options.oauth],
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
