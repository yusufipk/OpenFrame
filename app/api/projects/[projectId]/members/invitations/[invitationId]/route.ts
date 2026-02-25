import { NextRequest } from 'next/server';
import { InvitationStatus, ProjectMemberRole } from '@prisma/client';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

type RouteParams = { params: Promise<{ projectId: string; invitationId: string }> };

// DELETE /api/projects/[projectId]/members/invitations/[invitationId] - Cancel a pending invitation
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'manage-member');
    if (limited) return limited;

    const session = await auth();
    const { projectId, invitationId } = await params;

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

    const isOwner = project.ownerId === session.user.id;
    const isAdmin = project.members[0]?.role === ProjectMemberRole.ADMIN;

    if (!isOwner && !isAdmin) {
      return apiErrors.forbidden('Only project owners and admins can cancel invitations');
    }

    const invitation = await db.invitation.findFirst({
      where: {
        id: invitationId,
        projectId,
        scope: 'PROJECT',
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
    console.error('Error canceling project invitation:', error);
    return apiErrors.internalError('Failed to cancel invitation');
  }
}
