'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Fetches a signed Bunny CDN directory (`.../<guid>/`) from one of the playback
 * routes and keeps it fresh.
 *
 * `baseUrl` is the first grant for the current endpoint and does not change on
 * refresh, so a player keyed on it is set up once. Later grants only land in
 * `getLatestBaseUrl()`, which retry and recovery paths read when they reload a
 * source, so a refresh never restarts playback.
 */

export type BunnyPlaybackSource = {
  /** First signed base for this endpoint, or null while loading or on failure. */
  baseUrl: string | null;
  /** True while no grant could be fetched; retried in the background. */
  failed: boolean;
  /** Most recent signed base (initial or refreshed). */
  getLatestBaseUrl: () => string | null;
  /** Fetches a new grant unless an attempt was made within the last minute. */
  refresh: () => Promise<string | null>;
};

// `expiresAtMs` is on this browser's clock, not the server's: see fetchGrant.
type Grant = { baseUrl: string; expiresAtMs: number | null };

// Ask for a new grant this long before the current one expires. Grants live for
// six hours or more, so this leaves plenty of room for a slow network.
const REFRESH_LEAD_MS = 30 * 60 * 1000;
// A 403 from Bunny looks the same whether the token expired or the video is still
// encoding, and the players retry every few seconds while they wait. Counting
// attempts rather than successes keeps those retries, and a playback route that
// is refusing or rate limiting, down to one request a minute.
const MIN_ATTEMPT_INTERVAL_MS = 60 * 1000;

async function fetchGrant(endpoint: string): Promise<Grant | null> {
  const response = await fetch(endpoint, { cache: 'no-store' });
  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  const data = (body as { data?: { baseUrl?: unknown; expiresAt?: unknown } } | null)?.data;
  if (!data || typeof data.baseUrl !== 'string' || !data.baseUrl.startsWith('https://')) {
    return null;
  }
  if (typeof data.expiresAt !== 'number') return { baseUrl: data.baseUrl, expiresAtMs: null };
  // The server's expiry is on the server's clock. Measure the remaining lifetime
  // against the server's Date header and add it to the local clock, so a browser
  // whose clock is hours off still refreshes on time instead of once a minute.
  const serverNowMs = Date.parse(response.headers.get('date') ?? '');
  const remainingMs =
    data.expiresAt * 1000 - (Number.isFinite(serverNowMs) ? serverNowMs : Date.now());
  return { baseUrl: data.baseUrl, expiresAtMs: Date.now() + remainingMs };
}

export function useBunnyPlaybackSource(endpoint: string | null): BunnyPlaybackSource {
  const [initial, setInitial] = useState<{
    endpoint: string;
    baseUrl: string | null;
  } | null>(null);
  const latestRef = useRef<Grant | null>(null);
  const hasInitialRef = useRef(false);
  const endpointRef = useRef<string | null>(endpoint);
  const inflightRef = useRef<Promise<string | null> | null>(null);
  const lastAttemptAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timers call the current `load` through this ref; it schedules them itself.
  const loadRef = useRef<(target: string) => Promise<string | null>>(() => Promise.resolve(null));

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const load = useCallback(
    (target: string): Promise<string | null> => {
      if (inflightRef.current) return inflightRef.current;
      lastAttemptAtRef.current = Date.now();
      const request: Promise<string | null> = fetchGrant(target)
        .catch(() => null)
        .then((grant) => {
          if (inflightRef.current === request) inflightRef.current = null;
          // Unmounted, or moved on to another video while this was in flight.
          if (endpointRef.current !== target) return null;

          clearTimer();
          if (grant) {
            latestRef.current = grant;
            if (!hasInitialRef.current) {
              hasInitialRef.current = true;
              setInitial({ endpoint: target, baseUrl: grant.baseUrl });
            }
            if (grant.expiresAtMs !== null) {
              const delay = Math.max(
                MIN_ATTEMPT_INTERVAL_MS,
                grant.expiresAtMs - REFRESH_LEAD_MS - Date.now()
              );
              timerRef.current = setTimeout(() => void loadRef.current(target), delay);
            }
          } else {
            if (!hasInitialRef.current) setInitial({ endpoint: target, baseUrl: null });
            timerRef.current = setTimeout(
              () => void loadRef.current(target),
              MIN_ATTEMPT_INTERVAL_MS
            );
          }
          return latestRef.current?.baseUrl ?? null;
        });
      inflightRef.current = request;
      return request;
    },
    [clearTimer]
  );

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const refresh = useCallback((): Promise<string | null> => {
    const target = endpointRef.current;
    if (!target) return Promise.resolve(null);
    if (inflightRef.current) return inflightRef.current;
    if (Date.now() - lastAttemptAtRef.current < MIN_ATTEMPT_INTERVAL_MS) {
      return Promise.resolve(latestRef.current?.baseUrl ?? null);
    }
    return load(target);
  }, [load]);

  useEffect(() => {
    endpointRef.current = endpoint;
    latestRef.current = null;
    hasInitialRef.current = false;
    inflightRef.current = null;
    lastAttemptAtRef.current = 0;
    clearTimer();
    // A grant held from an earlier visit to this endpoint may have expired; drop it
    // so the player waits for a fresh one instead of starting on a stale URL.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the reset is the point
    setInitial(null);
    if (endpoint) void load(endpoint);
    return () => {
      endpointRef.current = null;
      clearTimer();
    };
  }, [endpoint, load, clearTimer]);

  // A laptop that slept through the refresh timer wakes up holding an expired
  // grant; timers fire late or not at all, so check again when the tab is shown.
  useEffect(() => {
    if (!endpoint) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const expiresAtMs = latestRef.current?.expiresAtMs;
      if (expiresAtMs == null) return;
      if (expiresAtMs - Date.now() < REFRESH_LEAD_MS) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [endpoint, refresh]);

  const getLatestBaseUrl = useCallback(() => latestRef.current?.baseUrl ?? null, []);
  const current = initial && initial.endpoint === endpoint ? initial : null;

  return useMemo(
    () => ({
      baseUrl: current?.baseUrl ?? null,
      failed: current !== null && current.baseUrl === null,
      getLatestBaseUrl,
      refresh,
    }),
    [current, getLatestBaseUrl, refresh]
  );
}

export function versionPlaybackEndpoint(versionId: string | null | undefined): string | null {
  return versionId ? `/api/versions/${encodeURIComponent(versionId)}/playback` : null;
}

export function assetPlaybackEndpoint(
  videoId: string | null | undefined,
  assetId: string | null | undefined
): string | null {
  return videoId && assetId
    ? `/api/videos/${encodeURIComponent(videoId)}/assets/${encodeURIComponent(assetId)}/playback`
    : null;
}
