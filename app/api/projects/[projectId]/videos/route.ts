import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { validateUrl, validateOptionalUrlOrAppPath } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { notifyProjectOwner } from '@/lib/notifications';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { verifyBunnyUploadToken } from '@/lib/bunny-upload-token';
import { finalizeR2VideoUpload } from '@/lib/r2-video-finalize';
import { logError } from '@/lib/logger';

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

    const access = await checkProjectAccess(project, session?.user?.id);
    if (!access.hasAccess) {
      return apiErrors.forbidden('Access denied');
    }

    const videos = await db.video.findMany({
      where: { projectId },
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
    return withCacheControl(response, 'private, max-age=30, stale-while-revalidate=60');
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
      select: { id: true, name: true, ownerId: true, workspaceId: true, visibility: true },
    });

    if (!project) {
      return apiErrors.notFound('Project');
    }

    const access = await checkProjectAccess(project, session.user.id, { intent: 'manage' });
    if (!access.canEdit) {
      return apiErrors.forbidden('Access denied');
    }

    const body = await request.json();
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

      const isValidUploadToken = verifyBunnyUploadToken(normalizedUploadToken, {
        userId: session.user.id,
        projectId,
        videoId: normalizedVideoId,
      });
      if (!isValidUploadToken) {
        return apiErrors.forbidden('Invalid Bunny upload token');
      }
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
    const video = await db.$transaction(async (tx) => {
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
            },
          });
        }
      }

      return tx.video.create({
        data: {
          title: title.trim(),
          description: description?.trim() || null,
          position: nextPosition,
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

    const response = successResponse(video, 201);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error creating video:', error);
    return apiErrors.internalError('Failed to create video');
  }
}
