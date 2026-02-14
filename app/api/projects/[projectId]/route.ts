import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProjectMemberRole, ProjectVisibility } from '@prisma/client';
import { rateLimit } from '@/lib/rate-limit';
import { cleanupProjectVoiceFiles } from '@/lib/r2-cleanup';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

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
        
        // Parse pagination params
        const searchParams = request.nextUrl.searchParams;
        const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);
        const offset = parseInt(searchParams.get('offset') || '0');

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
                    skip: offset,
                    take: limit,
                    include: {
                        versions: {
                            where: { isActive: true },
                            orderBy: { versionNumber: 'desc' },
                            take: 1,
                            select: {
                                id: true,
                                thumbnailUrl: true,
                                duration: true,
                                versionNumber: true,
                                _count: { select: { comments: true } },
                            },
                        },
                        _count: { select: { versions: true } },
                    },
                },
                _count: { select: { videos: true, members: true, shareLinks: true } },
            },
        });

        if (!project) {
            return apiErrors.notFound('Project');
        }

        // Check access
        const isPublic = project.visibility === ProjectVisibility.PUBLIC;
        const isOwner = session?.user?.id === project.ownerId;
        const isMember = project.members.some((m: { userId: string }) => m.userId === session?.user?.id);

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
            return apiErrors.forbidden('Access denied');
        }

        const response = successResponse(project);
        return withCacheControl(response, 'private, max-age=30, stale-while-revalidate=60');
    } catch (error) {
        console.error('Error fetching project:', error);
        return apiErrors.internalError('Failed to fetch project');
    }
}

// PATCH /api/projects/[projectId] - Update a project
export async function PATCH(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { projectId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const { canEdit } = await checkProjectAccess(projectId, session.user.id);
        if (!canEdit) {
            return apiErrors.forbidden('Access denied');
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

        const response = successResponse(project);
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error updating project:', error);
        return apiErrors.internalError('Failed to update project');
    }
}

// DELETE /api/projects/[projectId] - Delete a project
export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { projectId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const { canDelete, project } = await checkProjectAccess(projectId, session.user.id);

        if (!project) {
            return apiErrors.notFound('Project');
        }

        if (!canDelete) {
            return apiErrors.forbidden('Only the project owner can delete it');
        }

        // Clean up voice files from R2 before cascade delete removes comment rows
        await cleanupProjectVoiceFiles(projectId);

        await db.project.delete({ where: { id: projectId } });

        const response = successResponse({ message: 'Project deleted' });
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error deleting project:', error);
        return apiErrors.internalError('Failed to delete project');
    }
}
