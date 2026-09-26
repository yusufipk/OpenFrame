import { visibleVideoWhere, checkFolderAccess } from '@/lib/content-access';
import { contentId, contentTransaction, ContentError } from '@/lib/content-mutations';
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
import { eventKey, recordEvent } from '@/lib/analytics/record';

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/videos - List all videos in a project
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    const { projectId } = await params;

    // Check project exists and user has access
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });

    if (!project) {
      return apiErrors.notFound('Project');
    }

    const folderId = contentId(request.nextUrl.searchParams.get('folderId'));
    const access = await checkFolderAccess(projectId, folderId, session?.user?.id);
    if (!access?.hasAccess) {
      return apiErrors.forbidden('Access denied');
    }

    const videos = await db.video.findMany({
      where: {
        projectId,
        AND: visibleVideoWhere(session?.user?.id),
        ...(request.nextUrl.searchParams.has('folderId') ? { folderId } : {}),
      },
      orderBy: { position: 'asc' },
      include: {
        versions: {
          where: { isActive: true },
          orderBy: { versionNumber: 'desc' },
          take: 1,
          select: {
            id: true,
            thumbnailUrl: true,
            duration: true,
            versionNumber: true,
            _count: { select: { comments: true } },
          },
        },
        _count: { select: { versions: true } },
      },
    });

    const response = successResponse({ videos });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error fetching videos:', error);
    return apiErrors.internalError('Failed to fetch videos');
  }
}

// POST /api/projects/[projectId]/videos - Add a new video to the project
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'create-video');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    // Check project access (must be owner, project admin, or workspace admin)
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        ownerId: true,
        workspaceId: true,
        visibility: true,
        // The billed account, which is who the Bunny reservation is held against.
        workspace: { select: { ownerId: true } },
      },
    });

    if (!project) {
      return apiErrors.notFound('Project');
    }

    const body = await request.json();
    const folderId = contentId(body.folderId);
    const access = await checkFolderAccess(projectId, folderId, session.user.id);
    if (!access?.canEdit) {
      return apiErrors.forbidden('Access denied');
    }

    const {
      title,
      description,
      videoUrl,
      providerId,
      videoId,
      thumbnailUrl,
      duration,
      uploadToken,
      objectKey,
    } = body;

    if (!title || !videoUrl) {
      return apiErrors.badRequest('Title and video URL are required');
    }

    const normalizedProviderIdEarly =
      typeof providerId === 'string' && providerId.trim()
        ? providerId.trim().toLowerCase()
        : 'youtube';

    if (normalizedProviderIdEarly === 'r2-image') {
      return apiErrors.badRequest('Use the image upload endpoint for image reviews');
    }

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
    const normalizedVideoId = typeof videoId === 'string' ? videoId.trim() : '';
    const normalizedUploadToken = typeof uploadToken === 'string' ? uploadToken.trim() : '';

    let versionSizeBytes = BigInt(0);
    let bunnyReservation: string | null = null;
    let finalizedR2Session: {
      sessionId: string;
      reservationId: string | null;
      billedUserId: string;
      thumbnailProxyUrl: string;
    } | null = null;

    if (normalizedProviderId === 'bunny') {
      if (!normalizedVideoId || !normalizedUploadToken) {
        return apiErrors.badRequest('Bunny uploads must include videoId and uploadToken');
      }

      const grant = readBunnyUploadGrant(normalizedUploadToken, {
        userId: session.user.id,
        projectId,
        videoId: normalizedVideoId,
      });
      if (!grant) {
        return apiErrors.forbidden('Invalid Bunny upload token');
      }

      if (grant.targetVideoId || grant.folderId !== folderId)
        return apiErrors.forbidden('Upload destination does not match its original folder');

      // See the versions route: Bunny reports no size at all until it has
      // finished encoding, so the size the upload was admitted on is what the
      // account is charged until a real figure arrives.
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

      const savedDestination = await db.videoUploadSession.findUnique({
        where: { id: finalizeResult.sessionId },
        select: { folderId: true, targetVideoId: true },
      });
      if (
        !savedDestination ||
        savedDestination.targetVideoId ||
        savedDestination.folderId !== folderId
      )
        return apiErrors.forbidden('Upload destination does not match its original folder');
      versionSizeBytes = finalizeResult.sizeBytes;
      finalizedR2Session = {
        sessionId: finalizeResult.sessionId,
        reservationId: finalizeResult.reservationId,
        billedUserId: finalizeResult.billedUserId,
        thumbnailProxyUrl: finalizeResult.thumbnailProxyUrl,
      };
    }

    const persistedVideoId =
      normalizedProviderId === 'r2'
        ? typeof objectKey === 'string'
          ? objectKey.trim()
          : ''
        : normalizedVideoId;

    // Get the next position
    const lastVideo = await db.video.findFirst({
      where: { projectId },
      orderBy: { position: 'desc' },
    });
    const nextPosition = (lastVideo?.position ?? -1) + 1;

    // Create video with initial version
    const video = await contentTransaction([projectId], async (tx) => {
      const currentAccess = await checkFolderAccess(projectId, folderId, session.user.id, tx);
      if (!currentAccess?.canEdit)
        throw new ContentError(403, 'Upload destination was removed or access was revoked');
      if (finalizedR2Session) {
        const consumed = await tx.videoUploadSession.updateMany({
          where: {
            id: finalizedR2Session.sessionId,
            status: 'INITIATED',
            userId: session.user.id,
            projectId,
            objectKey: persistedVideoId,
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

      // Released in the transaction that records the size, so the bytes are never
      // counted twice and never counted zero times.
      if (bunnyReservation) {
        await tx.uploadReservation.deleteMany({
          where: {
            id: bunnyReservation,
            billedUserId: project.workspace.ownerId,
            purpose: UPLOAD_RESERVATION_PURPOSES.BUNNY,
          },
        });
      }

      return tx.video.create({
        data: {
          title: title.trim(),
          description: description?.trim() || null,
          position: nextPosition,
          folderId,
          projectId,
          versions: {
            create: {
              versionNumber: 1,
              providerId: normalizedProviderId,
              videoId: persistedVideoId,
              originalUrl: videoUrl,
              title: title.trim(),
              thumbnailUrl:
                normalizedProviderId === 'r2'
                  ? (finalizedR2Session?.thumbnailProxyUrl ?? '/placeholder-video-thumbnail.png')
                  : thumbnailUrl || null,
              duration: duration || null,
              sizeBytes: versionSizeBytes,
              isActive: true,
            },
          },
        },
        include: {
          versions: true,
          _count: { select: { versions: true } },
        },
      });
    });

    // Notify project owner (fire-and-forget, skip if they added it themselves)
    if (project.ownerId !== session.user.id) {
      const baseUrl = process.env.NEXTAUTH_URL || '';
      notifyProjectOwner(project.ownerId, {
        type: 'new_video',
        projectName: project.name,
        videoTitle: title.trim(),
        addedBy: session.user.name || 'A team member',
        url: `${baseUrl}/watch/${video.id}`,
      }).catch((err) => logError('Notification failed:', err));
    }

    await recordEvent({
      name: 'VIDEO_ADDED',
      dedupeKey: eventKey('VIDEO_ADDED', video.id),
      userId: project.ownerId,
    });

    const response = successResponse(video, 201);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    if (error instanceof ContentError) return apiErrors.forbidden(error.message);
    logError('Error creating video:', error);
    return apiErrors.internalError('Failed to create video');
  }
}
