'use client';

import { useSyncExternalStore } from 'react';
import { STACKED_LAYOUT_QUERY } from '@/components/video-page/stacked-layout';

function subscribe(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(STACKED_LAYOUT_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function getSnapshot() {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(STACKED_LAYOUT_QUERY).matches;
}

/**
 * Whether the review page stacks the comments under the player (see `narrow`). The
 * server, and anything without a media query engine, gets the desktop layout.
 */
export function useStackedLayout(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
