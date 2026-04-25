import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { VideoAssetProvider } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
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
  SAFE_AUDIO_PROXY_PATH,
  canDeleteAssetForViewer,
  extractImageFileNameFromProxyUrl,
  extractImageKeyFromProxyUrl,
  extractAudioKeyFromProxyUrl,
  extractAudioFileNameFromProxyUrl,
  getVideoAssetAccessContext,
  sanitizeAssetDisplayName,
} from '@/lib/video-assets';
import { logError } from '@/lib/logger';
import {
  enforceStorageQuota,
  reserveStorageQuota,
  releaseStorageReservation,
  PLAN_STORAGE_LIMIT_BYTES,
} from '@/lib/storage-quota';
import { getCachedUserBunnyStorage } from '@/lib/admin-stats';
import { isStripeFeatureEnabled } from '@/lib/feature-flags';

// Sentinel thrown inside a Prisma transaction when a fake reservationId is
// supplied and the fallback quota check finds the limit would be exceeded.
class QuotaExceededInTxError extends Error {}

type RouteParams = { params: Promise<{ videoId: string }> };

const UNATTACHED_UPLOAD_TTL_MS = 15 * 60 * 1000;
const ASSET_LIST_DEFAULT_LIMIT = 40;
const ASSET_LIST_MAX_LIMIT = 100;
const YOUTUBE_TITLE_CACHE_TTL_MS = 5 * 60 * 1000;

type AssetWithViewerFields = {
  id: string;
  videoId: string;
  kind: 'IMAGE' | 'VIDEO' | 'AUDIO';
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
  const allowedHosts = new Set<string>(['iframe.mediadelivery.net', 'video.bunnycdn.com']);
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

function shapeAssetForViewer(
  asset: AssetWithViewerFields,
  canExposeSource: boolean,
  canDelete: boolean
) {
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

function normalizeEtag(value: string): string {
  return value.trim().replace(/^W\//, '');
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

type AttachmentCheck = { isFresh: boolean; sizeBytes: bigint };

async function isFreshImageAttachment(url: string): Promise<AttachmentCheck> {
  const key = extractImageKeyFromProxyUrl(url);
  if (!key) return { isFresh: false, sizeBytes: BigInt(0) };

  try {
    const head = await r2Client.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      })
    );
    if (!head.LastModified) return { isFresh: false, sizeBytes: BigInt(0) };
    const isFresh = Date.now() - head.LastModified.getTime() <= UNATTACHED_UPLOAD_TTL_MS;
    return { isFresh, sizeBytes: BigInt(head.ContentLength ?? 0) };
  } catch {
    return { isFresh: false, sizeBytes: BigInt(0) };
  }
}

async function isFreshAudioAttachment(url: string): Promise<AttachmentCheck> {
  const key = extractAudioKeyFromProxyUrl(url);
  if (!key) return { isFresh: false, sizeBytes: BigInt(0) };

  try {
    const head = await r2Client.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      })
    );
    if (!head.LastModified) return { isFresh: false, sizeBytes: BigInt(0) };
    const isFresh = Date.now() - head.LastModified.getTime() <= UNATTACHED_UPLOAD_TTL_MS;
    return { isFresh, sizeBytes: BigInt(head.ContentLength ?? 0) };
  } catch {
    return { isFresh: false, sizeBytes: BigInt(0) };
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

    const requestedLimit = parsePaginationParam(
      request.nextUrl.searchParams.get('limit'),
      ASSET_LIST_DEFAULT_LIMIT
    );
    const requestedOffset = parsePaginationParam(request.nextUrl.searchParams.get('offset'), 0);
    const limit = Math.min(ASSET_LIST_MAX_LIMIT, Math.max(1, requestedLimit));
    const offset = requestedOffset;
    const includeDeleteMetadata = context.canUploadAssets;

    const assetsRevision = await db.videoAsset.aggregate({
      where: { videoId },
      _count: { id: true },
      _max: { updatedAt: true },
    });
    const etag = `"assets:${videoId}:${limit}:${offset}:${includeDeleteMetadata ? 1 : 0}:${context.canDownloadAssets ? 1 : 0}:${assetsRevision._count.id}:${assetsRevision._max.updatedAt?.getTime() ?? 0}"`;
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch) {
      const matches = ifNoneMatch.split(',').map(normalizeEtag).includes(normalizeEtag(etag));
      if (matches) {
        const notModified = new NextResponse(null, { status: 304 });
        notModified.headers.set('ETag', etag);
        return withCacheControl(notModified, 'private, no-cache');
      }
    }

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
      assets: pagedAssets.map((asset) =>
        shapeAssetForViewer(
          asset,
          // R2_AUDIO proxy URLs have no auth gate — expose them to any viewer so guests can preview audio
          context.canDownloadAssets ||
            (asset.provider === VideoAssetProvider.R2_AUDIO && context.hasViewAccess),
          includeDeleteMetadata ? canDeleteAssetForViewer(asset, context) : false
        )
      ),
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
      canUploadAssets: context.canUploadAssets,
      canDownloadAssets: context.canDownloadAssets,
    });
    response.headers.set('ETag', etag);
    return withCacheControl(response, 'private, no-cache');
  } catch (error) {
    logError('Error fetching video assets:', error);
    return apiErrors.internalError('Failed to fetch assets');
  }
}

