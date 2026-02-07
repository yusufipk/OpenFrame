import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProjectMemberRole } from '@prisma/client';

type RouteParams = { params: Promise<{ projectId: string; memberId: string }> };

// PATCH /api/projects/[projectId]/members/[memberId] - Update member role
export async function PATCH(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId, memberId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const project = await db.project.findUnique({
            where: { id: projectId },
            include: { members: { where: { userId: session.user.id } } },
        });

        if (!project) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }

        const isOwner = project.ownerId === session.user.id;
        const isAdmin = project.members[0]?.role === ProjectMemberRole.ADMIN;

        if (!isOwner && !isAdmin) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        const body = await request.json();
        const { role } = body;

        const validRoles = ['ADMIN', 'COMMENTATOR'];
        if (!validRoles.includes(role)) {
            return NextResponse.json(
                { error: 'Invalid role. Must be ADMIN or COMMENTATOR.' },
                { status: 400 }
            );
        }

        const member = await db.projectMember.update({
            where: { id: memberId },
            data: { role: role as ProjectMemberRole },
            include: {
                user: { select: { id: true, name: true, image: true } },
            },
        });

        return NextResponse.json(member);
    } catch (error) {
        console.error('Error updating member role:', error);
        return NextResponse.json(
            { error: 'Failed to update member role' },
            { status: 500 }
        );
    }
}

// DELETE /api/projects/[projectId]/members/[memberId] - Remove member
export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId, memberId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const project = await db.project.findUnique({
            where: { id: projectId },
            include: { members: { where: { userId: session.user.id } } },
        });

        if (!project) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }

        const isOwner = project.ownerId === session.user.id;
        const isAdmin = project.members[0]?.role === ProjectMemberRole.ADMIN;

        const memberToRemove = await db.projectMember.findUnique({
            where: { id: memberId },
        });

        if (!memberToRemove) {
            return NextResponse.json({ error: 'Member not found' }, { status: 404 });
        }

        const isSelf = memberToRemove.userId === session.user.id;

        if (!isOwner && !isAdmin && !isSelf) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        await db.projectMember.delete({ where: { id: memberId } });

        return NextResponse.json({ success: true, message: 'Member removed' });
    } catch (error) {
        console.error('Error removing member:', error);
        return NextResponse.json(
            { error: 'Failed to remove member' },
            { status: 500 }
        );
    }
}
