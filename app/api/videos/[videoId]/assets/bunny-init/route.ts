import { withApiToken } from '@/lib/api-tokens';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import {
  createBunnyUploadToken,
  readBunnyUploadGrant,
  type BunnyUploadGrant,
} from '@/lib/bunny-upload-token';
import { cleanupBunnyStreamVideos } from '@/lib/bunny-stream-cleanup';
import {
  createGuestUploadToken,
  deriveGuestUploadContext,
  enforceGuestUploadQuota,
  readGuestUploadGrant,
  type GuestUploadGrant,
} from '@/lib/guest-upload-token';
import { isBunnyUploadsEnabled } from '@/lib/feature-flags';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { getVideoAssetAccessContext, SAFE_BUNNY_VIDEO_ID } from '@/lib/video-assets';
import { logError } from '@/lib/logger';
import {
  enforceStorageQuota,
  getMaxVideoUploadBytesForUser,
  releaseStorageReservation,
  reserveStorageQuota,
  UPLOAD_RESERVATION_PURPOSES,
} from '@/lib/storage-quota';
import { parseDeclaredUploadSize } from '@/lib/upload-size';

type RouteParams = { params: Promise<{ videoId: string }> };

// Matches the project video path: long enough to outlive a slow upload and
// Bunny's own reporting delay.
const BUNNY_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * A guest's hold lapses sooner than a member's.
 *
 * A guest is whoever opened the share link, and the hold is written against the
 * workspace owner's quota rather than their own. Declaring a size and then
 * walking away costs the guest nothing and costs the owner their whole remaining
 * allowance, which on a trial is the entire account. Half an hour is the same
 * window the R2 attachment paths already accept, and it bounds what a guest who
 * never uploads can take away. A guest whose upload outruns it loses only the
 * concurrency guard for the tail of the transfer; the bytes are still recorded
 * from the signed size when the asset is created.
 */
const GUEST_BUNNY_RESERVATION_TTL_MS = 30 * 60 * 1000;

