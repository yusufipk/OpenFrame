import { checkUploadDestination } from '@/lib/content-access';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { parseR2UploadToken, verifyR2UploadToken } from '@/lib/r2-upload-token';
import { abortMultipartVideoUpload, completeMultipartVideoUpload } from '@/lib/r2';
import { isS3VideoUploadsEnabled } from '@/lib/feature-flags';
import { objectKeyToVideoProxyPath } from '@/lib/video-upload-validation';
import { releaseStorageReservation, UPLOAD_RESERVATION_PURPOSES } from '@/lib/storage-quota';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string }> };

type IncomingPart = { partNumber: number; etag: string };

function parseParts(raw: unknown): IncomingPart[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10000) {
    return null;
  }

  const parts: IncomingPart[] = [];
  const seen = new Set<number>();

  for (const entry of raw) {
    const partNumber = (entry as { partNumber?: unknown })?.partNumber;
    const etag = (entry as { etag?: unknown })?.etag;

    if (
      typeof partNumber !== 'number' ||
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > 10000 ||
      seen.has(partNumber)
    ) {
      return null;
    }

    if (typeof etag !== 'string' || etag.trim().length === 0) {
      return null;
    }

    seen.add(partNumber);
    parts.push({ partNumber, etag: etag.trim() });
  }

  return parts;
}

// POST /api/projects/[projectId]/videos/r2-complete
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
    const objectKey = typeof body?.objectKey === 'string' ? body.objectKey.trim() : '';
    const uploadToken = typeof body?.uploadToken === 'string' ? body.uploadToken.trim() : '';
    const parts = parseParts(body?.parts);

    if (!objectKey || !uploadToken) {
      return apiErrors.badRequest('objectKey and uploadToken are required');
    }

    if (!parts) {
      return apiErrors.badRequest('parts must be a non-empty list of { partNumber, etag }');
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
        multipartUploadId: true,
        folderId: true,
        targetVideoId: true,
        reservationId: true,
        billedUserId: true,
      },
    });
    if (!uploadSession || !uploadSession.multipartUploadId) {
      return apiErrors.forbidden('Invalid upload token');
    }

    const destination = await checkUploadDestination(
      projectId,
      uploadSession.folderId,
      uploadSession.targetVideoId,
      session.user.id
    );
    if (!destination?.canEdit)
      return apiErrors.forbidden('Upload destination was removed or access was revoked');
    const proxyUrl = objectKeyToVideoProxyPath(objectKey);
    if (!proxyUrl) {
      return apiErrors.badRequest('Invalid object key');
    }

    try {
      await completeMultipartVideoUpload(objectKey, uploadSession.multipartUploadId, parts);
    } catch (error) {
      logError('Failed to complete R2 multipart upload:', error);
      await abortMultipartVideoUpload(objectKey, uploadSession.multipartUploadId).catch(
        () => undefined
      );
      await db.videoUploadSession.updateMany({
        where: { id: uploadSession.id, status: 'INITIATED' },
        data: { status: 'CANCELLED', consumedAt: new Date() },
      });
      await releaseStorageReservation(
        uploadSession.reservationId,
        uploadSession.billedUserId,
        UPLOAD_RESERVATION_PURPOSES.R2_VIDEO
      );
      return apiErrors.internalError('Failed to complete multipart upload');
    }

    const response = successResponse({ objectKey, proxyUrl });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error completing R2 multipart upload:', error);
    return apiErrors.internalError('Failed to complete upload');
  }
}
