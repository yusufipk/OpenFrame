import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

type RouteParams = { params: Promise<{ videoId: string }> };

// Helper to check project access including workspace membership
async function checkProjectAccess(project: { ownerId: string; workspaceId: string; visibility: string; members: { userId: string }[] }, userId: string | undefined) {
    const isOwner = userId === project.ownerId;
    const isMember = project.members.some(m => m.userId === userId);
    const isPublic = project.visibility === 'PUBLIC';
    
    // Check workspace membership for access
    let isWorkspaceMember = false;
    if (!isOwner && !isMember && !isPublic && userId) {
        const wsMember = await db.workspaceMember.findUnique({
            where: {
                workspaceId_userId: {
                    workspaceId: project.workspaceId,
                    userId: userId,
                },
            },
        });
        const wsOwner = await db.workspace.findUnique({
            where: { id: project.workspaceId },
            select: { ownerId: true },
        });
        isWorkspaceMember = !!wsMember || wsOwner?.ownerId === userId;
    }
    
    return { isOwner, isMember, isPublic, isWorkspaceMember, hasAccess: isOwner || isMember || isPublic || isWorkspaceMember };
}

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
            canComment: access.isOwner || access.isMember || access.isPublic || access.isWorkspaceMember,
        });

        return withCacheControl(response, 'private, no-cache');
    } catch (error) {
        console.error('Error fetching video:', error);
        return apiErrors.internalError('Failed to fetch video');
    }
}
