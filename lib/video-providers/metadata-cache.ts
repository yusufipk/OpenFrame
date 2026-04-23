import type { VideoMetadata } from './types';

type CacheEntry = {
  value: VideoMetadata;
  expiresAt: number;
};

const MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const cache = new Map<string, CacheEntry>();

function pruneIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return;
  const overflow = cache.size - MAX_ENTRIES;
  for (let i = 0; i < overflow; i += 1) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) return;
    cache.delete(oldestKey);
  }
}

export function getCachedMetadata(key: string): VideoMetadata | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

export function setCachedMetadata(
  key: string,
  value: VideoMetadata,
  ttlMs: number = DEFAULT_TTL_MS
): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  pruneIfNeeded();
}