// POST /api/videos/[videoId]/assets/bunny-init
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'asset-bunny-init');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'COMMENT');
    if (!context) return apiErrors.notFound('Video');
    if (!context.canUploadAssets) return apiErrors.forbidden('Access denied');

    const body = await request.json().catch(() => null);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) return apiErrors.badRequest('Title is required');

    if (!isBunnyUploadsEnabled()) {
      return apiErrors.badRequest('Direct uploads are disabled by this host');
    }

    // See the project video route for why the client's declared size is asked for
    // and what it is worth: it buys an honest refusal before the upload starts,
    // and a reservation that concurrent uploads can see.
    const billedUserId = context.video.project.workspace.ownerId;
    const declaredSize = parseDeclaredUploadSize(
      body?.sizeBytes,
      await getMaxVideoUploadBytesForUser(billedUserId)
    );
    if ('error' in declaredSize) {
      return apiErrors.badRequest(declaredSize.error);
    }

    const quotaError = await enforceStorageQuota(billedUserId, declaredSize.sizeBytes);
    if (quotaError) return quotaError;

    const shareSession = getShareSessionFromRequest(request, context.video.id);
    if (!context.viewerUserId) {
      const quotaError = await enforceGuestUploadQuota(
        request,
        context.video.id,
        'bunny',
        shareSession?.token ?? null
      );
      if (quotaError) return quotaError;
    }

    const reserveResult = await reserveStorageQuota(
      billedUserId,
      declaredSize.sizeBytes,
      UPLOAD_RESERVATION_PURPOSES.BUNNY,
      context.viewerUserId ? BUNNY_RESERVATION_TTL_MS : GUEST_BUNNY_RESERVATION_TTL_MS
    );
    if ('error' in reserveResult) return reserveResult.error;
    const { reservationId } = reserveResult;

    const apiKey = process.env.BUNNY_STREAM_API_KEY;
    const libraryId =
      process.env.BUNNY_STREAM_LIBRARY_ID || process.env.NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID;
    if (!apiKey || !libraryId) {
      await releaseStorageReservation(
        reservationId,
        billedUserId,
        UPLOAD_RESERVATION_PURPOSES.BUNNY
      );
      return apiErrors.internalError('Bunny Stream is not configured correctly');
    }

    const bunnyRes = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos`, {
      method: 'POST',
      headers: {
        AccessKey: apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ title }),
    });

    if (!bunnyRes.ok) {
      await releaseStorageReservation(
        reservationId,
        billedUserId,
        UPLOAD_RESERVATION_PURPOSES.BUNNY
      );
      logError('Failed to create Bunny Stream video asset', await bunnyRes.text());
      return apiErrors.internalError('Failed to initialize Bunny upload');
    }

    const bunnyVideo = await bunnyRes.json();
    const bunnyVideoId = typeof bunnyVideo?.guid === 'string' ? bunnyVideo.guid.trim() : '';
    if (!bunnyVideoId || !SAFE_BUNNY_VIDEO_ID.test(bunnyVideoId)) {
      await releaseStorageReservation(
        reservationId,
        billedUserId,
        UPLOAD_RESERVATION_PURPOSES.BUNNY
      );
      return apiErrors.internalError('Upload provider did not return a valid video identifier');
    }

    const expirationTime = Math.floor(Date.now() / 1000) + 3600;
    const hash = crypto.createHash('sha256');
    hash.update(libraryId + apiKey + expirationTime + bunnyVideoId);
    const signature = hash.digest('hex');

    let uploadToken = '';
    if (context.viewerUserId) {
      uploadToken = createBunnyUploadToken(
        {
          userId: context.viewerUserId,
          projectId: context.video.projectId,
          videoId: bunnyVideoId,
          reservationId,
          declaredSizeBytes: declaredSize.sizeBytes,
        },
        3600
      );
    } else {
      const expectedContext = deriveGuestUploadContext(request, shareSession?.token ?? null);
      if (!expectedContext) {
        await releaseStorageReservation(
          reservationId,
          billedUserId,
          UPLOAD_RESERVATION_PURPOSES.BUNNY
        );
        return apiErrors.forbidden('Missing trusted client IP header');
      }

      // The guest grant carries the same three claims the signed-in one does,
      // and is bound to the Bunny video as well as to ours. That binding is what
      // makes releasing safe on the guest's say-so: presenting this token to
      // cancel deletes the upload it stands for, so it cannot be used to drop the
      // hold while the transfer carries on.
      uploadToken = createGuestUploadToken(
        {
          projectId: context.video.projectId,
          videoId: context.video.id,
          intent: 'bunny',
          context: expectedContext,
          providerVideoId: bunnyVideoId,
          reservationId,
          declaredSizeBytes: declaredSize.sizeBytes,
        },
        3600
      );
    }

    const response = successResponse({
      videoId: bunnyVideoId,
      libraryId,
      signature,
      expirationTime,
      uploadToken,
    });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error initializing Bunny asset upload:', error);
    return apiErrors.internalError('Failed to initialize asset upload');
  }
}

// DELETE /api/videos/[videoId]/assets/bunny-init
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'asset-bunny-init');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'COMMENT');
    if (!context) return apiErrors.notFound('Video');
    if (!context.canUploadAssets) return apiErrors.forbidden('Access denied');

    const body = await request.json().catch(() => null);
    const bunnyVideoId = typeof body?.videoId === 'string' ? body.videoId.trim() : '';
    const uploadToken = typeof body?.uploadToken === 'string' ? body.uploadToken.trim() : '';
    if (!bunnyVideoId || !uploadToken || !SAFE_BUNNY_VIDEO_ID.test(bunnyVideoId)) {
      return apiErrors.badRequest('videoId and uploadToken are required');
    }

    // Both grants are read rather than merely checked, because both carry the
    // reservation this upload holds. Releasing on the caller's say-so is safe
    // only because the id is signed next to this Bunny video id: presenting the
    // token costs them the video, which is deleted immediately below.
    let grant: BunnyUploadGrant | GuestUploadGrant | null = null;

    if (context.viewerUserId) {
      grant = readBunnyUploadGrant(uploadToken, {
        userId: context.viewerUserId,
        projectId: context.video.projectId,
        videoId: bunnyVideoId,
      });
    } else {
      const shareSession = getShareSessionFromRequest(request, context.video.id);
      const expectedContext = deriveGuestUploadContext(request, shareSession?.token ?? null);
      if (!expectedContext) {
        return apiErrors.forbidden('Missing trusted client IP header');
      }

      grant = readGuestUploadGrant(
        uploadToken,
        {
          projectId: context.video.projectId,
          videoId: context.video.id,
          intent: 'bunny',
          context: expectedContext,
        },
        bunnyVideoId
      );
    }

    if (!grant) {
      return apiErrors.forbidden('Invalid Bunny upload token');
    }

    await releaseStorageReservation(
      grant.reservationId,
      context.video.project.workspace.ownerId,
      UPLOAD_RESERVATION_PURPOSES.BUNNY
    );

    await cleanupBunnyStreamVideos([{ providerId: 'bunny', videoId: bunnyVideoId }]);
    const response = successResponse({ message: 'Pending upload cleaned up' });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error cleaning up Bunny asset upload:', error);
    return apiErrors.internalError('Failed to cleanup pending upload');
  }
}

export const POST = withApiToken('upload', handlePost);
export const DELETE = withApiToken('upload', handleDelete);
