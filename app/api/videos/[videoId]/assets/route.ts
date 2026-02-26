import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { VideoAssetProvider } from '@prisma/client';
import { NextRequest } from 'next/server';
import { parseVideoUrl, getThumbnailUrl } from '@/lib/video-providers';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { db } from '@/lib/db';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { verifyBunnyUploadToken } from '@/lib/bunny-upload-token';
import { deriveGuestUploadContext, verifyGuestUploadToken } from '@/lib/guest-upload-token';
import { ensureGuestIdentityFromRequest, setGuestIdentityCookie } from '@/lib/guest-identity';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { validateUrl, validateOptionalUrl } from '@/lib/validation';
import { resolveServerBunnyCdnHostname } from '@/lib/bunny-cdn';
import {
  SAFE_BUNNY_VIDEO_ID,
  SAFE_IMAGE_PROXY_PATH,
  canDeleteAssetForViewer,
  extractImageFileNameFromProxyUrl,
  extractImageKeyFromProxyUrl,
  getVideoAssetAccessContext,
  sanitizeAssetDisplayName,
} from '@/lib/video-assets';

type RouteParams = { params: Promise<{ videoId: string }> };

const UNATTACHED_UPLOAD_TTL_MS = 15 * 60 * 1000;
const ASSET_LIST_DEFAULT_LIMIT = 40;
const ASSET_LIST_MAX_LIMIT = 100;
const YOUTUBE_TITLE_CACHE_TTL_MS = 5 * 60 * 1000;

type AssetWithViewerFields = {
  id: string;
  videoId: string;
  kind: 'IMAGE' | 'VIDEO';
  provider: VideoAssetProvider;
  displayName: string;
  sourceUrl: string;
  providerVideoId: string | null;
  thumbnailUrl: string | null;
  uploadedByUserId?: string | null;
  uploadedByGuestName: string | null;
  uploadedByGuestIdentityId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  uploadedByUser: {
    id: string;
    name: string | null;
    image: string | null;
  } | null;
};

type YouTubeTitleCacheRecord = {
  title: string | null;
  expiresAt: number;
};

const youtubeTitleCache = new Map<string, YouTubeTitleCacheRecord>();

function isAllowedBunnyMediaUrl(url: string): boolean {
  const allowedHosts = new Set<string>([
    'iframe.mediadelivery.net',
    'video.bunnycdn.com',
  ]);
  const bunnyCdnHostname = resolveServerBunnyCdnHostname();
  if (bunnyCdnHostname) {
    allowedHosts.add(bunnyCdnHostname);
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return allowedHosts.has(parsed.hostname);
  } catch {
    return false;
  }
}

function shapeAssetForViewer(asset: AssetWithViewerFields, canExposeSource: boolean, canDelete: boolean) {
  return {
    id: asset.id,
    videoId: asset.videoId,
    kind: asset.kind,
    provider: asset.provider,
    displayName: asset.displayName,
    sourceUrl: canExposeSource ? asset.sourceUrl : null,
    providerVideoId: canExposeSource ? asset.providerVideoId : null,
    thumbnailUrl: canExposeSource ? asset.thumbnailUrl : null,
    uploadedByUserId: asset.uploadedByUserId ?? null,
    uploadedByGuestName: asset.uploadedByGuestName,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    uploadedByUser: asset.uploadedByUser,
    canDelete,
  };
}

function parsePaginationParam(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

async function fetchYouTubeTitleFromProvider(videoId: string): Promise<string | null> {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as { title?: string } | null;
    if (!payload?.title || typeof payload.title !== 'string') return null;
    return payload.title.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchYouTubeTitle(videoId: string): Promise<string | null> {
  const now = Date.now();
  const cached = youtubeTitleCache.get(videoId);
  if (cached && cached.expiresAt > now) {
    return cached.title;
  }

  const title = await fetchYouTubeTitleFromProvider(videoId);
  youtubeTitleCache.set(videoId, {
    title,
    expiresAt: now + YOUTUBE_TITLE_CACHE_TTL_MS,
  });
  return title;
}

async function isFreshImageAttachment(url: string): Promise<boolean> {
  const key = extractImageKeyFromProxyUrl(url);
  if (!key) return false;

  try {
    const head = await r2Client.send(new HeadObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    }));
    if (!head.LastModified) return false;
    return Date.now() - head.LastModified.getTime() <= UNATTACHED_UPLOAD_TTL_MS;
  } catch {
    return false;
  }
}

