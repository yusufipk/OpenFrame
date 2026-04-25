import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { resolveServerBunnyCdnHostname } from '@/lib/bunny-cdn';
import { NextRequest } from 'next/server';
import { DownloadEgressSource } from '@prisma/client';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ versionId: string }> };
type BunnyDownloadSourcePreference = 'auto' | 'original' | 'compressed';
type BunnyDownloadSource = {
  sourceType: 'original' | 'compressed';
  quality: number | null;
  url: string;
};

const BUNNY_DOWNLOAD_FALLBACK_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240];
const BUNNY_ALLOWED_QUALITIES = new Set(BUNNY_DOWNLOAD_FALLBACK_HEIGHTS);
const BUNNY_SOURCE_RESOLUTION_CACHE_TTL_MS = 60 * 1000;
const BUNNY_REMOTE_FETCH_TIMEOUT_MS = 8 * 1000;

type BunnyDownloadSourceCacheRecord = {
  source: BunnyDownloadSource | null;
  expiresAt: number;
};

const BUNNY_SOURCE_CACHE_MAX_ENTRIES = 500;
const bunnyDownloadSourceCache = new Map<string, BunnyDownloadSourceCacheRecord>();

function resolveBunnyCdnHostname(): string | null {
  return resolveServerBunnyCdnHostname();
}

function buildBunnyOriginalUrl(videoId: string): string {
  const hostname = resolveBunnyCdnHostname();
  if (!hostname) return '';
  return `https://${hostname}/${videoId}/original`;
}

function buildBunnySourceCacheKey(
  videoId: string,
  requestedQuality: number | null,
  sourcePreference: BunnyDownloadSourcePreference
): string {
  return `${videoId}:${requestedQuality ?? 'none'}:${sourcePreference}`;
}

function getCachedBunnyDownloadSource(
  cacheKey: string,
  now: number
): BunnyDownloadSource | null | undefined {
  const cached = bunnyDownloadSourceCache.get(cacheKey);
  if (!cached) return undefined;

  if (cached.expiresAt <= now) {
    bunnyDownloadSourceCache.delete(cacheKey);
    return undefined;
  }

  return cached.source;
}

function setCachedBunnyDownloadSource(
  cacheKey: string,
  source: BunnyDownloadSource | null,
  now: number
): void {
  if (bunnyDownloadSourceCache.size >= BUNNY_SOURCE_CACHE_MAX_ENTRIES) {
    // Evict the oldest entry (Maps preserve insertion order)
    const firstKey = bunnyDownloadSourceCache.keys().next().value;
    if (firstKey !== undefined) bunnyDownloadSourceCache.delete(firstKey);
  }
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
    // Continue with static fallback list below.
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

async function resolveBunnyDownloadSource(
  videoId: string,
  requestedQuality: number | null,
  sourcePreference: BunnyDownloadSourcePreference
): Promise<BunnyDownloadSource | null> {
  if (!resolveBunnyCdnHostname()) return null;

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

// GET /api/versions/[versionId]/download
export async function GET(request: NextRequest, { params }: RouteParams) {
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
      sourceParam === null
        ? 'auto'
        : sourceParam === 'original' || sourceParam === 'compressed'
          ? sourceParam
          : 'auto';

    const version = await db.videoVersion.findUnique({
      where: { id: versionId },
      include: {
        video: {
          include: {
            project: {
              include: {
                workspace: {
                  select: {
                    id: true,
                    ownerId: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!version) {
      return apiErrors.notFound('Version');
    }

    const access = await checkProjectAccess(version.video.project, session?.user?.id);
    const shareSession = getShareSessionFromRequest(request, version.video.id);
    const shareAccess = shareSession
      ? await validateShareLinkAccess({
          token: shareSession.token,
          projectId: version.video.projectId,
          videoId: version.video.id,
          requiredPermission: 'VIEW',
          passwordVerified: shareSession.passwordVerified,
        })
      : {
          hasAccess: false,
          canComment: false,
          canDownload: false,
          allowGuests: false,
          requiresPassword: false,
        };
    const canDownloadViaShareLink = shareAccess.hasAccess && shareAccess.canDownload;
    if (!access.hasAccess && !canDownloadViaShareLink) {
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
      return apiErrors.badRequest(
        'Invalid quality. Allowed values: 2160, 1440, 1080, 720, 480, 360, 240'
      );
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

    // Fetch Content-Length via HEAD so we can record egress bytes without proxying the body.
    let estimatedBytes = BigInt(0);
    try {
      const headRes = await fetchWithTimeout(source.url, { method: 'HEAD', cache: 'no-store' });
      const cl = headRes.headers.get('content-length');
      if (cl && /^\d+$/.test(cl.trim())) {
        const parsed = BigInt(cl.trim());
        if (parsed > BigInt(0)) estimatedBytes = parsed;
      }
    } catch {
      // Best-effort — leave estimatedBytes as 0 if HEAD fails.
    }

    try {
      await db.downloadEgressEvent.create({
        data: {
          versionId: version.id,
          videoId: version.video.id,
          projectId: version.video.project.id,
          workspaceId: version.video.project.workspace.id,
          billedUserId: version.video.project.workspace.ownerId,
          downloaderUserId: session?.user?.id ?? null,
          source:
            source.sourceType === 'original'
              ? DownloadEgressSource.ORIGINAL
              : DownloadEgressSource.COMPRESSED,
          quality: source.quality,
          estimatedBytes,
        },
      });
    } catch (egressError) {
      logError('Failed to record download egress event:', egressError);
    }

    return Response.redirect(source.url, 302);
  } catch (error) {
    logError('Error downloading version:', error);
    return apiErrors.internalError('Failed to download video');
  }
}
