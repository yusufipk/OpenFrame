import { checkVideoAccess } from '@/lib/content-access';
import { NextRequest } from 'next/server';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { getApprovalCandidatesForProject } from '@/lib/approval-workflow';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/approval-candidates
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { projectId } = await params;
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    if (!project) return apiErrors.notFound('Project');

    const versionId = _request.nextUrl.searchParams.get('versionId');
    const version = versionId
      ? await db.videoVersion.findFirst({
          where: { id: versionId, video: { projectId } },
          select: { videoParentId: true },
        })
      : null;
    if (versionId && !version) return apiErrors.notFound('Version');
    const access = version
      ? await checkVideoAccess(version.videoParentId, session.user.id)
      : await checkProjectAccess(project, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const candidates = await getApprovalCandidatesForProject(projectId, version?.videoParentId);
    if (!candidates) return apiErrors.notFound('Project');

    const response = successResponse({ candidates });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error fetching approval candidates:', error);
    return apiErrors.internalError('Failed to fetch approval candidates');
  }
}
