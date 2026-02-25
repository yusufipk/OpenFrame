import { NextRequest } from 'next/server';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { getApprovalCandidatesForProject } from '@/lib/approval-workflow';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

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

    const access = await checkProjectAccess(project, session.user.id, { intent: 'manage' });
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const candidates = await getApprovalCandidatesForProject(projectId);
    if (!candidates) return apiErrors.notFound('Project');

    const response = successResponse({ candidates });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    console.error('Error fetching approval candidates:', error);
    return apiErrors.internalError('Failed to fetch approval candidates');
  }
}
