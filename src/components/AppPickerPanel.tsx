/**
 * AppPickerPanel
 *
 * Self-contained app picker UI rendered inside the GenerateDialog when the user
 * expands "Choose a specific app (optional)".
 *
 * Features:
 *   - Debounced search-as-you-type — typing triggers `onSearchSubmit(query)`
 *     after 500ms of inactivity. Parent fires apps.discover(query) and pipes
 *     results back via `apps`. Empty query → parent should revert to apps.list().
 *   - Modality toggle — when apps carry modality metadata, default-filter to
 *     the field's modality with a "Show all" escape.
 *   - Card grid — 16:9 thumbnails (image or video preview), 2 columns,
 *     responsive. Cards without thumbnails get a uniform "No preview" placeholder.
 *
 * The parent (GenerateDialog) owns the apps[] state and load logic; this
 * component is pure presentation + local search-input state + debounce.
 */

import {
  Box,
  Button,
  Card,
  Flex,
  Spinner,
  Stack,
  Text,
  TextInput,
} from '@sanity/ui';
import { CheckmarkCircleIcon, SearchIcon } from '@sanity/icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { LaminaPreset } from '../types.js';

const SEARCH_DEBOUNCE_MS = 500;

// ─── Types ──────────────────────────────────────────────────────────────────

export type AppPickerMode = 'list' | 'discover';

export interface AppPickerEntry {
  appId: string;
  name: string;
  description: string | null;
  modality?: string | null;
  outputFormats?: string[];
  thumbnail?: { url: string; type: 'image' | 'video' } | null;
}

interface AppPickerPanelProps {
  /** Loaded apps (already mapped from list/discover response). */
  apps: AppPickerEntry[];
  /** Currently selected appId (highlighted in the grid). */
  selectedAppId: string | null;
  /** Mode of the loaded apps: 'list' = all available, 'discover' = ranked-by-search-query. */
  mode: AppPickerMode;
  /** True while the parent is loading apps. */
  loading: boolean;
  /** Error from a failed load (or null). */
  error: string | null;
  /** Field's target modality (e.g. 'image', 'video') used by the modality toggle. */
  targetModality: string | null;
  /** Pin/unpin an app. Parent handles routing memory + estimate fetch. */
  onSelect: (app: AppPickerEntry) => void;
  /**
   * Fired AFTER the user pauses typing for SEARCH_DEBOUNCE_MS.
   * Parent should call apps.discover(query) when query is non-empty,
   * or apps.list() when query is empty (to revert to "all apps").
   */
  onSearchSubmit: (query: string) => void;
  /** Clear the pinned selection. */
  onClearSelection: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function AppPickerPanel({
  apps,
  selectedAppId,
  mode,
  loading,
  error,
  targetModality,
  onSelect,
  onSearchSubmit,
  onClearSelection,
}: AppPickerPanelProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [showAllModalities, setShowAllModalities] = useState(false);

  // Debounce: when the user stops typing for SEARCH_DEBOUNCE_MS, fire the
  // submit callback. Parent calls apps.discover(query) (or list() on empty).
  // We track the last-submitted value to avoid redundant calls when state
  // re-renders without an actual text change.
  const lastSubmittedRef = useRef<string | null>(null);
  useEffect(() => {
    const trimmed = searchTerm.trim();
    if (lastSubmittedRef.current === trimmed) return;
    const timer = setTimeout(() => {
      lastSubmittedRef.current = trimmed;
      onSearchSubmit(trimmed);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchTerm, onSearchSubmit]);

  const hasAppsWithModality = apps.some((a) => Boolean(a.modality));
  const filterByModality = hasAppsWithModality && !showAllModalities && targetModality;

  // Modality is the only client-side filter — text matching is server-side via
  // discover(). Keeps the result set consistent with what the server scored.
  const visibleApps = useMemo(() => {
    if (!filterByModality) return apps;
    return apps.filter((app) => !app.modality || app.modality === targetModality);
  }, [apps, filterByModality, targetModality]);

  const headerText =
    mode === 'discover' && lastSubmittedRef.current
      ? `Results for "${lastSubmittedRef.current}"`
      : 'Available apps';

  return (
    <Card padding={3} radius={2} border>
      <Stack space={3}>
        {/* Search input — debounced 500ms, drives discover() */}
        <TextInput
          icon={SearchIcon}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.currentTarget.value)}
          placeholder="Search apps (e.g. 'product image', 'reel video')…"
          fontSize={1}
        />

        {/* Header line + modality toggle */}
        <Flex align="center" justify="space-between" gap={2}>
          <Text size={1} weight="medium">
            {headerText}
          </Text>
          {hasAppsWithModality ? (
            <Button
              text={filterByModality ? `Showing ${targetModality} only` : 'Showing all'}
              mode="bleed"
              fontSize={0}
              padding={1}
              onClick={() => setShowAllModalities((v) => !v)}
            />
          ) : null}
        </Flex>

        {/* Loading / error / empty / grid */}
        {loading ? (
          <Flex align="center" justify="center" padding={4}>
            <Spinner />
          </Flex>
        ) : error ? (
          <Card padding={2} radius={2} tone="critical">
            <Text size={1}>{error}</Text>
          </Card>
        ) : visibleApps.length === 0 ? (
          <Text size={1} muted>
            {searchTerm.trim() ? `No apps match "${searchTerm.trim()}".` : 'No apps found.'}
          </Text>
        ) : (
          <Box style={{ maxHeight: 480, overflowY: 'auto' }}>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                gap: 8,
              }}
            >
              {visibleApps.map((app) => (
                <AppCard
                  key={app.appId}
                  app={app}
                  selected={selectedAppId === app.appId}
                  onClick={() => onSelect(app)}
                />
              ))}
            </Box>
          </Box>
        )}

