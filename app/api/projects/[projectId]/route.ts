import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { collectProjectMediaUrls, deleteMediaFilesBestEffort } from '@/lib/r2-cleanup';
import { cleanupBunnyStreamVideosBestEffort } from '@/lib/bunny-stream-cleanup';
import { buildCleanupWarnings, logCleanupWarnings } from '@/lib/cleanup-warnings';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId] - Get a single project
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    const { projectId } = await params;
    const MAX_LIMIT = 100;
    const MAX_OFFSET = 10000;

    // Parse pagination params
    const searchParams = request.nextUrl.searchParams;
    const limitParam = searchParams.get('limit');
    const offsetParam = searchParams.get('offset');

    const limitRaw = limitParam === null ? 20 : Number(limitParam);
    if (!Number.isSafeInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
      return apiErrors.badRequest('Invalid limit. Must be a positive integer between 1 and 100.');
    }

    const offset = offsetParam === null ? 0 : Number(offsetParam);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
      return apiErrors.badRequest('Invalid offset. Must be a non-negative integer up to 10000.');
    }

    const limit = limitRaw;

    const project = await db.project.findUnique({
      where: { id: projectId },
      include: {
        owner: { select: { id: true, name: true, image: true } },
        members: {
          include: {
            user: { select: { id: true, name: true, image: true } },
          },
        },
        videos: {
          orderBy: { position: 'asc' },
          skip: offset,
          take: limit,
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
        },
        _count: { select: { videos: true, members: true, shareLinks: true } },
      },
    });

    if (!project) {
      return apiErrors.notFound('Project');
    }

    const access = await checkProjectAccess(project, session?.user?.id);
    if (!access.hasAccess) {
      return apiErrors.forbidden('Access denied');
    }

    const response = successResponse(project);
    return withCacheControl(response, 'private, max-age=30, stale-while-revalidate=60');
  } catch (error) {
    logError('Error fetching project:', error);
    return apiErrors.internalError('Failed to fetch project');
  }
}

// PATCH /api/projects/[projectId] - Update a project
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const projectAccessTarget = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    const access = projectAccessTarget
      ? await checkProjectAccess(projectAccessTarget, session.user.id, { intent: 'manage' })
      : null;
    if (!access?.canEdit) {
      return apiErrors.forbidden('Access denied');
    }

    const body = await request.json();
    const { name, description, visibility } = body;

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return apiErrors.badRequest('Name must be a non-empty string');
      }
      if (name.trim().length > 100) {
        return apiErrors.badRequest('Name must be 100 characters or fewer');
      }
    }
    if (description !== undefined && description !== null) {
      if (typeof description !== 'string') {
        return apiErrors.badRequest('Description must be a string');
      }
      if (description.trim().length > 1000) {
        return apiErrors.badRequest('Description must be 1000 characters or fewer');
      }
    }

    const VALID_VISIBILITY = ['PRIVATE', 'INVITE', 'PUBLIC'] as const;
    if (visibility !== undefined && !VALID_VISIBILITY.includes(visibility)) {
      return apiErrors.badRequest('Invalid visibility value');
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name.trim();
    if (description !== undefined) updateData.description = description?.trim() || null;
    if (visibility !== undefined) updateData.visibility = visibility;

    const project = await db.project.update({
      where: { id: projectId },
      data: updateData,
      include: {
        owner: { select: { id: true, name: true, image: true } },
        _count: { select: { videos: true, members: true } },
      },
    });

    const response = successResponse(project);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error updating project:', error);
    return apiErrors.internalError('Failed to update project');
  }
}

// DELETE /api/projects/[projectId] - Delete a project
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
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    if (!project) {
      return apiErrors.notFound('Project');
    }

    const access = await checkProjectAccess(project, session.user.id, { intent: 'delete' });
    if (!access.canDelete) {
      return apiErrors.forbidden('Only the project owner can delete it');
    }

    const [projectVersionRefs, projectAssetRefs, mediaUrls] = await Promise.all([
      db.videoVersion.findMany({
        where: {
          video: { projectId },
        },
        select: {
          providerId: true,
          videoId: true,
        },
      }),
      db.videoAsset.findMany({
        where: {
          video: { projectId },
          provider: 'BUNNY',
          providerVideoId: { not: null },
        },
        select: {
          providerVideoId: true,
        },
      }),
      collectProjectMediaUrls(projectId),
    ]);

    const bunnyRefs = [
      ...projectVersionRefs,
      ...projectAssetRefs.map((asset) => ({
        providerId: 'bunny',
        videoId: asset.providerVideoId as string,
      })),
    ];

    await db.project.delete({ where: { id: projectId } });

    const [bunnyCleanupResult, r2CleanupResult] = await Promise.all([
      cleanupBunnyStreamVideosBestEffort(bunnyRefs),
      deleteMediaFilesBestEffort(mediaUrls),
    ]);

    const cleanupInput = {
      bunny: bunnyCleanupResult,
      r2: r2CleanupResult,
    };
    const cleanupWarnings = buildCleanupWarnings(cleanupInput);
    if (cleanupWarnings) {
      logCleanupWarnings({ entityType: 'project', entityId: projectId }, cleanupInput);
    }

    const response = successResponse({
      message: 'Project deleted',
      ...(cleanupWarnings ? { cleanupWarnings } : {}),
    });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error deleting project:', error);
    return apiErrors.internalError('Failed to delete project');
  }
}
