import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Flex,
  Select,
  Spinner,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Text,
  TextInput,
} from '@sanity/ui';
import { LaunchIcon, ResetIcon, SearchIcon } from '@sanity/icons';
import { useClient } from 'sanity';
import { useLamina } from '../lib/LaminaContext.js';
import { getDocumentContext } from '../lib/documentContext.js';
import { useSanityAssets } from '../lib/useSanityAssets.js';
import { AssetPickerGrid } from '../components/AssetPickerGrid.js';
import type { AssetTypeFilter } from '../types.js';
const LAMINA_ORIGIN = 'https://app.uselamina.ai';

interface LaminaMessage {
  type: 'lamina:asset-ready' | 'lamina:editor-close' | 'lamina:embed-ready';
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

interface HistoryEntry {
  _id: string;
  _type: string;
  _createdAt: string;
  url: string;
  originalFilename: string | null;
  mimeType: string | null;
  description: string | null;
  source: { name: string; id: string; url?: string } | null;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString();
}

function GenerationHistory() {
  const sanityClient = useClient({ apiVersion: '2024-01-01' });
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await sanityClient.fetch<HistoryEntry[]>(
          `*[_type in ["sanity.imageAsset", "sanity.fileAsset"] && source.name == "lamina"] | order(_createdAt desc) [0...50] {
            _id, _type, _createdAt, url, originalFilename, mimeType, description, source
          }`,
        );
        if (!cancelled) setEntries(result ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load history');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sanityClient]);

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

  if (entries.length === 0) {
    return (
      <Flex align="center" justify="center" padding={5}>
        <Text size={1} muted>No generation history yet</Text>
      </Flex>
    );
  }

  // Group by date
  const groups: Array<{ label: string; items: HistoryEntry[] }> = [];
  let currentLabel = '';
  for (const entry of entries) {
    const label = formatDate(entry._createdAt);
    if (label !== currentLabel) {
      groups.push({ label, items: [entry] });
      currentLabel = label;
    } else {
      groups[groups.length - 1].items.push(entry);
    }
  }

  return (
    <Box padding={3}>
      <Stack space={4}>
        <Text size={1} weight="medium">Recent generations</Text>
        {groups.map((group) => (
          <Stack key={group.label} space={2}>
            <Text size={0} muted weight="medium">{group.label}</Text>
            {group.items.map((entry) => {
              const isImage = entry._type === 'sanity.imageAsset';
              return (
                <Card key={entry._id} padding={2} radius={2} border>
                  <Flex gap={3} align="center">
                    {isImage ? (
                      <img
                        src={`${entry.url}?w=60&h=60&fit=crop`}
                        alt=""
                        style={{ width: 48, height: 48, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }}
                      />
                    ) : (
                      <Box
                        style={{
                          width: 48,
                          height: 48,
                          borderRadius: 4,
                          backgroundColor: 'var(--card-bg2-color)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <Text size={0} muted>
                          {entry.mimeType?.split('/')[1]?.toUpperCase() || 'FILE'}
                        </Text>
                      </Box>
                    )}
                    <Stack space={1} style={{ flex: 1, minWidth: 0 }}>
                      {entry.description ? (
                        <Text size={1} textOverflow="ellipsis">
                          {entry.description}
                        </Text>
                      ) : (
                        <Text size={1} muted textOverflow="ellipsis">
                          {entry.originalFilename || entry._id}
                        </Text>
                      )}
                      <Text size={0} muted>
                        {new Date(entry._createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {entry.mimeType ? ` · ${entry.mimeType}` : ''}
                      </Text>
                    </Stack>
                    {entry.source?.url ? (
                      <Button
                        icon={LaunchIcon}
                        mode="ghost"
                        fontSize={0}
                        padding={1}
                        title="Open in Lamina"
                        onClick={() => window.open(entry.source!.url, '_blank', 'noopener')}
                      />
                    ) : null}
                  </Flex>
                </Card>
              );
            })}
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

function AssetBrowser() {
  const [typeFilter, setTypeFilter] = useState<AssetTypeFilter>('all');
  const [search, setSearch] = useState('');

  const {
    assets,
    loading,
    loadingMore,
    hasMore,
    error,
    loadMore,
    refresh,
    totalLabel,
  } = useSanityAssets({ typeFilter, search });

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
            onClick={refresh}
          />
        </Flex>
        <Text size={1} weight="medium">
          {totalLabel}
        </Text>
      </Stack>

      <Box style={{ flex: 1, marginTop: 12 }}>
        <AssetPickerGrid
          assets={assets}
          loading={loading}
          loadingMore={loadingMore}
          hasMore={hasMore}
          onLoadMore={loadMore}
          emptyMessage={
            search || typeFilter !== 'all'
              ? 'No assets match your filters'
              : undefined
          }
        />
      </Box>
    </Box>
  );
}

export function LaminaTool() {
  const { client: laminaClient, options, token } = useLamina();
  const sanityClient = useClient({ apiVersion: '2024-01-01' });
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [saving, setSaving] = useState(false);
  const [savingPhase, setSavingPhase] = useState<'downloading' | 'uploading' | null>(null);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'editor' | 'assets' | 'history'>('editor');

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

        // Send document context from last-viewed document (if available)
        const docCtx = getDocumentContext();
        iframe.contentWindow.postMessage(
          {
            type: 'lamina:context',
            schemaType: docCtx?.documentType ?? null,
            documentTitle: docCtx?.documentTitle ?? null,
            fieldType: docCtx?.fieldType ?? null,
            brandProfileId: null,
            suggestedModality: docCtx?.fieldType === 'file' ? 'video' : docCtx?.fieldType === 'image' ? 'image' : null,
          },
          baseUrl,
        );
        return;
      }

      if (msg.type === 'lamina:asset-ready' && msg.url) {
        setSaving(true);
        setSavingPhase('downloading');
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

          setSavingPhase('uploading');
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
          setSavingPhase(null);
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
              <Tab
                id="lamina-tab-history"
                label="History"
                aria-controls="lamina-panel-history"
                selected={activeTab === 'history'}
                onClick={() => setActiveTab('history')}
                fontSize={1}
                padding={2}
              />
            </TabList>
            {saving ? (
              <Flex align="center" gap={2}>
                <Spinner />
                <Text size={1} muted>
                  {savingPhase === 'uploading' ? 'Uploading to Sanity...' : 'Downloading asset...'}
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
        <TabPanel
          id="lamina-panel-history"
          aria-labelledby="lamina-tab-history"
          hidden={activeTab !== 'history'}
          style={{ position: 'absolute', inset: 0, overflowY: 'auto' }}
        >
          <GenerationHistory />
        </TabPanel>
      </Box>
    </Flex>
  );
}
