import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string; tagId: string }> };

// PATCH /api/projects/[projectId]/tags/[tagId] - Update a tag
export async function PATCH(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { projectId, tagId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const project = await db.project.findUnique({
            where: { id: projectId },
            select: { id: true, ownerId: true, workspaceId: true, visibility: true },
        });
        if (!project) {
            return apiErrors.notFound('Project');
        }

        const access = await checkProjectAccess(project, session.user.id, { intent: 'manage' });
        if (!access.canEdit) {
            return apiErrors.forbidden('Access denied');
        }

        // Verify tag belongs to this project
        const existingTag = await db.commentTag.findUnique({
            where: { id: tagId },
        });
        if (!existingTag || existingTag.projectId !== projectId) {
            return apiErrors.notFound('Tag');
        }

        const body = await request.json();
        const { name, color, position } = body;

        const updateData: Record<string, unknown> = {};
        if (name !== undefined) {
            if (!name.trim()) {
                return apiErrors.badRequest('Name cannot be empty');
            }
            updateData.name = name.trim();
        }
        if (color !== undefined) {
            if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
                return apiErrors.badRequest('Invalid color format');
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

        const response = successResponse(tag);
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        logError('Error updating tag:', error);
        if ((error as { code?: string }).code === 'P2002') {
            return apiErrors.conflict('Tag name already exists');
        }
        return apiErrors.internalError('Failed to update tag');
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
            return apiErrors.unauthorized();
        }

        const project = await db.project.findUnique({
            where: { id: projectId },
            select: { id: true, ownerId: true, workspaceId: true, visibility: true },
        });
        if (!project) {
            return apiErrors.notFound('Project');
        }

        const access = await checkProjectAccess(project, session.user.id, { intent: 'manage' });
        if (!access.canEdit) {
            return apiErrors.forbidden('Access denied');
        }

        // Verify tag belongs to this project
        const existingTag = await db.commentTag.findUnique({
            where: { id: tagId },
        });
        if (!existingTag || existingTag.projectId !== projectId) {
            return apiErrors.notFound('Tag');
        }

        await db.commentTag.delete({ where: { id: tagId } });

        const response = successResponse({ message: 'Tag deleted' });
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        logError('Error deleting tag:', error);
        return apiErrors.internalError('Failed to delete tag');
    }
}
