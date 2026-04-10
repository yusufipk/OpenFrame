import { NextRequest } from 'next/server';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { collectVideoMediaUrls, deleteMediaFilesBestEffort } from '@/lib/r2-cleanup';
import { cleanupBunnyStreamVideosBestEffort } from '@/lib/bunny-stream-cleanup';
import { buildCleanupWarnings, logCleanupWarnings } from '@/lib/cleanup-warnings';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string; videoId: string }> };

// GET /api/projects/[projectId]/videos/[videoId]
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId, videoId } = await params;

        // Parse query params for pagination and options
        const searchParams = request.nextUrl.searchParams;
        const includeComments = searchParams.get('includeComments') !== 'false';
        const commentLimit = Math.min(parseInt(searchParams.get('commentLimit') || '50'), 100);
        const commentOffset = Math.max(0, parseInt(searchParams.get('commentOffset') || '0'));
        const includeReplies = searchParams.get('includeReplies') === 'true';

        const video = await db.video.findFirst({
            where: { id: videoId, projectId },
            include: {
                project: true,
                versions: {
                    orderBy: { versionNumber: 'desc' },
                    ...(includeComments ? {
                        include: {
                            comments: {
                                orderBy: { timestamp: 'asc' },
                                skip: commentOffset,
                                take: commentLimit,
                                select: {
                                    id: true,
                                    content: true,
                                    timestamp: true,
                                    timestampEnd: true,
                                    createdAt: true,
                                    updatedAt: true,
                                    isResolved: true,
                                    resolvedAt: true,
                                    voiceUrl: true,
                                    voiceDuration: true,
                                    imageUrl: true,
                                    annotationData: true,
                                    parentId: true,
                                    authorId: true,
                                    tagId: true,
                                    versionId: true,
                                    guestName: true,
                                    // guestEmail excluded for privacy
                                    author: { select: { id: true, name: true, image: true } },
                                    tag: { select: { id: true, name: true, color: true } },
                                    ...(includeReplies ? {
                                        replies: {
                                            orderBy: { createdAt: 'asc' },
                                            select: {
                                                id: true,
                                                content: true,
                                                timestamp: true,
                                                timestampEnd: true,
                                                createdAt: true,
                                                updatedAt: true,
                                                isResolved: true,
                                                resolvedAt: true,
                                                voiceUrl: true,
                                                voiceDuration: true,
                                                imageUrl: true,
                                                annotationData: true,
                                                parentId: true,
                                                authorId: true,
                                                tagId: true,
                                                versionId: true,
                                                guestName: true,
                                                // guestEmail excluded for privacy
                                                author: { select: { id: true, name: true, image: true } },
                                                tag: { select: { id: true, name: true, color: true } },
                                            },
                                        },
                                    } : {}),
                                },
                                where: { parentId: null },
                            },
                            _count: { select: { comments: true } },
                        },
                    } : {
                        select: {
                            id: true,
                            thumbnailUrl: true,
                            duration: true,
                            versionNumber: true,
                            versionLabel: true,
                            providerId: true,
                            videoId: true,
                            originalUrl: true,
                            title: true,
                            isActive: true,
                            _count: { select: { comments: true } },
                        },
                    }),
                },
            },
        });

        if (!video) {
            return apiErrors.notFound('Video');
        }

        // Check access including workspace membership
        const access = await checkProjectAccess(video.project, session?.user?.id);

        if (!access.hasAccess) {
            return apiErrors.forbidden('Access denied');
        }

        const response = successResponse({
            ...video,
            isAuthenticated: !!session?.user?.id,
            currentUserId: session?.user?.id || null,
            currentUserName: session?.user?.name || null,
            canDownload: access.hasAccess,
            canManageTags: access.canEdit,
            canResolveComments: access.canEdit,
            canRequestApproval: access.canEdit,
            canShareVideo: access.canEdit,
            canUploadAssets: access.hasAccess,
            canDownloadAssets: !!session?.user?.id && access.hasAccess,
        });

        return withCacheControl(response, 'private, no-cache');
    } catch (error) {
        logError('Error fetching video:', error);
        return apiErrors.internalError('Failed to fetch video');
    }
}

// PATCH /api/projects/[projectId]/videos/[videoId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { projectId, videoId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const video = await db.video.findFirst({
            where: { id: videoId, projectId },
            include: {
                project: true,
            },
        });

        if (!video) {
            return apiErrors.notFound('Video');
        }

        const access = await checkProjectAccess(video.project, session.user.id, { intent: 'manage' });
        if (!access.canEdit) {
            return apiErrors.forbidden('Access denied');
        }

        const body = await request.json();
        const { title, description, position } = body;

        // Validate types before using string methods to prevent type confusion attacks
        if (
            position !== undefined &&
            (typeof position !== 'number' || !Number.isInteger(position) || position < 0)
        ) {
            return apiErrors.badRequest('position must be a non-negative integer');
        }

        const updateData: Record<string, unknown> = {};
        if (typeof title === 'string') updateData.title = title.trim();
        if (typeof description === 'string') updateData.description = description.trim() || null;
        if (position !== undefined) updateData.position = position;

        const updatedVideo = await db.video.update({
            where: { id: videoId },
            data: updateData,
            include: {
                versions: { orderBy: { versionNumber: 'desc' } },
                _count: { select: { versions: true } },
            },
        });

        const response = successResponse(updatedVideo);
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        logError('Error updating video:', error);
        return apiErrors.internalError('Failed to update video');
    }
}

// DELETE /api/projects/[projectId]/videos/[videoId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { projectId, videoId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const video = await db.video.findFirst({
            where: { id: videoId, projectId },
            include: {
                versions: {
                    select: {
                        providerId: true,
                        videoId: true,
                    },
                },
                assets: {
                    select: {
                        provider: true,
                        providerVideoId: true,
                    },
                },
                project: true,
            },
        });

        if (!video) {
            return apiErrors.notFound('Video');
        }

        const access = await checkProjectAccess(video.project, session.user.id, { intent: 'manage' });
        if (!access.canEdit) {
            return apiErrors.forbidden('Only project owner or admin can delete videos');
        }

        const bunnyRefs = [
            ...video.versions,
            ...video.assets
                .filter((asset) => asset.provider === 'BUNNY' && !!asset.providerVideoId)
                .map((asset) => ({
                    providerId: 'bunny',
                    videoId: asset.providerVideoId as string,
                })),
        ];

        const mediaUrls = await collectVideoMediaUrls(videoId);

        await db.video.delete({ where: { id: videoId } });

        revalidatePath(`/projects/${projectId}`);

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
            logCleanupWarnings({ entityType: 'video', entityId: videoId }, cleanupInput);
        }

        const response = successResponse({
            message: 'Video deleted',
            ...(cleanupWarnings ? { cleanupWarnings } : {}),
        });
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        logError('Error deleting video:', error);
        return apiErrors.internalError('Failed to delete video');
    }
}
