import { db } from '@/lib/db';

export type CreateR2UploadSessionInput = {
  userId: string;
  projectId: string;
  folderId?: string | null;
  targetVideoId?: string | null;
  billedUserId: string;
  objectKey: string;
  thumbnailObjectKey: string;
  declaredSizeBytes: bigint;
  contentType: string;
  reservationId: string | null;
  uploadJti: string;
  expiresAt: Date;
  multipartUploadId?: string | null;
};

export async function createR2UploadSession(input: CreateR2UploadSessionInput) {
  return db.videoUploadSession.create({
    data: {
      userId: input.userId,
      projectId: input.projectId,
      folderId: input.folderId ?? null,
      targetVideoId: input.targetVideoId ?? null,
      billedUserId: input.billedUserId,
      objectKey: input.objectKey,
      thumbnailObjectKey: input.thumbnailObjectKey,
      declaredSizeBytes: input.declaredSizeBytes,
      contentType: input.contentType,
      reservationId: input.reservationId,
      uploadJti: input.uploadJti,
      expiresAt: input.expiresAt,
      multipartUploadId: input.multipartUploadId ?? null,
    },
  });
}

/**
 * Cancels an initiated session whether or not it has expired.
 *
 * The expiry condition that used to be here made the update match zero rows once a
 * session lapsed, so the status stayed INITIATED and `consumedAt` stayed null for good.
 * The r2-init DELETE route releases the quota reservation only when the update reports a
 * row, so every abandoned upload held its reserved bytes against the user's quota
 * permanently, and no sweeper reclaims them. Cancelling something already expired is the
 * case that most needs to work.
 */
export async function cancelR2UploadSession(sessionId: string) {
  return db.videoUploadSession.updateMany({
    where: {
      id: sessionId,
      status: 'INITIATED',
    },
    data: {
      status: 'CANCELLED',
      consumedAt: new Date(),
    },
  });
}
