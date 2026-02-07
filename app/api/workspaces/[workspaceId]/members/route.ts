import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { WorkspaceMemberRole } from '@prisma/client';

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/[workspaceId]/members - List members
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { workspaceId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const workspace = await db.workspace.findUnique({
            where: { id: workspaceId },
            include: {
                members: { where: { userId: session.user.id } },
            },
        });

        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        const isOwner = workspace.ownerId === session.user.id;
        const isMember = workspace.members.length > 0;

        if (!isOwner && !isMember) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        const members = await db.workspaceMember.findMany({
            where: { workspaceId },
            include: {
                user: { select: { id: true, name: true, image: true } },
            },
            orderBy: { createdAt: 'asc' },
        });

        // Include the owner as well
        const owner = await db.user.findUnique({
            where: { id: workspace.ownerId },
            select: { id: true, name: true, image: true },
        });

        return NextResponse.json({ members, owner });
    } catch (error) {
        console.error('Error fetching workspace members:', error);
        return NextResponse.json(
            { error: 'Failed to fetch members' },
            { status: 500 }
        );
    }
}

// POST /api/workspaces/[workspaceId]/members - Invite a member
export async function POST(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { workspaceId } = await params;

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
            return NextResponse.json(
                { error: 'Only workspace owners and admins can invite members' },
                { status: 403 }
            );
        }

        const body = await request.json();
        const { email, role } = body;

        if (!email || typeof email !== 'string') {
            return NextResponse.json(
                { error: 'Email is required' },
                { status: 400 }
            );
        }

        // Validate role
        const validRoles = ['ADMIN', 'COMMENTATOR'];
        const memberRole = validRoles.includes(role) ? role : 'COMMENTATOR';

        // Find user by email
        const userToInvite = await db.user.findUnique({
            where: { email: email.toLowerCase().trim() },
        });

        if (!userToInvite) {
            return NextResponse.json(
                { message: 'If the user exists, an invitation has been sent.' },
                { status: 200 }
            );
        }

        if (userToInvite.id === workspace.ownerId) {
            return NextResponse.json(
                { error: 'Cannot invite the workspace owner as a member' },
                { status: 400 }
            );
        }

        // Check if already a member
        const existingMember = await db.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId, userId: userToInvite.id } },
        });

        if (existingMember) {
            return NextResponse.json(
                { error: 'User is already a member of this workspace' },
                { status: 409 }
            );
        }

        const member = await db.workspaceMember.create({
            data: {
                workspaceId,
                userId: userToInvite.id,
                role: memberRole as WorkspaceMemberRole,
            },
            include: {
                user: { select: { id: true, name: true, image: true } },
            },
        });

        return NextResponse.json(member, { status: 201 });
    } catch (error) {
        console.error('Error inviting workspace member:', error);
        return NextResponse.json(
            { error: 'Failed to invite member' },
            { status: 500 }
        );
    }
}
