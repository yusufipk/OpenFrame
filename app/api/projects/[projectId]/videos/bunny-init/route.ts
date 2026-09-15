import { checkUploadDestination } from '@/lib/content-access';
import { contentId, contentTransaction } from '@/lib/content-mutations';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import crypto from 'crypto';
import { cleanupBunnyStreamVideos } from '@/lib/bunny-stream-cleanup';
import { createBunnyUploadToken, readBunnyUploadGrant } from '@/lib/bunny-upload-token';
import { isBunnyUploadsEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import {
  enforceStorageQuota,
  getMaxVideoUploadBytesForUser,
  releaseStorageReservation,
  reserveStorageQuota,
  UPLOAD_RESERVATION_PURPOSES,
} from '@/lib/storage-quota';
import { parseDeclaredUploadSize } from '@/lib/upload-size';

type RouteParams = { params: Promise<{ projectId: string }> };

// Long enough to outlive a slow upload and Bunny's own reporting delay, matching
// what the R2 video path already reserves for. The reservation is what makes
// concurrent uploads visible to each other, so it has to stay until the bytes it
// stands for are counted, not until the upload finishes.
const BUNNY_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

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
  const canEdit = access?.canEdit;

  if (!canEdit) return null;

  return project;
}

// POST /api/projects/[projectId]/videos/bunny-init
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
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

    const title = typeof body?.title === 'string' ? body.title.trim() : '';

    if (!title) {
      return apiErrors.badRequest('Title is required');
    }

    if (!isBunnyUploadsEnabled()) {
      return apiErrors.badRequest('Bunny direct uploads are disabled by this host');
    }

    // The size the client says it is about to upload. It is a claim, not proof,
    // and the bytes never pass through us to be checked: they go straight to
    // Bunny, whose own reporting is what eventually settles the account. What
    // the claim buys is the two things asking for zero bytes could not. An
    // upload that plainly does not fit is refused before it starts instead of
    // halfway through, and the reservation written below makes concurrent
    // uploads visible to each other, where previously every request in the same
    // two-minute window read the same stale total and every one of them passed.
    const billedUserId = project.workspace.ownerId;
    const declaredSize = parseDeclaredUploadSize(
      body?.sizeBytes,
      await getMaxVideoUploadBytesForUser(billedUserId)
    );
    if ('error' in declaredSize) {
      return apiErrors.badRequest(declaredSize.error);
    }

    const quotaError = await enforceStorageQuota(billedUserId, declaredSize.sizeBytes);
    if (quotaError) return quotaError;

    const reserveResult = await reserveStorageQuota(
      billedUserId,
      declaredSize.sizeBytes,
      UPLOAD_RESERVATION_PURPOSES.BUNNY,
      BUNNY_RESERVATION_TTL_MS
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

    // 1. Create video object in Bunny Stream
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
      logError('Failed to create Bunny Stream video', await bunnyRes.text());
      return apiErrors.internalError('Failed to initialize video upload with provider');
    }

    const bunnyVideo = await bunnyRes.json();
    const videoId = bunnyVideo.guid;
    if (typeof videoId !== 'string' || videoId.length === 0) {
      await releaseStorageReservation(
        reservationId,
        billedUserId,
        UPLOAD_RESERVATION_PURPOSES.BUNNY
      );
      return apiErrors.internalError('Upload provider did not return a valid video identifier');
    }

    // 2. Generate TUS upload signature
    const expirationTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour validity

    // SHA256(library_id + api_key + expiration_time + video_id)
    const hash = crypto.createHash('sha256');
    hash.update(libraryId + apiKey + expirationTime + videoId);
    const signature = hash.digest('hex');
    const uploadToken = createBunnyUploadToken(
      {
        folderId,
        targetVideoId,
        userId: session.user.id,
        projectId,
        videoId,
        reservationId,
        declaredSizeBytes: declaredSize.sizeBytes,
      },
      3600
    );

    const response = successResponse({
      videoId,
      libraryId,
      signature,
      expirationTime,
      uploadToken,
    });

    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error initializing Bunny upload:', error);
    return apiErrors.internalError('Failed to initialize upload');
  }
}

// DELETE /api/projects/[projectId]/videos/bunny-init
// Best-effort cleanup for interrupted uploads before a DB row is created.
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { workspace: { select: { ownerId: true } } },
    });
    if (!project) {
      return apiErrors.forbidden('Access denied');
    }

    const body = await request.json().catch(() => null);
    const videoId = typeof body?.videoId === 'string' ? body.videoId.trim() : '';
    const uploadToken = typeof body?.uploadToken === 'string' ? body.uploadToken.trim() : '';

    if (!videoId || !uploadToken) {
      return apiErrors.badRequest('videoId and uploadToken are required');
    }

    const grant = readBunnyUploadGrant(uploadToken, {
      userId: session.user.id,
      projectId,
      videoId,
    });
    if (!grant) {
      return apiErrors.forbidden('Invalid Bunny upload token');
    }

    const cleaned = await contentTransaction([projectId], async (tx) => {
      // A signed uploader can abandon pending media after losing content access,
      // but cannot delete media that has already been attached to a video.
      const [versions, assets] = await Promise.all([
        tx.videoVersion.count({ where: { providerId: 'bunny', videoId } }),
        tx.videoAsset.count({ where: { provider: 'BUNNY', providerVideoId: videoId } }),
      ]);
      const attached = versions + assets;
      if (attached) return false;

      // Giving the quota back here rather than waiting for the reservation to
      // lapse: an abandoned upload that keeps holding gigabytes for two hours is
      // most of a trial's whole allowance, and the account has nothing to show for
      // it. Safe to do on a caller's say-so only because the reservation id rides
      // inside the signed token next to this video id, so releasing it costs the
      // caller the video it belongs to.
      await releaseStorageReservation(
        grant.reservationId,
        project.workspace.ownerId,
        UPLOAD_RESERVATION_PURPOSES.BUNNY
      );

      await cleanupBunnyStreamVideos(
        [{ providerId: 'bunny', videoId }],
        AbortSignal.timeout(10000)
      );
      return true;
    });
    if (!cleaned) return apiErrors.conflict('This upload has already been attached');

    const response = successResponse({ message: 'Pending upload cleaned up' });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error cleaning up pending Bunny upload:', error);
    return apiErrors.internalError('Failed to cleanup pending upload');
  }
}
