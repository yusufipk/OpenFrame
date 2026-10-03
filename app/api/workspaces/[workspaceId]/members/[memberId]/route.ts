import { getSession, withApiToken } from '@/lib/api-tokens';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { checkWorkspaceAccess } from '@/lib/auth';
import { WorkspaceMemberRole } from '@prisma/client';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { checkEditorAddition, editorLimitResponse } from '@/lib/editor-limit';

type RouteParams = { params: Promise<{ workspaceId: string; memberId: string }> };

// PATCH /api/workspaces/[workspaceId]/members/[memberId] - Update member role
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'manage-member');
    if (limited) return limited;

    const session = await getSession();
    const { workspaceId, memberId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    // Check if user is owner or admin
    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      include: { members: { where: { userId: session.user.id } } },
    });

    if (!workspace) {
      return apiErrors.notFound('Workspace');
    }

    const access = await checkWorkspaceAccess(
      { id: workspace.id, ownerId: workspace.ownerId },
      session.user.id
    );
    const isOwner = workspace.ownerId === session.user.id;
    const isAdmin = workspace.members[0]?.role === WorkspaceMemberRole.ADMIN;

    if (!access.canEdit || (!isOwner && !isAdmin)) {
      return apiErrors.forbidden('Access denied');
    }

    const body = await request.json();
    const { role } = body;

    const validRoles = ['ADMIN', 'COMMENTATOR'];
    if (!validRoles.includes(role)) {
      return apiErrors.badRequest('Invalid role. Must be ADMIN or COMMENTATOR.');
    }

    const member = await db.workspaceMember.findFirst({
      where: { id: memberId, workspaceId },
      select: { id: true, userId: true },
    });

    if (!member) {
      return apiErrors.notFound('Member');
    }

    if (role === WorkspaceMemberRole.ADMIN) {
      const allowed = await checkEditorAddition({
        ownerId: workspace.ownerId,
        actorUserId: session.user.id,
        candidate: { userId: member.userId },
      });
      if (!allowed.ok) return editorLimitResponse(allowed);
    }

    const updatedMember = await db.workspaceMember.update({
      where: { id: member.id },
      data: { role: role as WorkspaceMemberRole },
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

// DELETE /api/workspaces/[workspaceId]/members/[memberId] - Remove member
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'manage-member');
    if (limited) return limited;

    const session = await getSession();
    const { workspaceId, memberId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      include: { members: { where: { userId: session.user.id } } },
    });

    if (!workspace) {
      return apiErrors.notFound('Workspace');
    }

    const access = await checkWorkspaceAccess(
      { id: workspace.id, ownerId: workspace.ownerId },
      session.user.id
    );
    const isOwner = workspace.ownerId === session.user.id;
    const isAdmin = workspace.members[0]?.role === WorkspaceMemberRole.ADMIN;

    // Users can remove themselves, admins/owners can remove anyone
    const memberToRemove = await db.workspaceMember.findFirst({
      where: { id: memberId, workspaceId },
      select: { id: true, userId: true },
    });

    if (!memberToRemove) {
      return apiErrors.notFound('Member');
    }

    const isSelf = memberToRemove.userId === session.user.id;

    if ((!access.canEdit || (!isOwner && !isAdmin)) && !isSelf) {
      return apiErrors.forbidden('Access denied');
    }

    await db.$transaction(async (tx) => {
      await tx.projectMember.deleteMany({
        where: {
          userId: memberToRemove.userId,
          project: {
            workspaceId,
          },
        },
      });

      await tx.project.updateMany({
        where: {
          workspaceId,
          ownerId: memberToRemove.userId,
        },
        data: {
          ownerId: workspace.ownerId,
        },
      });

      await tx.workspaceMember.delete({ where: { id: memberToRemove.id } });
    });

    const response = successResponse({ message: 'Member removed' });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error removing member:', error);
    return apiErrors.internalError('Failed to remove member');
  }
}

export const PATCH = withApiToken('share', handlePatch);
export const DELETE = withApiToken('share', handleDelete);
