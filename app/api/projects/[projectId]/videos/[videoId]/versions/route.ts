import { contentTransaction, ContentError } from '@/lib/content-mutations';
import { checkVideoAccess } from '@/lib/content-access';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { validateUrl, validateOptionalUrlOrAppPath } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { notifyProjectOwner } from '@/lib/notifications';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { readBunnyUploadGrant } from '@/lib/bunny-upload-token';
import { finalizeR2VideoUpload } from '@/lib/r2-video-finalize';
import { UPLOAD_RESERVATION_PURPOSES } from '@/lib/storage-quota';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string; videoId: string }> };

// GET /api/projects/[projectId]/videos/[videoId]/versions
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    const { projectId, videoId } = await params;

    const video = await db.video.findFirst({
      where: { id: videoId, projectId },
      include: {
        project: true,
      },
    });

    if (!video) {
      return apiErrors.notFound('Video');
    }

    const access = await checkVideoAccess(video.id, session?.user?.id);
    if (!access.hasAccess) {
      return apiErrors.forbidden('Access denied');
    }

    const versions = await db.videoVersion.findMany({
      where: { videoParentId: videoId },
      orderBy: { versionNumber: 'desc' },
      include: {
        _count: { select: { comments: true } },
      },
    });

    const response = successResponse({ versions });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error fetching versions:', error);
    return apiErrors.internalError('Failed to fetch versions');
  }
}

