/**
 * Stores an image review (or a new version of one) from bytes already in
 * memory: validates and decodes the image, writes it and a thumbnail to
 * storage, and creates the rows. Shared by the browser upload route and the
 * Google Drive import, so both accept exactly the same images.
 */

import { randomUUID } from 'crypto';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import type { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { checkUploadDestination } from '@/lib/content-access';
import { contentTransaction, ContentError } from '@/lib/content-mutations';
import { db } from '@/lib/db';
import { detectImageMime, getImageExtension } from '@/lib/image-upload-validation';
import { logError } from '@/lib/logger';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import {
  reserveStorageQuota,
  releaseStorageReservation,
  UPLOAD_RESERVATION_PURPOSES,
} from '@/lib/storage-quota';
import { notifyProjectOwner } from '@/lib/notifications';
import { eventKey, recordAccountActivity, recordEvent } from '@/lib/analytics/record';

export const MAX_IMAGE_REVIEW_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
export const IMAGE_REVIEW_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type StoreImageReviewInput = {
  projectId: string;
  folderId: string | null;
  targetVideoId: string | null;
  userId: string;
  userName: string | null | undefined;
  /** The workspace owner the upload was checked against; re-checked in the transaction. */
  reservedOwnerId: string;
  bytes: Buffer;
  /** The type the uploader claimed, already normalized; null when none was given. */
  suppliedMime: string | null;
  title: string;
  description: string | null;
  versionLabel: string | null;
};

export type StoredImageReview = { id: string; videoId: string; versionId: string };

/**
 * Throws ContentError (400 for a bad image, 403 for a changed destination).
 * Returns `{ response }` when the storage quota refuses the upload. Whatever it
 * put in storage or reserved is given back on any failure.
 */
export async function storeImageReview(
  input: StoreImageReviewInput
): Promise<{ data: StoredImageReview } | { response: NextResponse }> {
  const { projectId, folderId, targetVideoId, reservedOwnerId, bytes, suppliedMime } = input;
  let reservationId: string | null = null;
  const uploadedKeys: string[] = [];
  try {
    if (suppliedMime && !IMAGE_REVIEW_MIME_TYPES.has(suppliedMime)) {
      throw new ContentError(400, 'Only PNG, JPEG and WebP images are supported');
    }
    const detectedMime = detectImageMime(bytes);
    if (
      !detectedMime ||
      !IMAGE_REVIEW_MIME_TYPES.has(detectedMime) ||
      (suppliedMime && suppliedMime !== detectedMime)
    ) {
      throw new ContentError(400, 'Image content does not match a supported format');
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
        throw new ContentError(400, 'Image dimensions or format are not supported');
      }
      await decoder.stats();
      thumbnailBytes = await sharp(bytes, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS })
        .rotate()
        .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 76 })
        .toBuffer();
    } catch (error) {
      if (error instanceof ContentError) throw error;
      throw new ContentError(400, 'Image could not be decoded or exceeds the 20 megapixel limit');
    }

    const reservation = await reserveStorageQuota(
      reservedOwnerId,
      BigInt(bytes.length + thumbnailBytes.length),
      UPLOAD_RESERVATION_PURPOSES.IMAGE,
      undefined,
      input.userId
    );
    if ('error' in reservation) return { response: reservation.error };
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
    const heldReservationId = reservationId;
    const result = await contentTransaction([projectId], async (tx) => {
      const current = await checkUploadDestination(
        projectId,
        folderId,
        targetVideoId,
        input.userId,
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
              title: input.title,
              description: input.description,
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
          versionLabel: input.versionLabel,
          providerId: 'r2-image',
          videoId: key,
          originalUrl,
          thumbnailUrl,
          title: input.versionLabel || input.title,
          duration: null,
          sizeBytes: BigInt(bytes.length),
          thumbnailSizeBytes: BigInt(thumbnailBytes.length),
          isActive: true,
          uploadedById: input.userId,
        },
      });
      if (targetVideoId) {
        await tx.videoVersion.updateMany({
          where: { videoParentId: video.id, id: { not: version.id } },
          data: { isActive: false },
        });
      }
      if (heldReservationId) {
        await tx.uploadReservation.deleteMany({
          where: {
            id: heldReservationId,
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
    const { savedVideoTitle, ...data } = result;
    uploadedKeys.length = 0;
    reservationId = null;
    try {
      revalidatePath(`/projects/${projectId}`);
      const project = await db.project.findUnique({
        where: { id: projectId },
        select: { ownerId: true, name: true },
      });
      if (project && project.ownerId !== input.userId) {
        const notification = targetVideoId
          ? {
              type: 'new_version' as const,
              mediaType: 'IMAGE' as const,
              projectName: project.name,
              videoTitle: savedVideoTitle,
              versionLabel: input.versionLabel || 'New version',
              addedBy: input.userName || 'A team member',
              url: `${process.env.NEXTAUTH_URL || ''}/watch/${result.id}`,
            }
          : {
              type: 'new_video' as const,
              mediaType: 'IMAGE' as const,
              projectName: project.name,
              videoTitle: savedVideoTitle,
              addedBy: input.userName || 'A team member',
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
          actorId: input.userId,
        });
      }
      if (targetVideoId) {
        await recordAccountActivity({
          name: 'VERSION_ADDED',
          accountId: reservedOwnerId,
          actorId: input.userId,
        });
      }
    } catch (error) {
      logError('Image review post-create update failed:', error);
    }
    return { data };
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
    throw error;
  } finally {
    if (reservationId) {
      try {
        await releaseStorageReservation(
          reservationId,
          reservedOwnerId,
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
