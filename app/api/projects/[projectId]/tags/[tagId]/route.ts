import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';

type RouteParams = { params: Promise<{ projectId: string; tagId: string }> };

// Helper to check project access
async function checkProjectAccess(projectId: string, userId: string) {
    const project = await db.project.findUnique({
        where: { id: projectId },
        include: { members: { where: { userId } } },
    });

    if (!project) return { project: null, canEdit: false };

    const isOwner = project.ownerId === userId;
    const isAdmin = project.members[0]?.role === 'ADMIN';

    // Check workspace-level access
    let workspaceCanEdit = false;
    if (!isOwner && !isAdmin) {
        const wsMember = await db.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
        });
        const wsOwner = await db.workspace.findUnique({
            where: { id: project.workspaceId },
            select: { ownerId: true },
        });
        workspaceCanEdit = wsOwner?.ownerId === userId || wsMember?.role === 'ADMIN';
    }

    return {
        project,
        canEdit: isOwner || isAdmin || workspaceCanEdit,
    };
}

// PATCH /api/projects/[projectId]/tags/[tagId] - Update a tag
export async function PATCH(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { projectId, tagId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { canEdit, project } = await checkProjectAccess(projectId, session.user.id);
        if (!project) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }
        if (!canEdit) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        // Verify tag belongs to this project
        const existingTag = await db.commentTag.findUnique({
            where: { id: tagId },
        });
        if (!existingTag || existingTag.projectId !== projectId) {
            return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
        }

        const body = await request.json();
        const { name, color, position } = body;

        const updateData: Record<string, unknown> = {};
        if (name !== undefined) {
            if (!name.trim()) {
                return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 });
            }
            updateData.name = name.trim();
        }
        if (color !== undefined) {
            if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
                return NextResponse.json({ error: 'Invalid color format' }, { status: 400 });
            }
            updateData.color = color.toUpperCase();
        }
        if (position !== undefined) {
            updateData.position = position;
        }

        const tag = await db.commentTag.update({
            where: { id: tagId },
            data: updateData,
        });

        return NextResponse.json(tag);
    } catch (error) {
        console.error('Error updating tag:', error);
        if ((error as { code?: string }).code === 'P2002') {
            return NextResponse.json({ error: 'Tag name already exists' }, { status: 409 });
        }
        return NextResponse.json({ error: 'Failed to update tag' }, { status: 500 });
    }
}

// DELETE /api/projects/[projectId]/tags/[tagId] - Delete a tag
export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { projectId, tagId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { canEdit, project } = await checkProjectAccess(projectId, session.user.id);
        if (!project) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }
        if (!canEdit) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        // Verify tag belongs to this project
        const existingTag = await db.commentTag.findUnique({
            where: { id: tagId },
        });
        if (!existingTag || existingTag.projectId !== projectId) {
            return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
        }

        await db.commentTag.delete({ where: { id: tagId } });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting tag:', error);
        return NextResponse.json({ error: 'Failed to delete tag' }, { status: 500 });
    }
}