// POST /api/videos/[videoId]/assets
export async function POST(request: NextRequest, { params }: RouteParams) {
  let reservationId: string | null = null;
  try {
    const limited = await rateLimit(request, 'asset-create');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'COMMENT');
    if (!context) return apiErrors.notFound('Video');
    if (!context.canUploadAssets) return apiErrors.forbidden('Access denied');

    const body = await request.json().catch(() => null);
    const provider = typeof body?.provider === 'string' ? body.provider.trim().toUpperCase() : '';

    if (
      provider !== VideoAssetProvider.R2_IMAGE &&
      provider !== VideoAssetProvider.YOUTUBE &&
      provider !== VideoAssetProvider.BUNNY &&
      provider !== VideoAssetProvider.R2_AUDIO
    ) {
      return apiErrors.badRequest('Invalid provider');
    }

    const isGuest = !context.viewerUserId;
    const guestIdentity = isGuest ? ensureGuestIdentityFromRequest(request) : null;

    const requestedDisplayName = typeof body?.displayName === 'string' ? body.displayName : null;
    // Optional reservation ID created by the upload route for atomic quota accounting
    reservationId = typeof body?.reservationId === 'string' ? body.reservationId.trim() : null;
    let displayName = '';
    let sourceUrl = '';
    let providerVideoId: string | null = null;
    let thumbnailUrl: string | null = null;
    let kind: 'IMAGE' | 'VIDEO' | 'AUDIO' = 'IMAGE';
    let assetSizeBytes = BigInt(0);

    const billedUserId = context.video.project.workspace.ownerId;

    if (provider === VideoAssetProvider.R2_IMAGE) {
      sourceUrl = typeof body?.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
      if (!SAFE_IMAGE_PROXY_PATH.test(sourceUrl)) {
        return apiErrors.badRequest('Image URL must reference an uploaded image file');
      }
      const imageCheck = await isFreshImageAttachment(sourceUrl);
      if (!imageCheck.isFresh) {
        return apiErrors.badRequest('Image upload expired. Please upload again.');
      }
      assetSizeBytes = imageCheck.sizeBytes;

      // Always use the advisory-locked reservation path so concurrent uploads
      // see each other's in-flight sizes, eliminating the TOCTOU race.  When
      // the client already supplied a reservationId (new upload flow) the
      // existing reservation is consumed in the transaction below.  For the
      // backward-compat path (no reservationId) we create one here.
      if (!reservationId) {
        const reserveResult = await reserveStorageQuota(billedUserId, assetSizeBytes);
        if ('error' in reserveResult) return reserveResult.error;
        reservationId = reserveResult.reservationId;
      }

      const fileName = extractImageFileNameFromProxyUrl(sourceUrl);
      displayName = sanitizeAssetDisplayName(requestedDisplayName, fileName || 'Image');
      thumbnailUrl = sourceUrl;
      kind = 'IMAGE';
    }

    if (provider === VideoAssetProvider.R2_AUDIO) {
      sourceUrl = typeof body?.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
      if (!SAFE_AUDIO_PROXY_PATH.test(sourceUrl)) {
        return apiErrors.badRequest('Audio URL must reference an uploaded audio file');
      }
      const audioCheck = await isFreshAudioAttachment(sourceUrl);
      if (!audioCheck.isFresh) {
        return apiErrors.badRequest('Audio upload expired. Please upload again.');
      }
      assetSizeBytes = audioCheck.sizeBytes;

      // Same reservation logic as R2_IMAGE above
      if (!reservationId) {
        const reserveResult = await reserveStorageQuota(billedUserId, assetSizeBytes);
        if ('error' in reserveResult) return reserveResult.error;
        reservationId = reserveResult.reservationId;
      }

      const fileName = extractAudioFileNameFromProxyUrl(sourceUrl);
      displayName = sanitizeAssetDisplayName(requestedDisplayName, fileName || 'Voice Recording');
      kind = 'AUDIO';
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
      displayName = sanitizeAssetDisplayName(
        requestedDisplayName,
        youtubeTitle || `YouTube ${providerVideoId}`
      );
      sourceUrl = parsedSource.originalUrl;
      thumbnailUrl = getThumbnailUrl(parsedSource, 'large');
      kind = 'VIDEO';
    }

    if (provider === VideoAssetProvider.BUNNY) {
      sourceUrl = typeof body?.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
      providerVideoId =
        typeof body?.providerVideoId === 'string' ? body.providerVideoId.trim() : '';
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

      const quotaError = await enforceStorageQuota(billedUserId, BigInt(0));
      if (quotaError) return quotaError;
    }

    // Pre-fetch Bunny storage BEFORE entering the transaction to avoid making an
    // HTTP call while holding a DB connection open (connection-pool exhaustion
    // risk under adversarial load). Mirrors the discipline in reserveStorageQuota.
    // Only needed for R2 providers where the invalid-reservation fallback quota
    // check requires Bunny usage data.
    const preFetchedBunnyData =
      provider === VideoAssetProvider.R2_IMAGE || provider === VideoAssetProvider.R2_AUDIO
        ? await getCachedUserBunnyStorage()
        : null;

    // Create the VideoAsset and atomically consume the upload reservation (if any)
    // so the spot is never double-counted.
    const created = await db.$transaction(async (tx) => {
      if (reservationId) {
        // Acquire the per-user advisory lock unconditionally so both the happy path
        // (valid reservation) and the fallback path (fake/expired reservation ID) are
        // serialised — eliminating the TOCTOU race in the deleted.count === 0 branch.
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(
            ('x' || left(md5(${billedUserId}), 16))::bit(64)::bigint
          )
        `;
        // Validate the reservation by checking it actually exists and belongs to the
        // billed user. A client-supplied fake ID would delete 0 rows — in that case
        // we fall back to a standard (non-locked) quota check so the bypass attempt
        // is caught rather than silently allowed.
        const deleted = await tx.uploadReservation.deleteMany({
          where: { id: reservationId, billedUserId, expiresAt: { gt: new Date() } },
        });
        if (deleted.count === 0) {
          // Reservation didn't exist — enforce quota the normal way inside the tx.
          // We read inside the same transaction so the check is at least consistent
          // with the asset insert that follows.
          const [r2Row] = await tx.$queryRaw<[{ total: bigint }]>`
            SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
            FROM video_assets
            WHERE "billedUserId" = ${billedUserId}
              AND provider IN ('R2_IMAGE', 'R2_AUDIO')
          `;
          const [resRow] = await tx.$queryRaw<[{ total: bigint }]>`
            SELECT COALESCE(SUM("sizeBytes"), 0)::bigint AS total
            FROM upload_reservations
            WHERE "billedUserId" = ${billedUserId}
              AND "expiresAt" > NOW()
          `;
          const bunnyData = preFetchedBunnyData ?? {};
          const totalUsed =
            (r2Row?.total ?? BigInt(0)) +
            (resRow?.total ?? BigInt(0)) +
            BigInt(bunnyData[billedUserId] ?? 0);
          if (isStripeFeatureEnabled() && totalUsed + assetSizeBytes >= PLAN_STORAGE_LIMIT_BYTES) {
            throw new QuotaExceededInTxError();
          }
        }
      }
      return tx.videoAsset.create({
        data: {
          videoId: context.video.id,
          kind,
          provider,
          displayName,
          sourceUrl,
          providerVideoId,
          thumbnailUrl,
          sizeBytes: assetSizeBytes,
          uploadedByUserId: context.viewerUserId,
          uploadedByGuestIdentityId: context.viewerUserId
            ? null
            : (guestIdentity?.identityId ?? null),
          uploadedByGuestName: context.viewerUserId
            ? null
            : sanitizeAssetDisplayName(
                typeof body?.guestName === 'string' ? body.guestName : null,
                'Guest'
              ),
          billedUserId,
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
    });

    const response = successResponse(
      shapeAssetForViewer(created, context.canDownloadAssets, true),
      201
    );
    if (isGuest && guestIdentity?.shouldSetCookie) {
      setGuestIdentityCookie(response, guestIdentity.identityId);
    }
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    if (error instanceof QuotaExceededInTxError) {
      return apiErrors.storageExceeded() as NextResponse;
    }
    await releaseStorageReservation(reservationId);
    logError('Error creating video asset:', error);
    return apiErrors.internalError('Failed to create asset');
  }
}