// GET /api/videos/[videoId]/assets
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'asset-list');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'VIEW');
    if (!context) return apiErrors.notFound('Video');
    if (!context.hasViewAccess) return apiErrors.forbidden('Access denied');

    const requestedLimit = parsePaginationParam(request.nextUrl.searchParams.get('limit'), ASSET_LIST_DEFAULT_LIMIT);
    const requestedOffset = parsePaginationParam(request.nextUrl.searchParams.get('offset'), 0);
    const limit = Math.min(ASSET_LIST_MAX_LIMIT, Math.max(1, requestedLimit));
    const offset = requestedOffset;
    const includeDeleteMetadata = context.canUploadAssets;

    const assets = await db.videoAsset.findMany({
      where: { videoId },
      skip: offset,
      take: limit + 1,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        videoId: true,
        kind: true,
        provider: true,
        displayName: true,
        sourceUrl: true,
        providerVideoId: true,
        thumbnailUrl: true,
        uploadedByUserId: includeDeleteMetadata,
        uploadedByGuestName: true,
        uploadedByGuestIdentityId: includeDeleteMetadata,
        createdAt: true,
        updatedAt: true,
        uploadedByUser: {
          select: { id: true, name: true, image: true },
        },
      },
    });
    const hasMore = assets.length > limit;
    const pagedAssets = hasMore ? assets.slice(0, limit) : assets;

    const response = successResponse({
      assets: pagedAssets.map((asset) => shapeAssetForViewer(
        asset,
        context.canDownloadAssets,
        includeDeleteMetadata ? canDeleteAssetForViewer(asset, context) : false
      )),
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
      canUploadAssets: context.canUploadAssets,
      canDownloadAssets: context.canDownloadAssets,
    });
    return withCacheControl(response, 'private, no-cache');
  } catch (error) {
    console.error('Error fetching video assets:', error);
    return apiErrors.internalError('Failed to fetch assets');
  }
}

