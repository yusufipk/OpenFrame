import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';

type RouteParams = { params: Promise<{ videoId: string }> };

// GET /api/watch/[videoId] - Public watch endpoint (no projectId needed)
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        // Rate limit: 60 requests per minute per IP for public watch endpoint
        const limited = await rateLimit(request, 'watch', { windowMs: 60 * 1000, maxRequests: 60 });
        if (limited) return limited;

        const session = await auth();
        const { videoId } = await params;

        // Parse query params
        const searchParams = request.nextUrl.searchParams;
        const includeComments = searchParams.get('includeComments') === 'true';

        const video = await db.video.findUnique({
            where: { id: videoId },
            include: {
                project: true,
                versions: {
                    orderBy: { versionNumber: 'desc' },
                    ...(includeComments ? {
                        include: {
                            comments: {
                                orderBy: { timestamp: 'asc' },
                                where: { parentId: null },
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
                                    author: { select: { id: true, name: true, image: true } },
                                    tag: { select: { id: true, name: true, color: true } },
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
                                            author: { select: { id: true, name: true, image: true } },
                                            tag: { select: { id: true, name: true, color: true } },
                                        },
                                    },
                                },
                            },
                            _count: { select: { comments: true } },
                        },
                    } : {
                        select: {
                            id: true,
                            thumbnailUrl: true,
                            duration: true,
                            versionNumber: true,
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
        const shareSession = getShareSessionFromRequest(request, video.id);
        const shareAccess = shareSession
            ? await validateShareLinkAccess({
                token: shareSession.token,
                projectId: video.projectId,
                videoId: video.id,
                requiredPermission: 'VIEW',
                passwordVerified: shareSession.passwordVerified,
            })
            : { hasAccess: false, canComment: false, allowGuests: false, requiresPassword: false };

        if (!access.hasAccess && !shareAccess.hasAccess) {
            return apiErrors.forbidden('Access denied');
        }

        // Include auth context so the client knows if the viewer is a guest
        const { project, ...videoData } = video;
        const canCommentWithMembership = access.hasAccess;
        const canCommentWithShareLink = shareAccess.canComment && (session?.user?.id ? true : shareAccess.allowGuests);
        const response = successResponse({
            ...videoData,
            projectId: video.projectId,
            project: {
                name: project.name,
                ownerId: project.ownerId,
                visibility: project.visibility,
            },
            isAuthenticated: !!session?.user?.id,
            currentUserId: session?.user?.id || null,
            currentUserName: session?.user?.name || null,
            canComment: canCommentWithMembership || canCommentWithShareLink,
        });

        return withCacheControl(response, 'private, no-cache');
    } catch (error) {
        console.error('Error fetching video:', error);
        return apiErrors.internalError('Failed to fetch video');
    }
}
