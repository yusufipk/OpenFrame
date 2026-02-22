import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';

type RouteParams = { params: Promise<{ versionId: string }> };
type BunnyDownloadSourcePreference = 'auto' | 'original' | 'compressed';
type BunnyDownloadSource = {
  sourceType: 'original' | 'compressed';
  quality: number | null;
  url: string;
};

const BUNNY_DOWNLOAD_FALLBACK_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240];
const BUNNY_ALLOWED_QUALITIES = new Set(BUNNY_DOWNLOAD_FALLBACK_HEIGHTS);
const DEFAULT_BUNNY_CDN_HOSTNAME = 'vz-965f4f4a-fc1.b-cdn.net';
const BUNNY_MAX_PROBE_CANDIDATES = 4;
const BUNNY_SOURCE_RESOLUTION_CACHE_TTL_MS = 60 * 1000;
const BUNNY_REMOTE_FETCH_TIMEOUT_MS = 8 * 1000;
const SAFE_DOWNLOAD_CONTENT_TYPE = 'application/octet-stream';
const CONTENT_TYPE_EXTENSION_MAP: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'video/mpeg': '.mpeg',
  'video/3gpp': '.3gp',
  'video/ogg': '.ogv',
};
const SAFE_VIDEO_CONTENT_TYPES = new Set(Object.keys(CONTENT_TYPE_EXTENSION_MAP));
const SAFE_VIDEO_EXTENSIONS = new Set(Object.values(CONTENT_TYPE_EXTENSION_MAP));

type BunnyDownloadSourceCacheRecord = {
  source: BunnyDownloadSource | null;
  expiresAt: number;
};

const bunnyDownloadSourceCache = new Map<string, BunnyDownloadSourceCacheRecord>();

function sanitizeFileName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.length > 0 ? sanitized : 'video';
}

function toAsciiFileName(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized : 'video';
}

function buildContentDisposition(fileNameWithExt: string): string {
  const asciiFallback = toAsciiFileName(fileNameWithExt).replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileNameWithExt);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function resolveBunnyCdnHostname(): string {
  const raw = process.env.BUNNY_CDN_URL || process.env.NEXT_PUBLIC_BUNNY_CDN_URL;
  if (!raw) return DEFAULT_BUNNY_CDN_HOSTNAME;

  try {
    const url = new URL(raw);
    return url.hostname || DEFAULT_BUNNY_CDN_HOSTNAME;
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/\/+$/, '') || DEFAULT_BUNNY_CDN_HOSTNAME;
  }
}

function buildBunnyOriginalUrl(videoId: string): string {
  return `https://${resolveBunnyCdnHostname()}/${videoId}/original`;
}

function buildBunnySourceCacheKey(
  videoId: string,
  requestedQuality: number | null,
  sourcePreference: BunnyDownloadSourcePreference
): string {
  return `${videoId}:${requestedQuality ?? 'none'}:${sourcePreference}`;
}

function getCachedBunnyDownloadSource(cacheKey: string, now: number): BunnyDownloadSource | null | undefined {
  const cached = bunnyDownloadSourceCache.get(cacheKey);
  if (!cached) return undefined;

  if (cached.expiresAt <= now) {
    bunnyDownloadSourceCache.delete(cacheKey);
    return undefined;
  }

  return cached.source;
}

function setCachedBunnyDownloadSource(cacheKey: string, source: BunnyDownloadSource | null, now: number): void {
  bunnyDownloadSourceCache.set(cacheKey, {
    source,
    expiresAt: now + BUNNY_SOURCE_RESOLUTION_CACHE_TTL_MS,
  });
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
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

async function resolveHighestBunnyMp4Url(videoId: string): Promise<string> {
  const hostname = resolveBunnyCdnHostname();
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
    // Continue with static fallback list below.
  }

  const candidateHeights = [...new Set([...playlistHeights, ...BUNNY_DOWNLOAD_FALLBACK_HEIGHTS])]
    .slice(0, BUNNY_MAX_PROBE_CANDIDATES);

  for (const height of candidateHeights) {
    const candidateUrl = `https://${hostname}/${videoId}/play_${height}p.mp4`;
    if (await isRemoteFileAvailable(candidateUrl)) return candidateUrl;
  }

  // Last-resort fallback
  const fallbackHeight = candidateHeights[0] ?? 1080;
  return `https://${hostname}/${videoId}/play_${fallbackHeight}p.mp4`;
}

