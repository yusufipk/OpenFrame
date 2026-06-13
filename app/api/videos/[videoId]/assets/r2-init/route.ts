import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { db } from '@/lib/db';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import {
  createR2UploadToken,
  parseR2UploadToken,
  verifyR2UploadToken,
} from '@/lib/r2-upload-token';
import {
  createPresignedImagePutUrl,
  createPresignedVideoPutUrl,
  deleteR2Object,
  deleteVideoObject,
} from '@/lib/r2';
import { getMaxVideoUploadBytes, isS3VideoUploadsEnabled } from '@/lib/feature-flags';
import {
  buildVideoObjectKey,
  getVideoExtensionFromMime,
  resolveVideoContentType,
  videoProxyPathFromFilename,
} from '@/lib/video-upload-validation';
import { logError } from '@/lib/logger';
import {
  enforceStorageQuota,
  releaseStorageReservation,
  reserveStorageQuota,
} from '@/lib/storage-quota';
import { createR2UploadSession } from '@/lib/r2-upload-session';
import { getVideoAssetAccessContext } from '@/lib/video-assets';

type RouteParams = { params: Promise<{ videoId: string }> };

const VIDEO_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;
const THUMBNAIL_RESERVE_BYTES = BigInt(512 * 1024);

// POST /api/videos/[videoId]/assets/r2-init
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'asset-r2-init');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'COMMENT');
    if (!context) return apiErrors.notFound('Video');
    if (!context.canUploadAssets) return apiErrors.forbidden('Access denied');

    if (!context.viewerUserId) {
      return apiErrors.unauthorized('Sign in is required for direct video uploads');
    }

    if (!isS3VideoUploadsEnabled()) {
      return apiErrors.badRequest('S3 video uploads are disabled by this host');
    }

    const body = await request.json().catch(() => null);
    const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
    const contentTypeInput = typeof body?.contentType === 'string' ? body.contentType.trim() : '';
    const sizeBytesRaw = body?.sizeBytes;

    if (!fileName) {
      return apiErrors.badRequest('fileName is required');
    }

    let sizeBytes: bigint;
    try {
      sizeBytes = BigInt(sizeBytesRaw);
      if (sizeBytes <= BigInt(0)) {
        return apiErrors.badRequest('sizeBytes must be a positive integer');
      }
    } catch {
      return apiErrors.badRequest('sizeBytes must be a positive integer');
    }

    const maxBytes = getMaxVideoUploadBytes();
    if (sizeBytes > maxBytes) {
      return apiErrors.badRequest('Video file exceeds the maximum allowed upload size');
    }

    const contentType = resolveVideoContentType(fileName, contentTypeInput);
    if (!contentType) {
      return apiErrors.badRequest('Unsupported video format');
    }

    const ext = getVideoExtensionFromMime(contentType);
    if (!ext) {
      return apiErrors.badRequest('Unsupported video format');
    }

    const billedUserId = context.video.project.workspace.ownerId;
    const projectId = context.video.projectId;

    const quotaError = await enforceStorageQuota(billedUserId, sizeBytes + THUMBNAIL_RESERVE_BYTES);
    if (quotaError) return quotaError;

    const reserveResult = await reserveStorageQuota(
      billedUserId,
      sizeBytes + THUMBNAIL_RESERVE_BYTES,
      VIDEO_RESERVATION_TTL_MS
    );
    if ('error' in reserveResult) return reserveResult.error;

    const fileId = randomUUID();
    const filename = `${fileId}.${ext}`;
    const objectKey = buildVideoObjectKey(filename);
    const proxyUrl = videoProxyPathFromFilename(filename);
    const thumbnailFilename = `${fileId}.jpg`;
    const thumbnailObjectKey = `images/${thumbnailFilename}`;
    const thumbnailProxyUrl = `/api/upload/image/${thumbnailFilename}`;

    let presignedPutUrl: string;
    let thumbnailPresignedPutUrl: string;
    try {
      [presignedPutUrl, thumbnailPresignedPutUrl] = await Promise.all([
        createPresignedVideoPutUrl(objectKey, contentType, sizeBytes),
        createPresignedImagePutUrl(thumbnailObjectKey, 'image/jpeg'),
      ]);
    } catch (error) {
      await releaseStorageReservation(reserveResult.reservationId, billedUserId);
      logError('Failed to create presigned asset video upload URL:', error);
      return apiErrors.internalError('Failed to initialize video upload');
    }

    const uploadJti = randomUUID();
    const expiresAt = new Date(Date.now() + VIDEO_RESERVATION_TTL_MS);
    const uploadSession = await createR2UploadSession({
      userId: context.viewerUserId,
      projectId,
      billedUserId,
      objectKey,
      thumbnailObjectKey,
      declaredSizeBytes: sizeBytes,
      contentType,
      reservationId: reserveResult.reservationId,
      uploadJti,
      expiresAt,
    });

    const uploadToken = createR2UploadToken({
      userId: context.viewerUserId,
      projectId,
      objectKey,
      sessionId: uploadSession.id,
      tokenId: uploadJti,
      thumbnailObjectKey,
    });

    const response = successResponse({
      presignedPutUrl,
      objectKey,
      proxyUrl,
      uploadToken,
      reservationId: reserveResult.reservationId,
      contentType,
      thumbnailPresignedPutUrl,
      thumbnailObjectKey,
      thumbnailProxyUrl,
    });

    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error initializing R2 asset video upload:', error);
    return apiErrors.internalError('Failed to initialize upload');
  }
}

