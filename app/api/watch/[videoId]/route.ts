import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

type RouteParams = { params: Promise<{ videoId: string }> };

// GET /api/watch/[videoId] - Public watch endpoint (no projectId needed)
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { videoId } = await params;

        const video = await db.video.findUnique({
            where: { id: videoId },
            include: {
                project: {
                    include: {
                        members: { where: { userId: session?.user?.id || '' } },
                    },
                },
                versions: {
                    orderBy: { versionNumber: 'desc' },
                    include: {
                        comments: {
                            orderBy: { timestamp: 'asc' },
                            where: { parentId: null },
                            include: {
                                author: { select: { id: true, name: true, image: true } },
                                tag: { select: { id: true, name: true, color: true } },
                                replies: {
                                    orderBy: { createdAt: 'asc' },
                                    include: {
                                        author: { select: { id: true, name: true, image: true } },
                                        tag: { select: { id: true, name: true, color: true } },
                                    },
                                },
                            },
                        },
                        _count: { select: { comments: true } },
                    },
                },
            },
        });

        if (!video) {
            return apiErrors.notFound('Video');
        }

        // Check access
        const isOwner = session?.user?.id === video.project.ownerId;
        const isMember = video.project.members.length > 0;
        const isPublic = video.project.visibility === 'PUBLIC';

        if (!isOwner && !isMember && !isPublic) {
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
            canComment: isOwner || isMember || isPublic,
        });

        return withCacheControl(response, 'public, s-maxage=60, stale-while-revalidate=300');
    } catch (error) {
        console.error('Error fetching video:', error);
        return apiErrors.internalError('Failed to fetch video');
    }
}
