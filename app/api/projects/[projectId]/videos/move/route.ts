import { visibleVideoWhere } from '@/lib/content-access';
import { moveContentVideos, ContentError, contentId } from '@/lib/content-mutations';
import { NextRequest } from 'next/server';
import { revalidatePath } from 'next/cache';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { db } from '@/lib/db';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';

type RouteParams = { params: Promise<{ projectId: string }> };

const MAX_BULK_MOVE = 50;

// Thrown inside the move transaction when the atomic source-ownership re-check
// fails (a concurrent request relocated a video between check and commit).

// GET /api/projects/[projectId]/videos/move
// Lists destination projects (same workspace, manageable by the user) the
// current project's videos can be moved into.
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'api');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }
    const userId = session.user.id;

    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    if (!project) {
      return apiErrors.notFound('Project');
    }

    const access = await checkProjectAccess(project, userId);
    if (!access.canEdit) {
      const manageable = await db.video.count({
        where: { projectId, AND: visibleVideoWhere(userId, true) },
      });
      if (!manageable) return apiErrors.forbidden('Access denied');
      return withCacheControl(
        successResponse({ projects: [{ id: projectId, name: 'Current project' }] }),
        'private, no-store'
      );
    }

    // Workspace owners/admins can manage every project in the workspace; everyone
    // else can only move into projects they own or are an admin member of.
    const [workspace, workspaceMember] = await Promise.all([
      db.workspace.findUnique({
        where: { id: project.workspaceId },
        select: { ownerId: true },
      }),
      db.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
      }),
    ]);
    const isWorkspaceManager = workspace?.ownerId === userId || workspaceMember?.role === 'ADMIN';

    const targets = await db.project.findMany({
      where: {
        workspaceId: project.workspaceId,

        ...(isWorkspaceManager
          ? {}
          : {
              OR: [{ ownerId: userId }, { members: { some: { userId, role: 'ADMIN' } } }],
            }),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });

    const response = successResponse({ projects: targets });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error listing video move targets:', error);
    return apiErrors.internalError('Failed to load destination projects');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    const { projectId } = await params;
    const body = await request.json();
    if (
      !Array.isArray(body.videoIds) ||
      !body.videoIds.length ||
      body.videoIds.length > MAX_BULK_MOVE ||
      !body.videoIds.every((id: unknown) => typeof id === 'string' && id.trim())
    )
      return apiErrors.badRequest('Select 1 to 50 videos');
    if (typeof body.targetProjectId !== 'string' || !body.targetProjectId.trim())
      return apiErrors.badRequest('Destination required');
    const result = await moveContentVideos({
      projectId,
      targetProjectId: body.targetProjectId,
      folderId: contentId(body.folderId),
      videoIds: [...new Set<string>(body.videoIds)],
      userId: session.user.id,
      confirmationToken: body.confirmationToken,
    });
    revalidatePath(`/projects/${projectId}`);
    revalidatePath(`/projects/${body.targetProjectId}`);
    return withCacheControl(successResponse(result), 'private, no-store');
  } catch (error) {
    if (error instanceof ContentError)
      return error.status === 403
        ? apiErrors.forbidden(error.message)
        : error.status === 409
          ? apiErrors.conflict(error.message)
          : apiErrors.badRequest(error.message);
    logError('Error moving videos:', error);
    return apiErrors.internalError('Failed to move videos');
  }
}