// DELETE /api/videos/[videoId]/assets/r2-init
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'asset-r2-init');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'COMMENT');
    if (!context) return apiErrors.notFound('Video');
    if (!context.canUploadAssets) return apiErrors.forbidden('Access denied');

    if (!context.viewerUserId) {
      return apiErrors.unauthorized();
    }

    if (!isS3VideoUploadsEnabled()) {
      return apiErrors.badRequest('S3 video uploads are disabled by this host');
    }

    const body = await request.json().catch(() => null);
    const objectKey = typeof body?.objectKey === 'string' ? body.objectKey.trim() : '';
    const uploadToken = typeof body?.uploadToken === 'string' ? body.uploadToken.trim() : '';
    const thumbnailObjectKey =
      typeof body?.thumbnailObjectKey === 'string' ? body.thumbnailObjectKey.trim() : '';

    if (!objectKey || !uploadToken) {
      return apiErrors.badRequest('objectKey and uploadToken are required');
    }

    const projectId = context.video.projectId;
    const tokenPayload = parseR2UploadToken(uploadToken);
    if (!tokenPayload) {
      return apiErrors.forbidden('Invalid upload token');
    }

    const isValidUploadToken = verifyR2UploadToken(uploadToken, {
      userId: context.viewerUserId,
      projectId,
      objectKey,
      sessionId: tokenPayload.sid,
      tokenId: tokenPayload.jti,
    });
    if (!isValidUploadToken) {
      return apiErrors.forbidden('Invalid upload token');
    }

    const uploadSession = await db.videoUploadSession.findFirst({
      where: {
        id: tokenPayload.sid,
        status: 'INITIATED',
        userId: context.viewerUserId,
        projectId,
        objectKey,
        uploadJti: tokenPayload.jti,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        reservationId: true,
        billedUserId: true,
        thumbnailObjectKey: true,
      },
    });
    if (!uploadSession) {
      return apiErrors.forbidden('Invalid upload token');
    }

    if (thumbnailObjectKey && thumbnailObjectKey !== uploadSession.thumbnailObjectKey) {
      return apiErrors.badRequest('Invalid thumbnail object key');
    }

    const cancelled = await db.videoUploadSession.updateMany({
      where: {
        id: uploadSession.id,
        status: 'INITIATED',
      },
      data: {
        status: 'CANCELLED',
        consumedAt: new Date(),
      },
    });
    if (cancelled.count !== 1) {
      return apiErrors.forbidden('Invalid upload token');
    }

    try {
      await Promise.all([
        deleteVideoObject(objectKey),
        uploadSession.thumbnailObjectKey.startsWith('images/')
          ? deleteR2Object(uploadSession.thumbnailObjectKey)
          : Promise.resolve(),
      ]);
    } catch (error) {
      logError('Failed to delete pending R2 asset video object:', error);
    }

    await releaseStorageReservation(uploadSession.reservationId, uploadSession.billedUserId);

    const response = successResponse({ message: 'Pending upload cleaned up' });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error cleaning up pending R2 asset video upload:', error);
    return apiErrors.internalError('Failed to cleanup pending upload');
  }
}
