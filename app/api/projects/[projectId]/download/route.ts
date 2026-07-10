import { NextRequest } from 'next/server';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { db } from '@/lib/db';
import { logError } from '@/lib/logger';
import {
  buildProjectDownloadManifest,
  canDownloadProjectMedia,
  parseRequestedVideoIds,
  validateProjectDownloadManifest,
} from '@/lib/project-download';
import { rateLimit } from '@/lib/rate-limit';

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/download
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'project-download');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;
    const requestedVideoIds = parseRequestedVideoIds(request.nextUrl.searchParams.get('videoIds'));
    const includeAllVersions = request.nextUrl.searchParams.get('versions') === 'all';

    if (requestedVideoIds && requestedVideoIds.length === 0) {
      return apiErrors.badRequest('At least one video must be selected for download');
    }

    const project = await db.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        ownerId: true,
        workspaceId: true,
        visibility: true,
        allowDownloads: true,
      },
    });

    if (!project) {
      return apiErrors.notFound('Project');
    }

    const access = await checkProjectAccess(project, session?.user?.id);
    if (!canDownloadProjectMedia(project, access)) {
      return apiErrors.forbidden('Project downloads are disabled for viewers');
    }

    const videos = await db.video.findMany({
      where: {
        projectId,
        ...(requestedVideoIds ? { id: { in: requestedVideoIds } } : {}),
      },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        title: true,
        position: true,
        versions: {
          orderBy: { versionNumber: 'asc' },
          select: {
            id: true,
            versionNumber: true,
            versionLabel: true,
            providerId: true,
            videoId: true,
            originalUrl: true,
            sizeBytes: true,
          },
        },
        assets: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            provider: true,
            displayName: true,
            sourceUrl: true,
            providerVideoId: true,
            sizeBytes: true,
          },
        },
      },
    });

    if (requestedVideoIds) {
      const foundIds = new Set(videos.map((video) => video.id));
      const missing = requestedVideoIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        return apiErrors.badRequest('One or more selected videos do not belong to this project');
      }
    }

    const manifest = buildProjectDownloadManifest(project.name, videos, { includeAllVersions });
    const validationError = validateProjectDownloadManifest(manifest);
    if (validationError) {
      return apiErrors.badRequest(validationError);
    }

    const response = successResponse(manifest);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error creating project download manifest:', error);
    return apiErrors.internalError('Failed to prepare project download');
  }
}
