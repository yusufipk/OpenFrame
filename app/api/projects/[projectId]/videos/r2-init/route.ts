import { checkUploadDestination } from '@/lib/content-access';
import { contentId } from '@/lib/content-mutations';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import {
  createR2UploadToken,
  parseR2UploadToken,
  verifyR2UploadToken,
} from '@/lib/r2-upload-token';
import {
  abortMultipartVideoUpload,
  createMultipartVideoUpload,
  createPresignedImagePutUrl,
  createPresignedUploadPartUrl,
  createPresignedVideoPutUrl,
  deleteR2Object,
  deleteVideoObject,
} from '@/lib/r2';
import {
  getR2MultipartPartSizeBytes,
  getR2MultipartThresholdBytes,
  isS3VideoUploadsEnabled,
} from '@/lib/feature-flags';
import {
  buildVideoObjectKey,
  getVideoExtensionFromMime,
  resolveVideoContentType,
  videoProxyPathFromFilename,
} from '@/lib/video-upload-validation';
import { logError } from '@/lib/logger';
import {
  enforceStorageQuota,
  getMaxVideoUploadBytesForUser,
  releaseStorageReservation,
  reserveStorageQuota,
  UPLOAD_RESERVATION_PURPOSES,
} from '@/lib/storage-quota';
import { uploadTooLargeMessage } from '@/lib/upload-size';
import { createR2UploadSession } from '@/lib/r2-upload-session';

type RouteParams = { params: Promise<{ projectId: string }> };

const VIDEO_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;
const THUMBNAIL_RESERVE_BYTES = BigInt(512 * 1024);

async function getProjectWithEditAccess(
  projectId: string,
  userId: string,
  folderId: string | null = null,
  targetVideoId: string | null = null
) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      ownerId: true,
      workspaceId: true,
      visibility: true,
      workspace: { select: { ownerId: true } },
    },
  });

  if (!project) return null;

  const access = await checkUploadDestination(projectId, folderId, targetVideoId, userId);
  if (!access?.canEdit) return null;

  return project;
}

// POST /api/projects/[projectId]/videos/r2-init
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    if (!isS3VideoUploadsEnabled()) {
      return apiErrors.badRequest('S3 video uploads are disabled by this host');
    }

    const body = await request.json().catch(() => null);
    const folderId = contentId(body?.folderId);
    const targetVideoId = contentId(body?.targetVideoId);
    const project = await getProjectWithEditAccess(
      projectId,
      session.user.id,
      folderId,
      targetVideoId
    );
    if (!project) {
      return apiErrors.forbidden('Access denied');
    }

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

    const maxBytes = await getMaxVideoUploadBytesForUser(project.workspace.ownerId);
    if (sizeBytes > maxBytes) {
      return apiErrors.badRequest(uploadTooLargeMessage(maxBytes));
    }

    const contentType = resolveVideoContentType(fileName, contentTypeInput);
    if (!contentType) {
      return apiErrors.badRequest('Unsupported video format');
    }

    const ext = getVideoExtensionFromMime(contentType);
    if (!ext) {
      return apiErrors.badRequest('Unsupported video format');
    }

    const quotaError = await enforceStorageQuota(
      project.workspace.ownerId,
      sizeBytes + THUMBNAIL_RESERVE_BYTES
    );
    if (quotaError) return quotaError;

    const reserveResult = await reserveStorageQuota(
      project.workspace.ownerId,
      sizeBytes + THUMBNAIL_RESERVE_BYTES,
      UPLOAD_RESERVATION_PURPOSES.R2_VIDEO,
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

    const useMultipart = sizeBytes > getR2MultipartThresholdBytes();

    let presignedPutUrl = '';
    let thumbnailPresignedPutUrl: string;
    let multipartUploadId: string | null = null;
    let multipart: {
      uploadId: string;
      partSizeBytes: number;
      parts: Array<{ partNumber: number; url: string }>;
    } | null = null;

    try {
      if (useMultipart) {
        const partSize = getR2MultipartPartSizeBytes();
        const partCount = Number((sizeBytes + partSize - BigInt(1)) / partSize);

        multipartUploadId = await createMultipartVideoUpload(objectKey, contentType);

        try {
          const [parts, thumbnailUrl] = await Promise.all([
            Promise.all(
              Array.from({ length: partCount }, async (_unused, index) => {
                const partNumber = index + 1;
                const url = await createPresignedUploadPartUrl(
                  objectKey,
                  multipartUploadId as string,
                  partNumber
                );
                return { partNumber, url };
              })
            ),
            createPresignedImagePutUrl(thumbnailObjectKey, 'image/jpeg'),
          ]);

          multipart = { uploadId: multipartUploadId, partSizeBytes: Number(partSize), parts };
          thumbnailPresignedPutUrl = thumbnailUrl;
        } catch (error) {
          await abortMultipartVideoUpload(objectKey, multipartUploadId).catch(() => undefined);
          throw error;
        }
      } else {
        [presignedPutUrl, thumbnailPresignedPutUrl] = await Promise.all([
          createPresignedVideoPutUrl(objectKey, contentType, sizeBytes),
          createPresignedImagePutUrl(thumbnailObjectKey, 'image/jpeg'),
        ]);
      }
    } catch (error) {
      await releaseStorageReservation(
        reserveResult.reservationId,
        project.workspace.ownerId,
        UPLOAD_RESERVATION_PURPOSES.R2_VIDEO
      );
      logError('Failed to create presigned video upload URL:', error);
      return apiErrors.internalError('Failed to initialize video upload');
    }

    const uploadJti = randomUUID();
    const expiresAt = new Date(Date.now() + VIDEO_RESERVATION_TTL_MS);
    const uploadSession = await createR2UploadSession({
      folderId,
      targetVideoId,
      userId: session.user.id,
      projectId,
      billedUserId: project.workspace.ownerId,
      objectKey,
      thumbnailObjectKey,
      declaredSizeBytes: sizeBytes,
      contentType,
      reservationId: reserveResult.reservationId,
      uploadJti,
      expiresAt,
      multipartUploadId,
    });

    const uploadToken = createR2UploadToken({
      userId: session.user.id,
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
      multipart,
    });

    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error initializing R2 video upload:', error);
    return apiErrors.internalError('Failed to initialize upload');
  }
}

// DELETE /api/projects/[projectId]/videos/r2-init
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;

    if (!session?.user?.id) {
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

    const tokenPayload = parseR2UploadToken(uploadToken);
    if (!tokenPayload) {
      return apiErrors.forbidden('Invalid upload token');
    }

    const isValidUploadToken = verifyR2UploadToken(uploadToken, {
      userId: session.user.id,
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
        userId: session.user.id,
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
        multipartUploadId: true,
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
        uploadSession.multipartUploadId
          ? abortMultipartVideoUpload(objectKey, uploadSession.multipartUploadId)
          : Promise.resolve(),
        deleteVideoObject(objectKey),
        uploadSession.thumbnailObjectKey.startsWith('images/')
          ? deleteR2Object(uploadSession.thumbnailObjectKey)
          : Promise.resolve(),
      ]);
    } catch (error) {
      logError('Failed to delete pending R2 video object:', error);
    }

    await releaseStorageReservation(
      uploadSession.reservationId,
      uploadSession.billedUserId,
      UPLOAD_RESERVATION_PURPOSES.R2_VIDEO
    );

    const response = successResponse({ message: 'Pending upload cleaned up' });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error cleaning up pending R2 video upload:', error);
    return apiErrors.internalError('Failed to cleanup pending upload');
  }
}