// POST /api/videos/[videoId]/assets
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'asset-create');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'COMMENT');
    if (!context) return apiErrors.notFound('Video');
    if (!context.canUploadAssets) return apiErrors.forbidden('Access denied');

    const body = await request.json().catch(() => null);
    const provider = typeof body?.provider === 'string' ? body.provider.trim().toUpperCase() : '';

    if (provider !== VideoAssetProvider.R2_IMAGE && provider !== VideoAssetProvider.YOUTUBE && provider !== VideoAssetProvider.BUNNY) {
      return apiErrors.badRequest('Invalid provider');
    }

    const isGuest = !context.viewerUserId;
    const guestIdentity = isGuest ? ensureGuestIdentityFromRequest(request) : null;

    const requestedDisplayName = typeof body?.displayName === 'string' ? body.displayName : null;
    let displayName = '';
    let sourceUrl = '';
    let providerVideoId: string | null = null;
    let thumbnailUrl: string | null = null;
    let kind: 'IMAGE' | 'VIDEO' = 'IMAGE';

    if (provider === VideoAssetProvider.R2_IMAGE) {
      sourceUrl = typeof body?.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
      if (!SAFE_IMAGE_PROXY_PATH.test(sourceUrl)) {
        return apiErrors.badRequest('Image URL must reference an uploaded image file');
      }
      if (!(await isFreshImageAttachment(sourceUrl))) {
        return apiErrors.badRequest('Image upload expired. Please upload again.');
      }

      const fileName = extractImageFileNameFromProxyUrl(sourceUrl);
      displayName = sanitizeAssetDisplayName(requestedDisplayName, fileName || 'Image');
      thumbnailUrl = sourceUrl;
      kind = 'IMAGE';
    }

    if (provider === VideoAssetProvider.YOUTUBE) {
      sourceUrl = typeof body?.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
      const parsedSource = parseVideoUrl(sourceUrl);
      if (!parsedSource || parsedSource.providerId !== 'youtube') {
        return apiErrors.badRequest('Only YouTube URLs are allowed for this provider');
      }
      const sourceUrlError = validateUrl(parsedSource.originalUrl, 'YouTube URL');
      if (sourceUrlError) return apiErrors.badRequest(sourceUrlError);

      providerVideoId = parsedSource.videoId;
      const youtubeTitle = await fetchYouTubeTitle(providerVideoId);
      displayName = sanitizeAssetDisplayName(requestedDisplayName, youtubeTitle || `YouTube ${providerVideoId}`);
      sourceUrl = parsedSource.originalUrl;
      thumbnailUrl = getThumbnailUrl(parsedSource, 'large');
      kind = 'VIDEO';
    }

    if (provider === VideoAssetProvider.BUNNY) {
      sourceUrl = typeof body?.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
      providerVideoId = typeof body?.providerVideoId === 'string' ? body.providerVideoId.trim() : '';
      const uploadToken = typeof body?.uploadToken === 'string' ? body.uploadToken.trim() : '';
      thumbnailUrl = typeof body?.thumbnailUrl === 'string' ? body.thumbnailUrl.trim() : null;

      if (!providerVideoId || !SAFE_BUNNY_VIDEO_ID.test(providerVideoId)) {
        return apiErrors.badRequest('Invalid Bunny video id');
      }

      const sourceUrlError = validateUrl(sourceUrl, 'Bunny source URL');
      if (sourceUrlError) return apiErrors.badRequest(sourceUrlError);
      const thumbnailUrlError = validateOptionalUrl(thumbnailUrl, 'Bunny thumbnail URL');
      if (thumbnailUrlError) return apiErrors.badRequest(thumbnailUrlError);
      if (thumbnailUrl && !isAllowedBunnyMediaUrl(thumbnailUrl)) {
        return apiErrors.badRequest('Bunny thumbnail URL must use an approved Bunny host');
      }
      if (!isAllowedBunnyMediaUrl(sourceUrl)) {
        return apiErrors.badRequest('Bunny source URL must use an approved Bunny host');
      }

      if (!uploadToken) {
        return apiErrors.badRequest('uploadToken is required');
      }

      if (context.viewerUserId) {
        const isValidUploadToken = verifyBunnyUploadToken(uploadToken, {
          userId: context.viewerUserId,
          projectId: context.video.projectId,
          videoId: providerVideoId,
        });
        if (!isValidUploadToken) {
          return apiErrors.forbidden('Invalid Bunny upload token');
        }
      } else {
        const shareSession = getShareSessionFromRequest(request, context.video.id);
        const expectedContext = deriveGuestUploadContext(request, shareSession?.token ?? null);
        if (!expectedContext) {
          return apiErrors.forbidden('Missing trusted client IP header');
        }

        const isValidGuestUploadToken = verifyGuestUploadToken(uploadToken, {
          projectId: context.video.projectId,
          videoId: context.video.id,
          intent: 'bunny',
          context: expectedContext,
        });
        if (!isValidGuestUploadToken) {
          return apiErrors.forbidden('Invalid Bunny upload token');
        }
      }

      displayName = sanitizeAssetDisplayName(requestedDisplayName, `Bunny ${providerVideoId}`);
      if (!thumbnailUrl) {
        const bunnyCdnHostname = resolveServerBunnyCdnHostname();
        if (bunnyCdnHostname) {
          thumbnailUrl = `https://${bunnyCdnHostname}/${providerVideoId}/thumbnail.jpg`;
        }
      }
      kind = 'VIDEO';
    }

    const created = await db.videoAsset.create({
      data: {
        videoId: context.video.id,
        kind,
        provider,
        displayName,
        sourceUrl,
        providerVideoId,
        thumbnailUrl,
        uploadedByUserId: context.viewerUserId,
        uploadedByGuestIdentityId: context.viewerUserId ? null : guestIdentity?.identityId ?? null,
        uploadedByGuestName: context.viewerUserId
          ? null
          : sanitizeAssetDisplayName(typeof body?.guestName === 'string' ? body.guestName : null, 'Guest'),
        billedUserId: context.video.project.workspace.ownerId,
      },
      select: {
        id: true,
        videoId: true,
        kind: true,
        provider: true,
        displayName: true,
        sourceUrl: true,
        providerVideoId: true,
        thumbnailUrl: true,
        uploadedByGuestName: true,
        createdAt: true,
        updatedAt: true,
        uploadedByUser: {
          select: { id: true, name: true, image: true },
        },
      },
    });

    const response = successResponse(shapeAssetForViewer(
      created,
      context.canDownloadAssets,
      true
    ), 201);
    if (isGuest && guestIdentity?.shouldSetCookie) {
      setGuestIdentityCookie(response, guestIdentity.identityId);
    }
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    console.error('Error creating video asset:', error);
    return apiErrors.internalError('Failed to create asset');
  }
}
