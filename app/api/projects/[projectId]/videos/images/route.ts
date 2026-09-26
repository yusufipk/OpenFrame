import { randomUUID } from 'crypto';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { NextRequest } from 'next/server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { checkUploadDestination } from '@/lib/content-access';
import { contentId, contentTransaction, ContentError } from '@/lib/content-mutations';
import { db } from '@/lib/db';
import { hasR2Config } from '@/lib/feature-flags';
import {
  detectImageMime,
  getImageExtension,
  normalizeImageMime,
} from '@/lib/image-upload-validation';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import {
  reserveStorageQuota,
  releaseStorageReservation,
  UPLOAD_RESERVATION_PURPOSES,
} from '@/lib/storage-quota';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { notifyProjectOwner } from '@/lib/notifications';
import { eventKey, recordEvent } from '@/lib/analytics/record';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type RouteParams = { params: Promise<{ projectId: string }> };

function optionalText(value: FormDataEntryValue | null, maxLength: number): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw new ContentError(400, `Text must be ${maxLength} characters or fewer`);
  }
  return value.trim() || null;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  let reservationId: string | null = null;
  let billedUserId: string | null = null;
  const uploadedKeys: string[] = [];
  try {
    const limited = await rateLimit(request, 'create-video');
    if (limited) return limited;
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    const { projectId } = await params;
    if (!hasR2Config())
      return apiErrors.badRequest('Image uploads require configured object storage');

    const contentLength = request.headers.get('content-length');
    if (contentLength !== null) {
      const declaredLength = Number(contentLength);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 1) {
        return apiErrors.badRequest('Invalid Content-Length header');
      }
      if (declaredLength > MAX_IMAGE_BYTES + 512 * 1024) {
        return apiErrors.badRequest('Image is too large. Maximum size is 20MB.');
      }
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File) || form.getAll('file').length !== 1 || file.size === 0) {
      return apiErrors.badRequest('One image file is required');
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return apiErrors.badRequest('Image is too large. Maximum size is 20MB.');
    }

    const targetVideoId = contentId(form.get('targetVideoId'));
    const folderId = contentId(form.get('folderId'));
    const title = optionalText(form.get('title'), 100) || file.name.replace(/\.[^.]+$/, '').trim();
    const description = optionalText(form.get('description'), 5000);
    const versionLabel = optionalText(form.get('versionLabel'), 100);
    if (!title || title.length > 100)
      return apiErrors.badRequest('Title must contain 1 to 100 characters');

    const destination = await checkUploadDestination(
      projectId,
      folderId,
      targetVideoId,
      session.user.id
    );
    if (!destination?.canEdit) return apiErrors.forbidden('Upload destination is unavailable');
    if (targetVideoId && (!('video' in destination) || destination.video?.mediaType !== 'IMAGE')) {
      return apiErrors.badRequest('Image versions require an image review');
    }
    billedUserId = await db.project
      .findUnique({
        where: { id: projectId },
        select: { workspace: { select: { ownerId: true } } },
      })
      .then((project) => project?.workspace.ownerId ?? null);
    if (!billedUserId) return apiErrors.notFound('Project');
    const reservedOwnerId = billedUserId;

    const suppliedMime = normalizeImageMime(file.type);
    if (suppliedMime && !IMAGE_MIME_TYPES.has(suppliedMime)) {
      return apiErrors.badRequest('Only PNG, JPEG and WebP images are supported');
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const detectedMime = detectImageMime(bytes);
    if (
      !detectedMime ||
      !IMAGE_MIME_TYPES.has(detectedMime) ||
      (suppliedMime && suppliedMime !== detectedMime)
    ) {
      return apiErrors.badRequest('Image content does not match a supported format');
    }
    let thumbnailBytes: Buffer;
    try {
      const decoder = sharp(bytes, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS });
      const metadata = await decoder.metadata();
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width * metadata.height > MAX_IMAGE_PIXELS ||
        !['jpeg', 'png', 'webp'].includes(metadata.format) ||
        (metadata.pages ?? 1) !== 1
      ) {
        return apiErrors.badRequest('Image dimensions or format are not supported');
      }
      await decoder.stats();
      thumbnailBytes = await sharp(bytes, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS })
        .rotate()
        .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 76 })
        .toBuffer();
    } catch {
      return apiErrors.badRequest('Image could not be decoded or exceeds the 20 megapixel limit');
    }

    const reservation = await reserveStorageQuota(
      reservedOwnerId,
      BigInt(bytes.length + thumbnailBytes.length),
      UPLOAD_RESERVATION_PURPOSES.IMAGE
    );
    if ('error' in reservation) return reservation.error;
    reservationId = reservation.reservationId;

    const key = `images/${randomUUID()}.${getImageExtension(detectedMime)}`;
    const originalUrl = `/api/upload/image/${key.slice('images/'.length)}`;
    const thumbnailKey = `images/${randomUUID()}.webp`;
    const thumbnailUrl = `/api/upload/image/${thumbnailKey.slice('images/'.length)}`;
    uploadedKeys.push(key, thumbnailKey);
    const uploads = await Promise.allSettled([
      r2Client.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: key,
          Body: bytes,
          ContentType: detectedMime,
        })
      ),
      r2Client.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: thumbnailKey,
          Body: thumbnailBytes,
          ContentType: 'image/webp',
        })
      ),
    ]);
    const failedUpload = uploads.find((upload) => upload.status === 'rejected');
    if (failedUpload?.status === 'rejected') throw failedUpload.reason;
    const result = await contentTransaction([projectId], async (tx) => {
      const current = await checkUploadDestination(
        projectId,
        folderId,
        targetVideoId,
        session.user.id,
        tx
      );
      if (
        !current?.canEdit ||
        (targetVideoId && (!('video' in current) || current.video?.mediaType !== 'IMAGE'))
      ) {
        throw new ContentError(403, 'Upload destination changed');
      }
      const currentOwnerId = await tx.project
        .findUnique({
          where: { id: projectId },
          select: { workspace: { select: { ownerId: true } } },
        })
        .then((project) => project?.workspace.ownerId ?? null);
      if (currentOwnerId !== reservedOwnerId)
        throw new ContentError(403, 'Upload billing destination changed');
      const video = targetVideoId
        ? 'video' in current
          ? current.video!
          : neverUploadTarget()
        : await tx.video.create({
            data: {
              projectId,
              folderId,
              mediaType: 'IMAGE',
              title,
              description,
              position:
                ((await tx.video.aggregate({ where: { projectId }, _max: { position: true } }))._max
                  .position ?? -1) + 1,
            },
          });
      const latest = targetVideoId
        ? await tx.videoVersion.findFirst({
            where: { videoParentId: video.id },
            orderBy: { versionNumber: 'desc' },
          })
        : null;
      const version = await tx.videoVersion.create({
        data: {
          videoParentId: video.id,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          versionLabel,
          providerId: 'r2-image',
          videoId: key,
          originalUrl,
          thumbnailUrl,
          title: versionLabel || title,
          duration: null,
          sizeBytes: BigInt(bytes.length),
          thumbnailSizeBytes: BigInt(thumbnailBytes.length),
          isActive: true,
        },
      });
      if (targetVideoId) {
        await tx.videoVersion.updateMany({
          where: { videoParentId: video.id, id: { not: version.id } },
          data: { isActive: false },
        });
      }
      if (reservationId) {
        await tx.uploadReservation.deleteMany({
          where: {
            id: reservationId,
            billedUserId: reservedOwnerId,
            purpose: UPLOAD_RESERVATION_PURPOSES.IMAGE,
          },
        });
      }
      return {
        id: video.id,
        videoId: video.id,
        versionId: version.id,
        savedVideoTitle: video.title,
      };
    });
    const { savedVideoTitle, ...responseData } = result;
    uploadedKeys.length = 0;
    reservationId = null;
    try {
      revalidatePath(`/projects/${projectId}`);
      const project = await db.project.findUnique({
        where: { id: projectId },
        select: { ownerId: true, name: true },
      });
      if (project && project.ownerId !== session.user.id) {
        const notification = targetVideoId
          ? {
              type: 'new_version' as const,
              mediaType: 'IMAGE' as const,
              projectName: project.name,
              videoTitle: savedVideoTitle,
              versionLabel: versionLabel || 'New version',
              addedBy: session.user.name || 'A team member',
              url: `${process.env.NEXTAUTH_URL || ''}/watch/${result.id}`,
            }
          : {
              type: 'new_video' as const,
              mediaType: 'IMAGE' as const,
              projectName: project.name,
              videoTitle: savedVideoTitle,
              addedBy: session.user.name || 'A team member',
              url: `${process.env.NEXTAUTH_URL || ''}/watch/${result.id}`,
            };
        notifyProjectOwner(project.ownerId, notification).catch((error) =>
          logError('Image review notification failed:', error)
        );
      }
      if (!targetVideoId && project) {
        await recordEvent({
          name: 'VIDEO_ADDED',
          dedupeKey: eventKey('VIDEO_ADDED', result.id),
          userId: project.ownerId,
        });
      }
    } catch (error) {
      logError('Image review post-create update failed:', error);
    }
    return withCacheControl(successResponse(responseData, 201), 'private, no-store');
  } catch (error) {
    await Promise.all(
      uploadedKeys.map(async (key) => {
        try {
          await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
        } catch (cleanupError) {
          logError('Failed to remove image after upload error:', cleanupError);
        }
      })
    );
    if (error instanceof ContentError) {
      if (error.status === 403) return apiErrors.forbidden(error.message);
      return apiErrors.badRequest(error.message);
    }
    logError('Error uploading image review:', error);
    return apiErrors.internalError('Failed to upload image review');
  } finally {
    if (reservationId) {
      try {
        await releaseStorageReservation(
          reservationId,
          billedUserId,
          UPLOAD_RESERVATION_PURPOSES.IMAGE
        );
      } catch (error) {
        logError('Failed to release image upload reservation:', error);
      }
    }
  }
}

function neverUploadTarget(): never {
  throw new ContentError(403, 'Upload destination changed');
}
