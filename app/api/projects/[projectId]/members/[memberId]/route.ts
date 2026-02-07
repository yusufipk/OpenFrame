import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProjectMemberRole } from '@prisma/client';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

type RouteParams = { params: Promise<{ projectId: string; memberId: string }> };

// PATCH /api/projects/[projectId]/members/[memberId] - Update member role
export async function PATCH(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'manage-member');
        if (limited) return limited;

        const session = await auth();
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

        const isOwner = project.ownerId === session.user.id;
        const isAdmin = project.members[0]?.role === ProjectMemberRole.ADMIN;

        if (!isOwner && !isAdmin) {
            return apiErrors.forbidden('Access denied');
        }

        const body = await request.json();
        const { role } = body;

        const validRoles = ['ADMIN', 'COMMENTATOR'];
        if (!validRoles.includes(role)) {
            return apiErrors.badRequest('Invalid role. Must be ADMIN or COMMENTATOR.');
        }

        const member = await db.projectMember.update({
            where: { id: memberId },
            data: { role: role as ProjectMemberRole },
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

// DELETE /api/projects/[projectId]/members/[memberId] - Remove member
export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'manage-member');
        if (limited) return limited;

        const session = await auth();
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

        const isOwner = project.ownerId === session.user.id;
        const isAdmin = project.members[0]?.role === ProjectMemberRole.ADMIN;

        const memberToRemove = await db.projectMember.findUnique({
            where: { id: memberId },
        });

        if (!memberToRemove) {
            return apiErrors.notFound('Member');
        }

        const isSelf = memberToRemove.userId === session.user.id;

        if (!isOwner && !isAdmin && !isSelf) {
            return apiErrors.forbidden('Access denied');
        }

        await db.projectMember.delete({ where: { id: memberId } });

        const response = successResponse({ message: 'Member removed' });
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error removing member:', error);
        return apiErrors.internalError('Failed to remove member');
    }
}
