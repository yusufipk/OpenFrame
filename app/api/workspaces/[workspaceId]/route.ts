import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';

type RouteParams = { params: Promise<{ workspaceId: string }> };

// Helper to check workspace access
async function checkWorkspaceAccess(workspaceId: string, userId: string) {
    const workspace = await db.workspace.findUnique({
        where: { id: workspaceId },
        include: {
            members: { where: { userId } },
        },
    });

    if (!workspace) return { workspace: null, role: null, isOwner: false, isAdmin: false };

    const isOwner = workspace.ownerId === userId;
    const membership = workspace.members[0];
    const role = isOwner ? 'OWNER' : membership?.role || null;

    return {
        workspace,
        role,
        isOwner,
        isAdmin: isOwner || role === 'ADMIN',
    };
}

// GET /api/workspaces/[workspaceId] - Get a single workspace
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
                owner: { select: { id: true, name: true, image: true } },
                members: {
                    include: {
                        user: { select: { id: true, name: true, image: true } },
                    },
                },
                projects: {
                    orderBy: { updatedAt: 'desc' },
                    include: {
                        _count: { select: { videos: true, members: true } },
                    },
                },
                _count: { select: { projects: true, members: true } },
            },
        });

        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        // Check access
        const isOwner = session?.user?.id === workspace.ownerId;
        const isMember = workspace.members.some(m => m.userId === session?.user?.id);

        if (!isOwner && !isMember) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        return NextResponse.json(workspace);
    } catch (error) {
        console.error('Error fetching workspace:', error);
        return NextResponse.json(
            { error: 'Failed to fetch workspace' },
            { status: 500 }
        );
    }
}

// PATCH /api/workspaces/[workspaceId] - Update a workspace
export async function PATCH(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { workspaceId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { isAdmin } = await checkWorkspaceAccess(workspaceId, session.user.id);
        if (!isAdmin) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        const body = await request.json();
        const { name, description } = body;

        const updateData: Record<string, unknown> = {};
        if (name !== undefined) updateData.name = name.trim();
        if (description !== undefined) updateData.description = description?.trim() || null;

        const workspace = await db.workspace.update({
            where: { id: workspaceId },
            data: updateData,
            include: {
                owner: { select: { id: true, name: true, image: true } },
                _count: { select: { projects: true, members: true } },
            },
        });

        return NextResponse.json(workspace);
    } catch (error) {
        console.error('Error updating workspace:', error);
        return NextResponse.json(
            { error: 'Failed to update workspace' },
            { status: 500 }
        );
    }
}

// DELETE /api/workspaces/[workspaceId] - Delete a workspace
export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { workspaceId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { isOwner, workspace } = await checkWorkspaceAccess(workspaceId, session.user.id);

        if (!workspace) {
            return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
        }

        if (!isOwner) {
            return NextResponse.json(
                { error: 'Only the workspace owner can delete it' },
                { status: 403 }
            );
        }

        await db.workspace.delete({ where: { id: workspaceId } });

        return NextResponse.json({ success: true, message: 'Workspace deleted' });
    } catch (error) {
        console.error('Error deleting workspace:', error);
        return NextResponse.json(
            { error: 'Failed to delete workspace' },
            { status: 500 }
        );
    }
}
