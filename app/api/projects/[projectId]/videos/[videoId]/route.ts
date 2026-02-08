import { NextRequest } from 'next/server';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProjectMemberRole, WorkspaceMemberRole } from '@prisma/client';
import { rateLimit } from '@/lib/rate-limit';
import { cleanupVideoVoiceFiles } from '@/lib/r2-cleanup';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

type RouteParams = { params: Promise<{ projectId: string; videoId: string }> };

// GET /api/projects/[projectId]/videos/[videoId]
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId, videoId } = await params;

        const video = await db.video.findFirst({
            where: { id: videoId, projectId },
            include: {
                project: {
                    include: { members: { where: { userId: session?.user?.id || '' } } },
                },
                versions: {
                    orderBy: { versionNumber: 'desc' },
                    include: {
                        comments: {
                            orderBy: { timestamp: 'asc' },
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
                            where: { parentId: null }, // Only top-level comments
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

        const response = successResponse({
            ...video,
            isAuthenticated: !!session?.user?.id,
        });

        return withCacheControl(response, 'private, no-cache');
    } catch (error) {
        console.error('Error fetching video:', error);
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
                project: {
                    include: {
                        members: { where: { userId: session.user.id } },
                        workspace: {
                            include: {
                                members: { where: { userId: session.user.id } },
                            },
                        },
                    },
                },
            },
        });

        if (!video) {
            return apiErrors.notFound('Video');
        }

        const isOwner = video.project.ownerId === session.user.id;
        const membership = video.project.members[0];
        const workspaceMembership = video.project.workspace.members[0];
        const canEdit = isOwner ||
            membership?.role === ProjectMemberRole.ADMIN ||
            workspaceMembership?.role === WorkspaceMemberRole.ADMIN;

        if (!canEdit) {
            return apiErrors.forbidden('Access denied');
        }

        const body = await request.json();
        const { title, description, position } = body;

        const updateData: Record<string, unknown> = {};
        if (title !== undefined) updateData.title = title.trim();
        if (description !== undefined) updateData.description = description?.trim() || null;
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
        console.error('Error updating video:', error);
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
                project: {
                    include: {
                        members: { where: { userId: session.user.id } },
                        workspace: {
                            include: {
                                members: { where: { userId: session.user.id } },
                            },
                        },
                    },
                },
            },
        });

        if (!video) {
            return apiErrors.notFound('Video');
        }

        const isOwner = video.project.ownerId === session.user.id;
        const membership = video.project.members[0];
        const workspaceMembership = video.project.workspace.members[0];
        // Destructive actions limited to OWNER and ADMIN only
        const canDelete = isOwner ||
            membership?.role === ProjectMemberRole.ADMIN ||
            workspaceMembership?.role === WorkspaceMemberRole.ADMIN;

        if (!canDelete) {
            return apiErrors.forbidden('Only project owner or admin can delete videos');
        }

        // Clean up voice files from R2 before cascade delete removes comment rows
        await cleanupVideoVoiceFiles(videoId);

        await db.video.delete({ where: { id: videoId } });

        revalidatePath(`/projects/${projectId}`);

        const response = successResponse({ message: 'Video deleted' });
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error deleting video:', error);
        return apiErrors.internalError('Failed to delete video');
    }
}
