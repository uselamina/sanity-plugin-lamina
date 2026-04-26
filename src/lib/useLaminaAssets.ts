import { useCallback, useEffect, useRef, useState } from 'react';
import { useClient } from 'sanity';
import type { AssetTypeFilter, LaminaAsset } from '../types.js';

const PAGE_SIZE = 24;

function buildAssetQuery(filter: AssetTypeFilter, search: string, documentId?: string): string {
  const typeConditions: Record<AssetTypeFilter, string> = {
    all: '_type in ["sanity.imageAsset", "sanity.fileAsset"]',
    images: '_type == "sanity.imageAsset"',
    videos: '_type == "sanity.fileAsset" && mimeType match "video/*"',
  };

  const searchCondition = search.trim()
    ? ` && originalFilename match "*${search.trim()}*"`
    : '';

  const documentCondition = documentId
    ? ` && source.documentId == "${documentId}"`
    : '';

  return `*[${typeConditions[filter]} && source.name == "lamina"${searchCondition}${documentCondition}] | order(_createdAt desc)`;
}

export interface UseLaminaAssetsOptions {
  typeFilter: AssetTypeFilter;
  search: string;
  pageSize?: number;
  /** When set, only return assets generated from this Sanity document. */
  documentId?: string;
}

export interface UseLaminaAssetsResult {
  assets: LaminaAsset[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  loadMore: () => void;
  refresh: () => void;
  totalLabel: string;
}

export function useLaminaAssets(options: UseLaminaAssetsOptions): UseLaminaAssetsResult {
  const { typeFilter, search, pageSize = PAGE_SIZE, documentId } = options;
  const sanityClient = useClient({ apiVersion: '2024-01-01' });
  const [assets, setAssets] = useState<LaminaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef({ pageSize });
  scrollRef.current.pageSize = pageSize;

  const fetchAssets = useCallback(async (offset: number, append: boolean) => {
    const ps = scrollRef.current.pageSize;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const query = buildAssetQuery(typeFilter, search, documentId);
      const result = await sanityClient.fetch<LaminaAsset[]>(
        `${query} [${offset}...${offset + ps + 1}] {
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
      const pageItems = fetched.slice(0, ps);
      setHasMore(fetched.length > ps);
      setAssets((prev) => (append ? [...prev, ...pageItems] : pageItems));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assets');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [sanityClient, typeFilter, search, documentId]);

  // Reset and fetch when filter or search changes
  useEffect(() => {
    fetchAssets(0, false);
  }, [fetchAssets]);

  const loadMore = useCallback(() => {
    if (!loadingMore && hasMore) {
      fetchAssets(assets.length, true);
    }
  }, [fetchAssets, assets.length, loadingMore, hasMore]);

  const refresh = useCallback(() => {
    fetchAssets(0, false);
  }, [fetchAssets]);

  const totalLabel = `${assets.length}${hasMore ? '+' : ''} Lamina asset${assets.length !== 1 ? 's' : ''}`;

  return {
    assets,
    loading,
    loadingMore,
    hasMore,
    error,
    loadMore,
    refresh,
    totalLabel,
  };
}
