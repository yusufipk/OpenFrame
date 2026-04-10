import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkWorkspaceAccess } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { collectWorkspaceMediaUrls, deleteMediaFilesBestEffort } from '@/lib/r2-cleanup';
import { cleanupBunnyStreamVideosBestEffort } from '@/lib/bunny-stream-cleanup';
import { buildCleanupWarnings, logCleanupWarnings } from '@/lib/cleanup-warnings';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ workspaceId: string }> };

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

        const access = await checkWorkspaceAccess(
            { id: workspace.id, ownerId: workspace.ownerId },
            session.user.id
        );
        if (!access.hasAccess) {
            return apiErrors.forbidden('Access denied');
        }

        const response = successResponse(workspace);
        return withCacheControl(response, 'private, max-age=30, stale-while-revalidate=60');
    } catch (error) {
        logError('Error fetching workspace:', error);
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

        const workspaceAccessTarget = await db.workspace.findUnique({
            where: { id: workspaceId },
            select: { id: true, ownerId: true },
        });
        if (!workspaceAccessTarget) {
            return apiErrors.notFound('Workspace');
        }

        const access = await checkWorkspaceAccess(workspaceAccessTarget, session.user.id);
        if (!access.canEdit) {
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
        logError('Error updating workspace:', error);
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

        const workspace = await db.workspace.findUnique({
            where: { id: workspaceId },
            select: { id: true, ownerId: true },
        });
        if (!workspace) {
            return apiErrors.notFound('Workspace');
        }

        const access = await checkWorkspaceAccess(workspace, session.user.id);
        if (!access.canDelete) {
            return apiErrors.forbidden('Only the workspace owner can delete it');
        }

        const [workspaceVersionRefs, workspaceAssetRefs, mediaUrls] = await Promise.all([
            db.videoVersion.findMany({
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
            }),
            db.videoAsset.findMany({
                where: {
                    provider: 'BUNNY',
                    providerVideoId: { not: null },
                    video: {
                        project: {
                            workspaceId,
                        },
                    },
                },
                select: {
                    providerVideoId: true,
                },
            }),
            collectWorkspaceMediaUrls(workspaceId),
        ]);

        const bunnyRefs = [
            ...workspaceVersionRefs,
            ...workspaceAssetRefs.map((asset) => ({
                providerId: 'bunny',
                videoId: asset.providerVideoId as string,
            })),
        ];

        await db.workspace.delete({ where: { id: workspaceId } });

        const [bunnyCleanupResult, r2CleanupResult] = await Promise.all([
            cleanupBunnyStreamVideosBestEffort(bunnyRefs),
            deleteMediaFilesBestEffort(mediaUrls),
        ]);

        const cleanupInput = {
            bunny: bunnyCleanupResult,
            r2: r2CleanupResult,
        };
        const cleanupWarnings = buildCleanupWarnings(cleanupInput);
        if (cleanupWarnings) {
            logCleanupWarnings({ entityType: 'workspace', entityId: workspaceId }, cleanupInput);
        }

        const response = successResponse({
            message: 'Workspace deleted',
            ...(cleanupWarnings ? { cleanupWarnings } : {}),
        });
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        logError('Error deleting workspace:', error);
        return apiErrors.internalError('Failed to delete workspace');
    }
}