// POST /api/projects/[projectId]/videos/[videoId]/versions - Add a new version
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'create-version');
    if (limited) return limited;

    const session = await auth();
    const { projectId, videoId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const video = await db.video.findFirst({
      where: { id: videoId, projectId },
      include: {
        // The workspace owner comes along because they are the account the
        // upload is billed to, and the Bunny reservation released below is held
        // against them rather than against whoever is adding the version.
        project: { include: { workspace: { select: { ownerId: true } } } },
        versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
      },
    });

    if (!video) {
      return apiErrors.notFound('Video');
    }

    const access = await checkVideoAccess(video.id, session.user.id);
    if (!access.canEdit) {
      return apiErrors.forbidden('Access denied');
    }

    const body = await request.json();
    const {
      videoUrl,
      providerId,
      providerVideoId,
      versionLabel,
      thumbnailUrl,
      duration,
      setActive,
      uploadToken,
      objectKey,
    } = body;

    if (!videoUrl) {
      return apiErrors.badRequest('Video URL is required');
    }

    if (versionLabel !== undefined && versionLabel !== null) {
      if (typeof versionLabel !== 'string') {
        return apiErrors.badRequest('Version label must be a string');
      }
      if (versionLabel.trim().length > 100) {
        return apiErrors.badRequest('Version label must be 100 characters or fewer');
      }
    }

    const normalizedProviderIdEarly =
      typeof providerId === 'string' && providerId.trim()
        ? providerId.trim().toLowerCase()
        : 'youtube';

    if (normalizedProviderIdEarly === 'r2') {
      if (!videoUrl.startsWith('/api/upload/video/')) {
        return apiErrors.badRequest('Video URL must be a valid upload path');
      }
    } else {
      const videoUrlError = validateUrl(videoUrl, 'Video URL');
      if (videoUrlError) {
        return apiErrors.badRequest(videoUrlError);
      }
    }

    const thumbnailUrlError = validateOptionalUrlOrAppPath(thumbnailUrl, 'Thumbnail URL');
    if (thumbnailUrlError) {
      return apiErrors.badRequest(thumbnailUrlError);
    }

    const normalizedProviderId =
      typeof providerId === 'string' && providerId.trim()
        ? providerId.trim().toLowerCase()
        : 'youtube';
    const normalizedProviderVideoId =
      typeof providerVideoId === 'string' ? providerVideoId.trim() : '';
    const normalizedUploadToken = typeof uploadToken === 'string' ? uploadToken.trim() : '';

    let versionSizeBytes = BigInt(0);
    let bunnyReservation: string | null = null;
    let persistedProviderVideoId = normalizedProviderVideoId;
    let finalizedR2Session: {
      sessionId: string;
      reservationId: string | null;
      billedUserId: string;
      thumbnailProxyUrl: string;
    } | null = null;

    if (normalizedProviderId === 'bunny') {
      if (!normalizedProviderVideoId || !normalizedUploadToken) {
        return apiErrors.badRequest('Bunny uploads must include providerVideoId and uploadToken');
      }

      const grant = readBunnyUploadGrant(normalizedUploadToken, {
        userId: session.user.id,
        projectId,
        videoId: normalizedProviderVideoId,
      });
      if (!grant) {
        return apiErrors.forbidden('Invalid Bunny upload token');
      }

      // The size the upload was admitted on, written down here so the account is
      // charged for it from this moment. Bunny reports nothing at all until it
      // has finished encoding, which for a half-hour video is the better part of
      // an hour, and until this row existed those bytes were simply invisible:
      // the uploader's own storage page read zero and the next upload was
      // measured against a total that ignored the one before it.
      if (grant.targetVideoId && grant.targetVideoId !== videoId)
        return apiErrors.forbidden('Upload belongs to another video');
      versionSizeBytes = grant.declaredSizeBytes ?? BigInt(0);
      bunnyReservation = grant.reservationId;
    } else if (normalizedProviderId === 'r2') {
      const normalizedObjectKey = typeof objectKey === 'string' ? objectKey.trim() : '';
      if (!normalizedObjectKey || !normalizedUploadToken) {
        return apiErrors.badRequest('R2 uploads must include objectKey and uploadToken');
      }

      const finalizeResult = await finalizeR2VideoUpload({
        userId: session.user.id,
        projectId,
        videoUrl,
        objectKey: normalizedObjectKey,
        uploadToken: normalizedUploadToken,
      });
      if (!finalizeResult.ok) {
        if (finalizeResult.status === 403) {
          return apiErrors.forbidden(finalizeResult.error);
        }
        return apiErrors.badRequest(finalizeResult.error);
      }

      const savedTarget = await db.videoUploadSession.findUnique({
        where: { id: finalizeResult.sessionId },
        select: { targetVideoId: true },
      });
      if (savedTarget?.targetVideoId && savedTarget.targetVideoId !== videoId)
        return apiErrors.forbidden('Upload belongs to another video');
      versionSizeBytes = finalizeResult.sizeBytes;
      persistedProviderVideoId = normalizedObjectKey;
      finalizedR2Session = {
        sessionId: finalizeResult.sessionId,
        reservationId: finalizeResult.reservationId,
        billedUserId: finalizeResult.billedUserId,
        thumbnailProxyUrl: finalizeResult.thumbnailProxyUrl,
      };
    }

    const nextVersionNumber = (video.versions[0]?.versionNumber || 0) + 1;

    // Use transaction to handle active flag
    const version = await contentTransaction([projectId], async (tx) => {
      const current = await checkVideoAccess(videoId, session.user.id, tx);
      if (!current.canEdit || current.video?.projectId !== projectId)
        throw new ContentError(403, 'Video access changed during upload');
      // If setActive, deactivate all other versions
      if (setActive) {
        await tx.videoVersion.updateMany({
          where: { videoParentId: videoId },
          data: { isActive: false },
        });
      }

      if (finalizedR2Session) {
        const consumed = await tx.videoUploadSession.updateMany({
          where: {
            id: finalizedR2Session.sessionId,
            status: 'INITIATED',
            userId: session.user.id,
            projectId,
            objectKey: persistedProviderVideoId,
          },
          data: {
            status: 'FINALIZED',
            consumedAt: new Date(),
          },
        });
        if (consumed.count !== 1) {
          throw new Error('Upload session already consumed');
        }
        if (finalizedR2Session.reservationId) {
          await tx.uploadReservation.deleteMany({
            where: {
              id: finalizedR2Session.reservationId,
              billedUserId: finalizedR2Session.billedUserId,
              purpose: UPLOAD_RESERVATION_PURPOSES.R2_VIDEO,
            },
          });
        }
      }

      // Handed over in the same transaction that records the size, so the bytes
      // are never counted twice and never counted zero times.
      if (bunnyReservation) {
        await tx.uploadReservation.deleteMany({
          where: {
            id: bunnyReservation,
            billedUserId: video.project.workspace.ownerId,
            purpose: UPLOAD_RESERVATION_PURPOSES.BUNNY,
          },
        });
      }

      return tx.videoVersion.create({
        data: {
          versionNumber: nextVersionNumber,
          versionLabel: versionLabel?.trim() || null,
          providerId: normalizedProviderId,
          videoId: persistedProviderVideoId,
          originalUrl: videoUrl,
          title: versionLabel?.trim() || `Version ${nextVersionNumber}`,
          thumbnailUrl:
            normalizedProviderId === 'r2'
              ? (finalizedR2Session?.thumbnailProxyUrl ?? '/placeholder-video-thumbnail.png')
              : thumbnailUrl || null,
          duration: duration || null,
          sizeBytes: versionSizeBytes,
          isActive: setActive ?? false,
          videoParentId: videoId,
        },
        include: {
          _count: { select: { comments: true } },
        },
      });
    });

    // Notify project owner (fire-and-forget, skip if they added it themselves)
    if (video.project.ownerId !== session.user.id) {
      const baseUrl = process.env.NEXTAUTH_URL || '';
      notifyProjectOwner(video.project.ownerId, {
        type: 'new_version',
        projectName: video.project.name,
        videoTitle: video.title,
        versionLabel: version.versionLabel || `Version ${version.versionNumber}`,
        addedBy: session.user.name || 'A team member',
        url: `${baseUrl}/watch/${video.id}`,
      }).catch((err) => logError('Notification failed:', err));
    }

    const response = successResponse(version, 201);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    if (error instanceof ContentError) return apiErrors.forbidden(error.message);
    logError('Error creating version:', error);
    return apiErrors.internalError('Failed to create version');
  }
}
