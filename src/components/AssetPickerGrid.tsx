import { useEffect, useRef } from 'react';
import {
  Box,
  Button,
  Card,
  Flex,
  Grid,
  Spinner,
  Stack,
  Text,
} from '@sanity/ui';
import { CheckmarkCircleIcon, ImageIcon } from '@sanity/icons';
import type { LaminaAsset } from '../types.js';

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AssetPickerGridProps {
  assets: LaminaAsset[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  columns?: number;
  emptyMessage?: string;
  onSelect?: (asset: LaminaAsset) => void;
  onLoadMore?: () => void;
}

export function AssetPickerGrid(props: AssetPickerGridProps) {
  const {
    assets,
    loading,
    loadingMore,
    hasMore,
    columns = 3,
    emptyMessage,
    onSelect,
    onLoadMore,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);

  // Infinite scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !onLoadMore) return;

    const handleScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
      if (nearBottom && hasMore && !loadingMore) {
        onLoadMore();
      }
    };

    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [hasMore, loadingMore, onLoadMore]);

  if (loading) {
    return (
      <Flex align="center" justify="center" padding={5}>
        <Spinner />
      </Flex>
    );
  }

  if (assets.length === 0) {
    return (
      <Flex align="center" justify="center" padding={5} direction="column" gap={3} style={{ flex: 1 }}>
        <ImageIcon />
        <Text size={1} muted>
          {emptyMessage ?? 'No Lamina-generated assets yet'}
        </Text>
      </Flex>
    );
  }

  return (
    <Box ref={scrollRef} style={{ flex: 1, overflowY: 'auto' }}>
      <Grid columns={columns} gap={3}>
        {assets.map((asset) => {
          const isImage = asset._type === 'sanity.imageAsset';
          return (
            <Card
              key={asset._id}
              padding={2}
              radius={2}
              border
              style={onSelect ? { cursor: 'pointer' } : undefined}
              onClick={onSelect ? () => onSelect(asset) : undefined}
            >
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
                  {onSelect ? (
                    <Button
                      text="Use this"
                      icon={CheckmarkCircleIcon}
                      mode="ghost"
                      tone="positive"
                      fontSize={0}
                      padding={1}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(asset);
                      }}
                    />
                  ) : asset.source?.url ? (
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
  );
}
