import { contentTransaction, ContentError } from '@/lib/content-mutations';
import { visibleVideoWhere } from '@/lib/content-access';
import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { db } from '@/lib/db';
import { logCleanupWarnings } from '@/lib/cleanup-warnings';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { deleteProjectVideosWithCleanup, VideoStorageCleanupError } from '@/lib/video-delete';

type RouteParams = { params: Promise<{ projectId: string }> };

const MAX_BULK_DELETE = 50;

// POST /api/projects/[projectId]/videos/bulk-delete
export async function POST(request: NextRequest, { params }: RouteParams) {
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
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    if (!project) {
      return apiErrors.notFound('Project');
    }

    const body = await request.json();
    const { videoIds } = body as { videoIds?: unknown };

    if (!Array.isArray(videoIds) || videoIds.length === 0) {
      return apiErrors.badRequest('videoIds must be a non-empty array');
    }
    if (videoIds.length > MAX_BULK_DELETE) {
      return apiErrors.badRequest(`You can delete at most ${MAX_BULK_DELETE} videos at once`);
    }
    if (!videoIds.every((id) => typeof id === 'string' && id.trim().length > 0)) {
      return apiErrors.badRequest('Each video id must be a non-empty string');
    }

    const normalizedIds = [...new Set(videoIds.map((id) => id.trim()))];

    const allowed = await db.video.count({
      where: {
        projectId,
        id: { in: normalizedIds },
        AND: visibleVideoWhere(session.user.id, true),
      },
    });
    if (allowed !== normalizedIds.length)
      return apiErrors.forbidden('One or more videos cannot be deleted');
    let result;
    try {
      result = await contentTransaction(
        [projectId],
        async (tx) => {
          const permitted = await tx.video.count({
            where: {
              projectId,
              id: { in: normalizedIds },
              AND: visibleVideoWhere(session.user.id, true),
            },
          });
          if (permitted !== normalizedIds.length) throw new ContentError(403, 'Access changed');
          // Allow slow batches beyond the ordinary mutation budget, while aborting
          // and draining all storage workers before the transaction can expire.
          return deleteProjectVideosWithCleanup(
            projectId,
            normalizedIds,
            tx,
            AbortSignal.timeout(60000)
          );
        },
        120000
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'VIDEO_NOT_FOUND') {
        return apiErrors.badRequest('One or more selected videos do not belong to this project');
      }
      // Storage refused a delete, so nothing was removed and the videos are still there.
      // Saying so lets the caller retry, which is the whole point of leaving the rows.
      if (error instanceof VideoStorageCleanupError) {
        logCleanupWarnings(
          { entityType: 'video', entityId: `bulk:${normalizedIds.join(',')}` },
          error.cleanupInput
        );
        return apiErrors.internalError(
          'Could not delete all stored media. Video records remain so you can retry.'
        );
      }
      throw error;
    }

    if (result.cleanupWarnings) {
      logCleanupWarnings(
        { entityType: 'video', entityId: `bulk:${normalizedIds.join(',')}` },
        result.cleanupInput
      );
    }

    const response = successResponse({
      message: `${result.deletedCount} video${result.deletedCount === 1 ? '' : 's'} deleted`,
      deletedCount: result.deletedCount,
      ...(result.cleanupWarnings ? { cleanupWarnings: result.cleanupWarnings } : {}),
    });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    if (error instanceof ContentError) return apiErrors.forbidden(error.message);
    logError('Error bulk deleting videos:', error);
    return apiErrors.internalError('Failed to delete selected videos');
  }
}
