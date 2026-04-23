import { resolveServerBunnyCdnHostname } from '@/lib/bunny-cdn';

type BunnyDownloadSourcePreference = 'auto' | 'original' | 'compressed';

export type BunnyDownloadSource = {
  sourceType: 'original' | 'compressed';
  quality: number | null;
  url: string;
};

const BUNNY_DOWNLOAD_FALLBACK_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240];
const BUNNY_ALLOWED_QUALITIES = new Set(BUNNY_DOWNLOAD_FALLBACK_HEIGHTS);
const BUNNY_REMOTE_FETCH_TIMEOUT_MS = 8 * 1000;
const BUNNY_SOURCE_RESOLUTION_CACHE_TTL_MS = 60 * 1000;

type BunnyDownloadSourceCacheRecord = {
  source: BunnyDownloadSource | null;
  expiresAt: number;
};

const bunnyDownloadSourceCache = new Map<string, BunnyDownloadSourceCacheRecord>();

export function resolveBunnyCdnHostname(): string | null {
  return resolveServerBunnyCdnHostname();
}

export async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BUNNY_REMOTE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function isRemoteFileAvailable(url: string): Promise<boolean> {
  try {
    const headRes = await fetchWithTimeout(url, { method: 'HEAD', cache: 'no-store' });
    if (headRes.ok) return true;

    if (headRes.status === 405) {
      const rangeRes = await fetchWithTimeout(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        cache: 'no-store',
      });
      return rangeRes.ok || rangeRes.status === 206;
    }

    return false;
  } catch {
    return false;
  }
}

function buildBunnyOriginalUrl(videoId: string): string {
  const hostname = resolveBunnyCdnHostname();
  if (!hostname) return '';
  return `https://${hostname}/${videoId}/original`;
}

function extractHeightFromBunnyMp4Url(url: string): number | null {
  const match = url.match(/\/play_(\d+)p\.mp4$/);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function resolveHighestBunnyMp4Url(videoId: string): Promise<string> {
  const hostname = resolveBunnyCdnHostname();
  if (!hostname) return '';
  const playlistUrl = `https://${hostname}/${videoId}/playlist.m3u8`;

  let playlistHeights: number[] = [];
  try {
    const playlistRes = await fetchWithTimeout(playlistUrl, { cache: 'no-store' });
    if (playlistRes.ok) {
      const playlist = await playlistRes.text();
      const matches = [...playlist.matchAll(/RESOLUTION=\d+x(\d+)/g)];
      playlistHeights = matches
        .map((match) => Number(match[1]))
        .filter((height) => Number.isFinite(height) && BUNNY_ALLOWED_QUALITIES.has(height))
        .sort((a, b) => b - a);
    }
  } catch {
    // Fall through to static fallback list.
  }

  const candidateHeights = [...new Set([...playlistHeights, ...BUNNY_DOWNLOAD_FALLBACK_HEIGHTS])];

  for (const height of candidateHeights) {
    const candidateUrl = `https://${hostname}/${videoId}/play_${height}p.mp4`;
    if (await isRemoteFileAvailable(candidateUrl)) return candidateUrl;
  }

  return '';
}

async function resolveBunnyOriginalSource(videoId: string): Promise<BunnyDownloadSource | null> {
  const originalUrl = buildBunnyOriginalUrl(videoId);
  if (!originalUrl) return null;
  if (await isRemoteFileAvailable(originalUrl)) {
    return {
      sourceType: 'original',
      quality: null,
      url: originalUrl,
    };
  }

  return null;
}

async function resolveBunnyCompressedSource(
  videoId: string,
  requestedQuality: number | null
): Promise<BunnyDownloadSource> {
  const hostname = resolveBunnyCdnHostname();
  if (!hostname) {
    return {
      sourceType: 'compressed',
      quality: null,
      url: '',
    };
  }

  if (
    typeof requestedQuality === 'number' &&
    Number.isFinite(requestedQuality) &&
    requestedQuality > 0
  ) {
    const requestedUrl = `https://${hostname}/${videoId}/play_${requestedQuality}p.mp4`;
    if (await isRemoteFileAvailable(requestedUrl)) {
      return {
        sourceType: 'compressed',
        quality: extractHeightFromBunnyMp4Url(requestedUrl),
        url: requestedUrl,
      };
    }
  }

  const fallbackUrl = await resolveHighestBunnyMp4Url(videoId);
  if (!fallbackUrl) {
    return {
      sourceType: 'compressed',
      quality: null,
      url: '',
    };
  }
  return {
    sourceType: 'compressed',
    quality: extractHeightFromBunnyMp4Url(fallbackUrl),
    url: fallbackUrl,
  };
}

function buildSourceCacheKey(
  videoId: string,
  requestedQuality: number | null,
  preference: BunnyDownloadSourcePreference
): string {
  return `${videoId}:${requestedQuality ?? 'none'}:${preference}`;
}

function getCachedSource(cacheKey: string, now: number): BunnyDownloadSource | null | undefined {
  const cached = bunnyDownloadSourceCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= now) {
    bunnyDownloadSourceCache.delete(cacheKey);
    return undefined;
  }
  return cached.source;
}

function setCachedSource(cacheKey: string, source: BunnyDownloadSource | null, now: number): void {
  bunnyDownloadSourceCache.set(cacheKey, {
    source,
    expiresAt: now + BUNNY_SOURCE_RESOLUTION_CACHE_TTL_MS,
  });
}

export async function resolveBunnyDownloadSource(
  videoId: string,
  requestedQuality: number | null,
  preference: BunnyDownloadSourcePreference
): Promise<BunnyDownloadSource | null> {
  if (!resolveBunnyCdnHostname()) return null;

  const now = Date.now();
  const cacheKey = buildSourceCacheKey(videoId, requestedQuality, preference);
  const cached = getCachedSource(cacheKey, now);
  if (cached !== undefined) return cached;

  let resolvedSource: BunnyDownloadSource | null;

  if (preference === 'original') {
    resolvedSource = await resolveBunnyOriginalSource(videoId);
    setCachedSource(cacheKey, resolvedSource, now);
    return resolvedSource;
  }

  if (preference === 'compressed') {
    resolvedSource = await resolveBunnyCompressedSource(videoId, requestedQuality);
    setCachedSource(cacheKey, resolvedSource, now);
    return resolvedSource;
  }

  const originalSource = await resolveBunnyOriginalSource(videoId);
  if (originalSource) {
    setCachedSource(cacheKey, originalSource, now);
    return originalSource;
  }

  resolvedSource = await resolveBunnyCompressedSource(videoId, requestedQuality);
  setCachedSource(cacheKey, resolvedSource, now);
  return resolvedSource;
}