async function resolveBunnyOriginalSource(videoId: string): Promise<BunnyDownloadSource | null> {
  const originalUrl = buildBunnyOriginalUrl(videoId);
  if (await isRemoteFileAvailable(originalUrl)) {
    return {
      sourceType: 'original',
      quality: null,
      url: originalUrl,
    };
  }

  return null;
}

async function resolveBunnyCompressedSource(videoId: string, requestedQuality: number | null): Promise<BunnyDownloadSource> {
  if (typeof requestedQuality === 'number' && Number.isFinite(requestedQuality) && requestedQuality > 0) {
    const requestedUrl = `https://${resolveBunnyCdnHostname()}/${videoId}/play_${requestedQuality}p.mp4`;
    if (await isRemoteFileAvailable(requestedUrl)) {
      return {
        sourceType: 'compressed',
        quality: extractHeightFromBunnyMp4Url(requestedUrl),
        url: requestedUrl,
      };
    }
  }

  const fallbackUrl = await resolveHighestBunnyMp4Url(videoId);

  return {
    sourceType: 'compressed',
    quality: extractHeightFromBunnyMp4Url(fallbackUrl),
    url: fallbackUrl,
  };
}

async function resolveBunnyDownloadSource(
  videoId: string,
  requestedQuality: number | null,
  sourcePreference: BunnyDownloadSourcePreference
): Promise<BunnyDownloadSource | null> {
  const now = Date.now();
  const cacheKey = buildBunnySourceCacheKey(videoId, requestedQuality, sourcePreference);
  const cached = getCachedBunnyDownloadSource(cacheKey, now);
  if (cached !== undefined) {
    return cached;
  }

  let resolvedSource: BunnyDownloadSource | null;
  if (sourcePreference === 'original') {
    resolvedSource = await resolveBunnyOriginalSource(videoId);
    setCachedBunnyDownloadSource(cacheKey, resolvedSource, now);
    return resolvedSource;
  }

  if (sourcePreference === 'compressed') {
    resolvedSource = await resolveBunnyCompressedSource(videoId, requestedQuality);
    setCachedBunnyDownloadSource(cacheKey, resolvedSource, now);
    return resolvedSource;
  }

  const originalSource = await resolveBunnyOriginalSource(videoId);
  if (originalSource) {
    setCachedBunnyDownloadSource(cacheKey, originalSource, now);
    return originalSource;
  }

  resolvedSource = await resolveBunnyCompressedSource(videoId, requestedQuality);
  setCachedBunnyDownloadSource(cacheKey, resolvedSource, now);
  return resolvedSource;
}

function extractHeightFromBunnyMp4Url(url: string): number | null {
  const match = url.match(/\/play_(\d+)p\.mp4$/);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractFileNameFromContentDisposition(contentDisposition: string | null): string | null {
  if (!contentDisposition) return null;

  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const fallbackMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  return fallbackMatch?.[1] ?? null;
}

function extractFileExtension(fileName: string | null): string | null {
  if (!fileName) return null;
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return null;
  const extension = fileName.slice(dotIndex).toLowerCase();
  return /^[.][a-z0-9]{1,10}$/i.test(extension) ? extension : null;
}

function inferExtensionFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const normalized = contentType.split(';')[0]?.trim().toLowerCase();
  return normalized ? CONTENT_TYPE_EXTENSION_MAP[normalized] ?? null : null;
}

function normalizeContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const normalized = contentType.split(';')[0]?.trim().toLowerCase();
  return normalized || null;
}

