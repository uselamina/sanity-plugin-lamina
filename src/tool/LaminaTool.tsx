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
import { useLaminaAssets } from '../lib/useLaminaAssets.js';
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
  } = useLaminaAssets({ typeFilter, search });

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
