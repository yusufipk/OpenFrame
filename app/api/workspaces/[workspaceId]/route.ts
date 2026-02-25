import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { cleanupWorkspaceMediaFiles } from '@/lib/r2-cleanup';
import { cleanupBunnyStreamVideos } from '@/lib/bunny-stream-cleanup';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

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
        const MAX_LIMIT = 100;
        const MAX_OFFSET = 10000;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const searchParams = request.nextUrl.searchParams;
        const limitParam = searchParams.get('limit');
        const offsetParam = searchParams.get('offset');

        const limitRaw = limitParam === null ? 20 : Number(limitParam);
        if (!Number.isSafeInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
            return apiErrors.badRequest('Invalid limit. Must be a positive integer between 1 and 100.');
        }

        const offset = offsetParam === null ? 0 : Number(offsetParam);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
            return apiErrors.badRequest('Invalid offset. Must be a non-negative integer up to 10000.');
        }

        const limit = limitRaw;

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
                    skip: offset,
                    take: limit,
                    include: {
                        _count: { select: { videos: true, members: true } },
                    },
                },
                _count: { select: { projects: true, members: true } },
            },
        });

        if (!workspace) {
            return apiErrors.notFound('Workspace');
        }

        // Check access
        const isOwner = session?.user?.id === workspace.ownerId;
        const isMember = workspace.members.some((m: { userId: string }) => m.userId === session?.user?.id);

        if (!isOwner && !isMember) {
            return apiErrors.forbidden('Access denied');
        }

        const response = successResponse(workspace);
        return withCacheControl(response, 'private, max-age=30, stale-while-revalidate=60');
    } catch (error) {
        console.error('Error fetching workspace:', error);
        return apiErrors.internalError('Failed to fetch workspace');
    }
}

// PATCH /api/workspaces/[workspaceId] - Update a workspace
export async function PATCH(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { workspaceId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const { isAdmin } = await checkWorkspaceAccess(workspaceId, session.user.id);
        if (!isAdmin) {
            return apiErrors.forbidden('Access denied');
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

        const response = successResponse(workspace);
        return withCacheControl(response, 'private, max-age=30, stale-while-revalidate=60');
    } catch (error) {
        console.error('Error updating workspace:', error);
        return apiErrors.internalError('Failed to update workspace');
    }
}

// DELETE /api/workspaces/[workspaceId] - Delete a workspace
export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { workspaceId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const { isOwner, workspace } = await checkWorkspaceAccess(workspaceId, session.user.id);

        if (!workspace) {
            return apiErrors.notFound('Workspace');
        }

        if (!isOwner) {
            return apiErrors.forbidden('Only the workspace owner can delete it');
        }

        // Delete Bunny provider videos first to avoid orphaned external assets.
        const workspaceVersionRefs = await db.videoVersion.findMany({
            where: {
                video: {
                    project: {
                        workspaceId,
                    },
                },
            },
            select: {
                providerId: true,
                videoId: true,
            },
        });
        await cleanupBunnyStreamVideos(workspaceVersionRefs);

        // Clean up voice files from R2 before cascade delete removes comment rows
        await cleanupWorkspaceMediaFiles(workspaceId);

        await db.workspace.delete({ where: { id: workspaceId } });

        const response = successResponse({ message: 'Workspace deleted' });
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error deleting workspace:', error);
        return apiErrors.internalError('Failed to delete workspace');
    }
}