        {/* Clear pinned-app selection */}
        {selectedAppId ? (
          <Button
            text="Clear selection"
            mode="ghost"
            fontSize={1}
            onClick={onClearSelection}
          />
        ) : null}
      </Stack>
    </Card>
  );
}

// ─── Card (16:9 thumbnail + caption) ────────────────────────────────────────

function AppCard({
  app,
  selected,
  onClick,
}: {
  app: AppPickerEntry;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Card
      padding={0}
      radius={2}
      border
      tone={selected ? 'primary' : 'default'}
      style={{ cursor: 'pointer', overflow: 'hidden' }}
      onClick={onClick}
    >
      <ThumbnailMedia thumbnail={app.thumbnail || null} selected={selected} />
      <Box padding={3}>
        <Stack space={3}>
          <Flex align="center" gap={2}>
            {selected ? <CheckmarkCircleIcon /> : null}
            <Text size={1} weight="medium" style={{ flex: 1, lineHeight: 1.3 }}>
              {app.name}
            </Text>
          </Flex>
          {app.description ? (
            <Text size={1} muted textOverflow="ellipsis" style={{ lineHeight: 1.4 }}>
              {app.description}
            </Text>
          ) : null}
          {app.outputFormats?.length ? (
            <Text size={0} muted>
              {app.outputFormats.join(', ')}
            </Text>
          ) : null}
        </Stack>
      </Box>
    </Card>
  );
}

// ─── Thumbnail (16:9 image or autoplay-loop video) ─────────────────────────

function ThumbnailMedia({
  thumbnail,
  selected,
}: {
  thumbnail: AppPickerEntry['thumbnail'];
  selected: boolean;
}) {
  const wrapperStyle: React.CSSProperties = {
    width: '100%',
    aspectRatio: '3 / 4', // portrait — fits 4-up grid without dwarfing the captions
    background: 'var(--card-muted-fg-color, rgba(0,0,0,0.05))',
    display: 'block',
    objectFit: 'cover',
  };

  if (!thumbnail) {
    // Placeholder for cards without media — keeps the grid uniform.
    return (
      <Box
        style={{
          ...wrapperStyle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text size={0} muted>No preview</Text>
      </Box>
    );
  }

  if (thumbnail.type === 'video') {
    return (
      <video
        src={thumbnail.url}
        autoPlay
        loop
        muted
        playsInline
        style={wrapperStyle}
      />
    );
  }

  return <img src={thumbnail.url} alt="" style={wrapperStyle} />;
}

// Re-export so GenerateDialog's import doesn't need 'LaminaPreset'.
export type { LaminaPreset };
