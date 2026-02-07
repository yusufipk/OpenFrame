import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProjectMemberRole } from '@prisma/client';

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/members - List members
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const project = await db.project.findUnique({
            where: { id: projectId },
            include: {
                members: { where: { userId: session.user.id } },
            },
        });

        if (!project) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }

        const isOwner = project.ownerId === session.user.id;
        const isMember = project.members.length > 0;

        if (!isOwner && !isMember) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        const members = await db.projectMember.findMany({
            where: { projectId },
            include: {
                user: { select: { id: true, name: true, image: true } },
            },
            orderBy: { createdAt: 'asc' },
        });

        const owner = await db.user.findUnique({
            where: { id: project.ownerId },
            select: { id: true, name: true, image: true },
        });

        return NextResponse.json({ members, owner });
    } catch (error) {
        console.error('Error fetching project members:', error);
        return NextResponse.json(
            { error: 'Failed to fetch members' },
            { status: 500 }
        );
    }
}

// POST /api/projects/[projectId]/members - Invite a member
export async function POST(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Check if user is owner or admin
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
            return NextResponse.json(
                { error: 'Only project owners and admins can invite members' },
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

        if (userToInvite.id === project.ownerId) {
            return NextResponse.json(
                { error: 'Cannot invite the project owner as a member' },
                { status: 400 }
            );
        }

        // Check if already a member
        const existingMember = await db.projectMember.findUnique({
            where: { projectId_userId: { projectId, userId: userToInvite.id } },
        });

        if (existingMember) {
            return NextResponse.json(
                { error: 'User is already a member of this project' },
                { status: 409 }
            );
        }

        const member = await db.projectMember.create({
            data: {
                projectId,
                userId: userToInvite.id,
                role: memberRole as ProjectMemberRole,
            },
            include: {
                user: { select: { id: true, name: true, image: true } },
            },
        });

        return NextResponse.json(member, { status: 201 });
    } catch (error) {
        console.error('Error inviting project member:', error);
        return NextResponse.json(
            { error: 'Failed to invite member' },
            { status: 500 }
        );
    }
}
