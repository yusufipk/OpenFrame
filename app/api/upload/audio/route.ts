import { checkVideoAccess } from '@/lib/content-access';
import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { rateLimit } from '@/lib/rate-limit';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import {
  deriveGuestUploadContext,
  enforceGuestUploadQuota,
  verifyGuestUploadToken,
} from '@/lib/guest-upload-token';
import {
  reserveStorageQuota,
  releaseStorageReservation,
  UPLOAD_RESERVATION_PURPOSES,
} from '@/lib/storage-quota';
import { logError } from '@/lib/logger';
import {
  ALLOWED_AUDIO_TYPES,
  AUDIO_MIME_ALIASES,
  AUDIO_MIME_TO_EXT,
  hasValidAudioMagicBytes,
  isHtmlContent,
  MAX_AUDIO_UPLOAD_BYTES,
  SAFE_AUDIO_EXTENSIONS,
} from '@/lib/audio-upload-validation';

const MAX_FILE_SIZE = MAX_AUDIO_UPLOAD_BYTES;
const MAX_MULTIPART_BODY_SIZE = MAX_FILE_SIZE + 512 * 1024; // file + multipart overhead

export async function POST(request: NextRequest) {
  try {
    // Check Content-Length header BEFORE loading the file
    const contentLength = request.headers.get('content-length');
    if (contentLength) {
      const bodySize = parseInt(contentLength, 10);
      if (isNaN(bodySize) || bodySize > MAX_MULTIPART_BODY_SIZE) {
        return apiErrors.badRequest('File too large. Maximum size is 10MB.');
      }
    }

    // Rate limit
    const limited = await rateLimit(request, 'voice-upload');
    if (limited) return limited;

    const session = await auth();

    const formData = await request.formData();
    const file = formData.get('audio') as File | null;
    const videoId = formData.get('videoId');
    const uploadToken = formData.get('uploadToken');

    if (!file) {
      return apiErrors.badRequest('No audio file provided');
    }
    if (typeof videoId !== 'string' || !videoId.trim()) {
      return apiErrors.badRequest('videoId is required');
    }

    const safeVideoId = videoId.trim();
    const video = await db.video.findUnique({
      where: { id: safeVideoId },
      include: {
        project: {
          include: { workspace: { select: { ownerId: true } } },
        },
      },
    });
    if (!video) {
      return apiErrors.notFound('Video');
    }

    const access = await checkVideoAccess(video.id, session?.user?.id);
    const shareSession = getShareSessionFromRequest(request, safeVideoId);
    const shareAccess = shareSession
      ? await validateShareLinkAccess({
          token: shareSession.token,
          projectId: video.projectId,
          videoId: safeVideoId,
          requiredPermission: 'COMMENT',
          passwordVerified: shareSession.passwordVerified,
        })
      : {
          hasAccess: false,
          canComment: false,
          canDownload: false,
          allowGuests: false,
          requiresPassword: false,
        };
    const canCommentWithMembership = !!session?.user?.id && access.hasAccess;
    const canCommentWithShareLink =
      shareAccess.canComment && (session?.user?.id ? true : shareAccess.allowGuests);
    if (!canCommentWithMembership && !canCommentWithShareLink) {
      return apiErrors.forbidden('Access denied');
    }

    if (!session?.user?.id) {
      if (typeof uploadToken !== 'string' || !uploadToken.trim()) {
        return apiErrors.badRequest('uploadToken is required for guest uploads');
      }

      const expectedContext = deriveGuestUploadContext(request, shareSession?.token ?? null);
      if (!expectedContext) {
        return apiErrors.forbidden('Missing trusted client IP header');
      }

      const isValidUploadToken = verifyGuestUploadToken(uploadToken.trim(), {
        projectId: video.projectId,
        videoId: safeVideoId,
        intent: 'audio',
        context: expectedContext,
      });
      if (!isValidUploadToken) {
        return apiErrors.forbidden('Invalid upload token');
      }

      const quotaError = await enforceGuestUploadQuota(
        request,
        safeVideoId,
        'audio',
        shareSession?.token ?? null
      );
      if (quotaError) return quotaError;
    }

    // Double-check file size (defense in depth - Content-Length can be spoofed)
    if (file.size > MAX_FILE_SIZE) {
      return apiErrors.badRequest('File too large. Maximum size is 10MB.');
    }

    // Enforce per-user storage quota before uploading.
    // All paths use the advisory-locked reservation so concurrent uploads always
    // see each other's in-flight sizes, eliminating the TOCTOU race.
    const workspaceOwnerId = video.project.workspace.ownerId;
    const reserveResult = await reserveStorageQuota(
      workspaceOwnerId,
      BigInt(file.size),
      UPLOAD_RESERVATION_PURPOSES.AUDIO
    );
    if ('error' in reserveResult) return reserveResult.error;
    const reservationId = reserveResult.reservationId;

    // Normalize content type: strip codec params, then resolve aliases
    const rawContentType = file.type || 'audio/webm';
    const strippedType = rawContentType.split(';')[0].trim().toLowerCase();
    const contentType = AUDIO_MIME_ALIASES[strippedType] ?? strippedType;
    if (!ALLOWED_AUDIO_TYPES.has(contentType)) {
      await releaseStorageReservation(
        reservationId,
        workspaceOwnerId,
        UPLOAD_RESERVATION_PURPOSES.AUDIO
      );
      return apiErrors.badRequest(`Unsupported audio format: ${rawContentType}`);
    }

    // Prefer the original file extension when it's a known safe type (e.g. preserve .opus, .mp3)
    // Fall back to MIME-derived extension for blobs without a real name (e.g. MediaRecorder output)
    const origExt = (file.name.split('.').pop() ?? '').toLowerCase();
    const ext = SAFE_AUDIO_EXTENSIONS.has(origExt)
      ? origExt
      : (AUDIO_MIME_TO_EXT[contentType] ?? 'webm');
    const filename = `${randomUUID()}.${ext}`;
    const key = `voice/${filename}`;

    // Convert to buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Validate file content against magic bytes — rejects HTML/scripts masquerading as audio
    if (isHtmlContent(buffer)) {
      await releaseStorageReservation(
        reservationId,
        workspaceOwnerId,
        UPLOAD_RESERVATION_PURPOSES.AUDIO
      );
      return apiErrors.badRequest('File content does not match an audio format');
    }
    const hasValidMagicBytes = hasValidAudioMagicBytes(buffer.slice(0, 16), contentType);
    if (!hasValidMagicBytes) {
      await releaseStorageReservation(
        reservationId,
        workspaceOwnerId,
        UPLOAD_RESERVATION_PURPOSES.AUDIO
      );
      return apiErrors.badRequest('File content does not match the declared audio format');
    }

    try {
      // Upload to R2
      await r2Client.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        })
      );
    } catch (uploadError) {
      await releaseStorageReservation(
        reservationId,
        workspaceOwnerId,
        UPLOAD_RESERVATION_PURPOSES.AUDIO
      );
      throw uploadError;
    }

    // Return the URL through our proxy endpoint
    const voiceUrl = `/api/upload/audio/${filename}`;

    const response = successResponse({ url: voiceUrl, reservationId }, 201);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error uploading audio:', error);
    return apiErrors.internalError('Failed to upload audio');
  }
}
