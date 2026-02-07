import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { WorkspaceMemberRole } from '@prisma/client';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

type RouteParams = { params: Promise<{ workspaceId: string; memberId: string }> };

// PATCH /api/workspaces/[workspaceId]/members/[memberId] - Update member role
export async function PATCH(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'manage-member');
        if (limited) return limited;

        const session = await auth();
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

        const isOwner = workspace.ownerId === session.user.id;
        const isAdmin = workspace.members[0]?.role === WorkspaceMemberRole.ADMIN;

        if (!isOwner && !isAdmin) {
            return apiErrors.forbidden('Access denied');
        }

        const body = await request.json();
        const { role } = body;

        const validRoles = ['ADMIN', 'COMMENTATOR'];
        if (!validRoles.includes(role)) {
            return apiErrors.badRequest('Invalid role. Must be ADMIN or COMMENTATOR.');
        }

        const member = await db.workspaceMember.update({
            where: { id: memberId },
            data: { role: role as WorkspaceMemberRole },
            include: {
                user: { select: { id: true, name: true, image: true } },
            },
        });

        const response = successResponse(member);
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error updating member role:', error);
        return apiErrors.internalError('Failed to update member role');
    }
}

// DELETE /api/workspaces/[workspaceId]/members/[memberId] - Remove member
export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'manage-member');
        if (limited) return limited;

        const session = await auth();
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

        const isOwner = workspace.ownerId === session.user.id;
        const isAdmin = workspace.members[0]?.role === WorkspaceMemberRole.ADMIN;

        // Users can remove themselves, admins/owners can remove anyone
        const memberToRemove = await db.workspaceMember.findUnique({
            where: { id: memberId },
        });

        if (!memberToRemove) {
            return apiErrors.notFound('Member');
        }

        const isSelf = memberToRemove.userId === session.user.id;

        if (!isOwner && !isAdmin && !isSelf) {
            return apiErrors.forbidden('Access denied');
        }

        await db.workspaceMember.delete({ where: { id: memberId } });

        const response = successResponse({ message: 'Member removed' });
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error removing member:', error);
        return apiErrors.internalError('Failed to remove member');
    }
}
