import { useCallback, useEffect, useRef, useState } from 'react';
import { useClient } from 'sanity';
import type { AssetTypeFilter, LaminaAsset } from '../types.js';

const PAGE_SIZE = 24;

/** Where the asset originated. `lamina` → only assets generated via the
 *  plugin (carry `source.name == "lamina"` metadata). `all` → every asset
 *  in the dataset matching the type filter, regardless of origin. */
export type AssetSourceFilter = 'lamina' | 'all';

function buildAssetQuery(
  filter: AssetTypeFilter,
  search: string,
  documentId: string | undefined,
  sourceFilter: AssetSourceFilter,
): string {
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

  const sourceCondition = sourceFilter === 'lamina' ? ' && source.name == "lamina"' : '';

  return `*[${typeConditions[filter]}${sourceCondition}${searchCondition}${documentCondition}] | order(_createdAt desc)`;
}

export interface UseSanityAssetsOptions {
  typeFilter: AssetTypeFilter;
  search: string;
  pageSize?: number;
  /** When set, only return assets generated from this Sanity document. */
  documentId?: string;
  /** Default 'lamina' — preserves the original useLaminaAssets behavior. Set
   *  to 'all' to fetch every asset of the matching type (e.g., for the
   *  upload-form "Browse from library" picker). */
  sourceFilter?: AssetSourceFilter;
}

export interface UseSanityAssetsResult {
  assets: LaminaAsset[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  loadMore: () => void;
  refresh: () => void;
  totalLabel: string;
}

export function useSanityAssets(options: UseSanityAssetsOptions): UseSanityAssetsResult {
  const {
    typeFilter,
    search,
    pageSize = PAGE_SIZE,
    documentId,
    sourceFilter = 'lamina',
  } = options;
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
      const query = buildAssetQuery(typeFilter, search, documentId, sourceFilter);
      const result = await sanityClient.fetch<LaminaAsset[]>(
        `${query} [${offset}...${offset + ps + 1}] {
          _id,
          _type,
          url,
          originalFilename,
          mimeType,
          size,
          _createdAt,
          description,
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
  }, [sanityClient, typeFilter, search, documentId, sourceFilter]);

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

  const totalLabel = (() => {
    const noun = sourceFilter === 'lamina' ? 'Lamina asset' : 'asset';
    const plural = assets.length !== 1 ? 's' : '';
    return `${assets.length}${hasMore ? '+' : ''} ${noun}${plural}`;
  })();

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
