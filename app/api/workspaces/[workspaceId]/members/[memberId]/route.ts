import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { WorkspaceMemberRole } from '@prisma/client';

type RouteParams = { params: Promise<{ workspaceId: string; memberId: string }> };

// PATCH /api/workspaces/[workspaceId]/members/[memberId] - Update member role
export async function PATCH(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { workspaceId, memberId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Check if user is owner or admin
        const workspace = await db.workspace.findUnique({
            where: { id: workspaceId },
            include: { members: { where: { userId: session.user.id } } },
        });

        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        const isOwner = workspace.ownerId === session.user.id;
        const isAdmin = workspace.members[0]?.role === WorkspaceMemberRole.ADMIN;

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

        const member = await db.workspaceMember.update({
            where: { id: memberId },
            data: { role: role as WorkspaceMemberRole },
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

// DELETE /api/workspaces/[workspaceId]/members/[memberId] - Remove member
export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { workspaceId, memberId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const workspace = await db.workspace.findUnique({
            where: { id: workspaceId },
            include: { members: { where: { userId: session.user.id } } },
        });

        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        const isOwner = workspace.ownerId === session.user.id;
        const isAdmin = workspace.members[0]?.role === WorkspaceMemberRole.ADMIN;

        // Users can remove themselves, admins/owners can remove anyone
        const memberToRemove = await db.workspaceMember.findUnique({
            where: { id: memberId },
        });

        if (!memberToRemove) {
            return NextResponse.json({ error: 'Member not found' }, { status: 404 });
        }

        const isSelf = memberToRemove.userId === session.user.id;

        if (!isOwner && !isAdmin && !isSelf) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        await db.workspaceMember.delete({ where: { id: memberId } });

        return NextResponse.json({ success: true, message: 'Member removed' });
    } catch (error) {
        console.error('Error removing member:', error);
        return NextResponse.json(
            { error: 'Failed to remove member' },
            { status: 500 }
        );
    }
}
