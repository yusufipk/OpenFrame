import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProjectMemberRole, ProjectVisibility } from '@prisma/client';

type RouteParams = { params: Promise<{ projectId: string }> };

// Helper to check project access
async function checkProjectAccess(projectId: string, userId: string) {
    const project = await db.project.findUnique({
        where: { id: projectId },
        include: {
            members: { where: { userId } },
        },
    });

    if (!project) return { project: null, role: null, canEdit: false, canDelete: false };

    const isOwner = project.ownerId === userId;
    const membership = project.members[0];
    let role: string | null = isOwner ? 'OWNER' : membership?.role || null;

    // Check workspace-level access if not already authorized
    if (!isOwner && !membership) {
        const wsMember = await db.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
        });
        const wsOwner = await db.workspace.findUnique({
            where: { id: project.workspaceId },
            select: { ownerId: true },
        });
        if (wsOwner?.ownerId === userId) {
            role = 'OWNER';
        } else if (wsMember) {
            role = wsMember.role; // ADMIN or COMMENTATOR from workspace
        }
    }

    return {
        project,
        role,
        canEdit: isOwner || role === 'OWNER' || role === ProjectMemberRole.ADMIN,
        canDelete: isOwner || role === 'OWNER',
    };
}

// GET /api/projects/[projectId] - Get a single project
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId } = await params;

        const project = await db.project.findUnique({
            where: { id: projectId },
            include: {
                owner: { select: { id: true, name: true, image: true } },
                members: {
                    include: {
                        user: { select: { id: true, name: true, image: true } },
                    },
                },
                videos: {
                    orderBy: { position: 'asc' },
                    include: {
                        versions: {
                            orderBy: { versionNumber: 'desc' },
                            take: 1,
                        },
                        _count: { select: { versions: true } },
                    },
                },
                _count: { select: { videos: true, members: true, shareLinks: true } },
            },
        });

        if (!project) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }

        // Check access
        const isPublic = project.visibility === ProjectVisibility.PUBLIC;
        const isOwner = session?.user?.id === project.ownerId;
        const isMember = project.members.some(m => m.userId === session?.user?.id);

        // Check workspace membership
        let isWorkspaceMember = false;
        if (!isPublic && !isOwner && !isMember && session?.user?.id) {
            const wsMember = await db.workspaceMember.findUnique({
                where: {
                    workspaceId_userId: {
                        workspaceId: project.workspaceId,
                        userId: session.user.id,
                    },
                },
            });
            const wsOwner = await db.workspace.findUnique({
                where: { id: project.workspaceId },
                select: { ownerId: true },
            });
            isWorkspaceMember = !!wsMember || wsOwner?.ownerId === session.user.id;
        }

        if (!isPublic && !isOwner && !isMember && !isWorkspaceMember) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        return NextResponse.json(project);
    } catch (error) {
        console.error('Error fetching project:', error);
        return NextResponse.json(
            { error: 'Failed to fetch project' },
            { status: 500 }
        );
    }
}

// PATCH /api/projects/[projectId] - Update a project
export async function PATCH(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { canEdit } = await checkProjectAccess(projectId, session.user.id);
        if (!canEdit) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        const body = await request.json();
        const { name, description, visibility } = body;

        const updateData: Record<string, unknown> = {};
        if (name !== undefined) updateData.name = name.trim();
        if (description !== undefined) updateData.description = description?.trim() || null;
        if (visibility !== undefined) updateData.visibility = visibility;

        const project = await db.project.update({
            where: { id: projectId },
            data: updateData,
            include: {
                owner: { select: { id: true, name: true, image: true } },
                _count: { select: { videos: true, members: true } },
            },
        });

        return NextResponse.json(project);
    } catch (error) {
        console.error('Error updating project:', error);
        return NextResponse.json(
            { error: 'Failed to update project' },
            { status: 500 }
        );
    }
}

// DELETE /api/projects/[projectId] - Delete a project
export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { canDelete, project } = await checkProjectAccess(projectId, session.user.id);

        if (!project) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }

        if (!canDelete) {
            return NextResponse.json(
                { error: 'Only the project owner can delete it' },
                { status: 403 }
            );
        }

        await db.project.delete({ where: { id: projectId } });

        return NextResponse.json({ success: true, message: 'Project deleted' });
    } catch (error) {
        console.error('Error deleting project:', error);
        return NextResponse.json(
            { error: 'Failed to delete project' },
            { status: 500 }
        );
    }
}