function resolveSafeDownloadMetadata(
  sourceType: BunnyDownloadSource['sourceType'],
  sourceFileName: string | null,
  sourceContentType: string | null
): { extension: string; contentType: string } | null {
  const rawExtension = extractFileExtension(sourceFileName);
  const sourceExtension = rawExtension && SAFE_VIDEO_EXTENSIONS.has(rawExtension) ? rawExtension : null;

  const normalizedContentType = normalizeContentType(sourceContentType);
  const safeContentType =
    normalizedContentType && SAFE_VIDEO_CONTENT_TYPES.has(normalizedContentType)
      ? normalizedContentType
      : null;
  const inferredExtension = safeContentType ? inferExtensionFromContentType(safeContentType) : null;
  const fallbackExtension = sourceType === 'compressed' ? '.mp4' : null;

  const extension = sourceExtension || inferredExtension || fallbackExtension;
  if (!extension) return null;

  return {
    extension,
    contentType: safeContentType ?? (sourceType === 'compressed' ? 'video/mp4' : SAFE_DOWNLOAD_CONTENT_TYPE),
  };
}

// GET /api/versions/[versionId]/download
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { searchParams } = new URL(request.url);
    const isPrepareOnly = searchParams.get('prepare') === '1';
    const rateLimitAction = isPrepareOnly ? 'video-download-prepare' : 'video-download';
    const limited = await rateLimit(request, rateLimitAction);
    if (limited) return limited;

    const session = await auth();
    const { versionId } = await params;
    const requestedQuality = Number(searchParams.get('quality'));
    const rawQuality = searchParams.get('quality');
    const sourceParam = searchParams.get('source');
    const sourcePreference: BunnyDownloadSourcePreference =
      sourceParam === null ? 'auto' : sourceParam === 'original' || sourceParam === 'compressed'
        ? sourceParam
        : 'auto';

    const version = await db.videoVersion.findUnique({
      where: { id: versionId },
      include: {
        video: {
          include: {
            project: true,
          },
        },
      },
    });

    if (!version) {
      return apiErrors.notFound('Version');
    }

    const access = await checkProjectAccess(version.video.project, session?.user?.id);
    if (!access.hasAccess) {
      return apiErrors.forbidden('Access denied');
    }

    if (version.providerId !== 'bunny') {
      return apiErrors.badRequest('Download is currently supported for Bunny versions only');
    }

    if (sourceParam !== null && sourceParam !== 'original' && sourceParam !== 'compressed') {
      return apiErrors.badRequest('Invalid source. Allowed values: original, compressed');
    }

    if (
      rawQuality !== null &&
      (!Number.isFinite(requestedQuality) || !BUNNY_ALLOWED_QUALITIES.has(requestedQuality))
    ) {
      return apiErrors.badRequest('Invalid quality. Allowed values: 2160, 1440, 1080, 720, 480, 360, 240');
    }

    if (rawQuality !== null && sourcePreference === 'original') {
      return apiErrors.badRequest('Quality cannot be used when source=original');
    }

    const source = await resolveBunnyDownloadSource(
      version.videoId,
      Number.isFinite(requestedQuality) ? requestedQuality : null,
      sourcePreference
    );

    if (!source) {
      if (sourcePreference === 'original') {
        return apiErrors.notFound('Original file');
      }
      return apiErrors.notFound('Download file');
    }

    if (isPrepareOnly) {
      const response = successResponse({
        quality: source.quality,
        sourceType: source.sourceType,
      });
      return withCacheControl(response, 'private, no-store');
    }

    const upstream = await fetchWithTimeout(source.url, { cache: 'no-store' });
    if (!upstream.ok || !upstream.body) {
      return apiErrors.notFound('Download file');
    }

    const versionLabel = version.versionLabel?.trim() || `v${version.versionNumber}`;
    const sourceFileName = extractFileNameFromContentDisposition(upstream.headers.get('content-disposition'));
    const metadata = resolveSafeDownloadMetadata(
      source.sourceType,
      sourceFileName,
      upstream.headers.get('content-type')
    );
    if (!metadata) {
      return apiErrors.badRequest('Original file format is not supported for download');
    }

    const filename = sanitizeFileName(`${version.video.title} ${versionLabel}`) + metadata.extension;
    const contentDisposition = buildContentDisposition(filename);

    const response = new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': metadata.contentType,
        'Content-Disposition': contentDisposition,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) response.headers.set('Content-Length', contentLength);

    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    console.error('Error downloading version:', error);
    return apiErrors.internalError('Failed to download video');
  }
}
