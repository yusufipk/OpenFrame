import { getSession, withApiToken } from '@/lib/api-tokens';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth';
import { ProjectMemberRole } from '@prisma/client';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { checkEditorAddition, editorLimitResponse, getWorkspaceOwnerId } from '@/lib/editor-limit';

type RouteParams = { params: Promise<{ projectId: string; memberId: string }> };

// PATCH /api/projects/[projectId]/members/[memberId] - Update member role
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'manage-member');
    if (limited) return limited;

    const session = await getSession();
    const { projectId, memberId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const project = await db.project.findUnique({
      where: { id: projectId },
      include: { members: { where: { userId: session.user.id } } },
    });

    if (!project) {
      return apiErrors.notFound('Project');
    }

    const access = await checkProjectAccess(project, session.user.id);
    const isOwner = project.ownerId === session.user.id;
    const isAdmin = project.members[0]?.role === ProjectMemberRole.ADMIN;

    if (!access.canEdit || (!isOwner && !isAdmin)) {
      return apiErrors.forbidden('Access denied');
    }

    const body = await request.json();
    const { role } = body;

    const validRoles = ['ADMIN', 'COMMENTATOR'];
    if (!validRoles.includes(role)) {
      return apiErrors.badRequest('Invalid role. Must be ADMIN or COMMENTATOR.');
    }

    const member = await db.projectMember.findFirst({
      where: { id: memberId, projectId },
      select: { id: true, userId: true },
    });

    if (!member) {
      return apiErrors.notFound('Member');
    }

    if (role === ProjectMemberRole.ADMIN) {
      const ownerId = await getWorkspaceOwnerId({ projectId });
      if (ownerId) {
        const allowed = await checkEditorAddition({
          ownerId,
          actorUserId: session.user.id,
          candidate: { userId: member.userId },
        });
        if (!allowed.ok) return editorLimitResponse(allowed);
      }
    }

    const updatedMember = await db.projectMember.update({
      where: { id: member.id },
      data: { role: role as ProjectMemberRole },
      include: {
        user: { select: { id: true, name: true, image: true } },
      },
    });

    const response = successResponse(updatedMember);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error updating member role:', error);
    return apiErrors.internalError('Failed to update member role');
  }
}

// DELETE /api/projects/[projectId]/members/[memberId] - Remove member
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'manage-member');
    if (limited) return limited;

    const session = await getSession();
    const { projectId, memberId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const project = await db.project.findUnique({
      where: { id: projectId },
      include: { members: { where: { userId: session.user.id } } },
    });

    if (!project) {
      return apiErrors.notFound('Project');
    }

    const access = await checkProjectAccess(project, session.user.id);
    const isOwner = project.ownerId === session.user.id;
    const isAdmin = project.members[0]?.role === ProjectMemberRole.ADMIN;

    const memberToRemove = await db.projectMember.findFirst({
      where: { id: memberId, projectId },
      select: { id: true, userId: true },
    });

    if (!memberToRemove) {
      return apiErrors.notFound('Member');
    }

    const isSelf = memberToRemove.userId === session.user.id;

    if ((!access.canEdit || (!isOwner && !isAdmin)) && !isSelf) {
      return apiErrors.forbidden('Access denied');
    }

    await db.projectMember.delete({ where: { id: memberToRemove.id } });

    const response = successResponse({ message: 'Member removed' });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error removing member:', error);
    return apiErrors.internalError('Failed to remove member');
  }
}

export const PATCH = withApiToken('share', handlePatch);
export const DELETE = withApiToken('share', handleDelete);
