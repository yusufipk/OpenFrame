import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

type RouteParams = { params: Promise<{ videoId: string }> };

// GET /api/watch/[videoId] - Public watch endpoint (no projectId needed)
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
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
                    where: { isActive: true },
                    orderBy: { versionNumber: 'desc' },
                    take: 1,
                    ...(includeComments ? {
                        include: {
                            comments: {
                                orderBy: { timestamp: 'asc' },
                                where: { parentId: null },
                                include: {
                                    author: { select: { id: true, name: true, image: true } },
                                    tag: { select: { id: true, name: true, color: true } },
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

        if (!access.hasAccess) {
            return apiErrors.forbidden('Access denied');
        }

        // Include auth context so the client knows if the viewer is a guest
        const { project, ...videoData } = video;
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
            canComment: access.hasAccess,
        });

        return withCacheControl(response, 'private, no-cache');
    } catch (error) {
        console.error('Error fetching video:', error);
        return apiErrors.internalError('Failed to fetch video');
    }
}
