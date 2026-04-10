import { NextRequest } from 'next/server';
import { InvitationStatus, WorkspaceMemberRole } from '@prisma/client';
import { auth, checkWorkspaceAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ workspaceId: string; invitationId: string }> };

// DELETE /api/workspaces/[workspaceId]/members/invitations/[invitationId] - Cancel a pending invitation
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'manage-member');
    if (limited) return limited;

    const session = await auth();
    const { workspaceId, invitationId } = await params;

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

    if (!access.canEdit || (!isOwner && !isAdmin)) {
      return apiErrors.forbidden('Only workspace owners and admins can cancel invitations');
    }

    const invitation = await db.invitation.findFirst({
      where: {
        id: invitationId,
        workspaceId,
        scope: 'WORKSPACE',
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (!invitation) {
      return apiErrors.notFound('Invitation');
    }

    if (invitation.status !== InvitationStatus.PENDING) {
      return apiErrors.conflict('Only pending invitations can be canceled');
    }

    await db.invitation.update({
      where: { id: invitation.id },
      data: { status: InvitationStatus.CANCELED },
    });

    const response = successResponse({ message: 'Invitation canceled' });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error canceling workspace invitation:', error);
    return apiErrors.internalError('Failed to cancel invitation');
  }
}
