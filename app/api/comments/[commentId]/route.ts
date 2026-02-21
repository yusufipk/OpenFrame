import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

type RouteParams = { params: Promise<{ commentId: string }> };

// GET /api/comments/[commentId]
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { commentId } = await params;

        const comment = await db.comment.findUnique({
            where: { id: commentId },
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
                        parentId: true,
                        authorId: true,
                        tagId: true,
                        versionId: true,
                        guestName: true,
                        author: { select: { id: true, name: true, image: true } },
                        tag: { select: { id: true, name: true, color: true } },
                    },
                },
                version: {
                    include: {
                        video: {
                            include: {
                                project: {
                                    include: {
                                        members: { where: { userId: session?.user?.id || '' } },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (!comment) {
            return apiErrors.notFound('Comment');
        }

        // Authorization check: verify user has access to the project
        const project = comment.version.video.project;
        const isOwner = session?.user?.id === project.ownerId;
        const isMember = project.members.length > 0;
        const isPublic = project.visibility === 'PUBLIC';

        // Check workspace membership for access
        let isWorkspaceMember = false;
        if (!isOwner && !isMember && !isPublic && session?.user?.id) {
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

        if (!isOwner && !isMember && !isPublic && !isWorkspaceMember) {
            return apiErrors.forbidden('Access denied');
        }

        // Strip internal project data from response
        const { version: _version, ...commentData } = comment;
        const response = successResponse(commentData);
        return withCacheControl(response, 'private, no-cache');
    } catch (error) {
        console.error('Error fetching comment:', error);
        return apiErrors.internalError('Failed to fetch comment');
    }
}

// PATCH /api/comments/[commentId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { commentId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const comment = await db.comment.findUnique({
            where: { id: commentId },
            include: {
                version: {
                    include: {
                        video: {
                            include: {
                                project: {
                                    include: {
                                        members: { where: { userId: session.user.id } },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (!comment) {
            return apiErrors.notFound('Comment');
        }

        const project = comment.version.video.project;
        const isOwner = project.ownerId === session.user.id;
        const isAuthor = comment.authorId === session.user.id;
        const isMember = project.members.length > 0;

        // Check workspace membership for resolve permissions
        let isWorkspaceMember = false;
        if (!isOwner && !isMember && session.user.id) {
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

        const body = await request.json();
        const { content, isResolved, tagId } = body;

        // Only author can edit content or tag
        if ((content !== undefined || tagId !== undefined) && !isAuthor) {
            return apiErrors.forbidden('Only the author can edit comment content');
        }

        // Owner, author, members, or workspace members can resolve/unresolve
        if (isResolved !== undefined && !isOwner && !isAuthor && !isMember && !isWorkspaceMember) {
            return apiErrors.forbidden('Access denied');
        }

        const updateData: Record<string, unknown> = {};
        if (content !== undefined && typeof content === 'string') updateData.content = content.trim();
        if (tagId !== undefined) updateData.tagId = tagId;
        if (isResolved !== undefined) {
            updateData.isResolved = isResolved;
            updateData.resolvedAt = isResolved ? new Date() : null;
        }

        const updatedComment = await db.comment.update({
            where: { id: commentId },
            data: updateData,
            include: {
                author: { select: { id: true, name: true, image: true } },
                tag: { select: { id: true, name: true, color: true } },
                replies: {
                    include: {
                        author: { select: { id: true, name: true, image: true } },
                        tag: { select: { id: true, name: true, color: true } },
                    },
                },
            },
        });

        const response = successResponse(updatedComment);
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error updating comment:', error);
        return apiErrors.internalError('Failed to update comment');
    }
}

// DELETE /api/comments/[commentId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { commentId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const comment = await db.comment.findUnique({
            where: { id: commentId },
            include: {
                replies: { select: { voiceUrl: true, imageUrl: true } },
            },
        });

        if (!comment) {
            return apiErrors.notFound('Comment');
        }

        const isAuthor = comment.authorId === session.user.id;

        if (!isAuthor) {
            return apiErrors.forbidden('You can only delete your own comments');
        }

        // Collect all media URLs to delete from R2 (comment + its replies)
        const mediaUrls: string[] = [];
        if (comment.voiceUrl) mediaUrls.push(comment.voiceUrl);
        if (comment.imageUrl) mediaUrls.push(comment.imageUrl);
        for (const reply of comment.replies) {
            if (reply.voiceUrl) mediaUrls.push(reply.voiceUrl);
            if (reply.imageUrl) mediaUrls.push(reply.imageUrl);
        }

        await db.comment.delete({ where: { id: commentId } });

        // Clean up media files from R2 (best-effort, don't block on failure)
        const AUDIO_PREFIX = '/api/upload/audio/';
        const IMAGE_PREFIX = '/api/upload/image/';
        for (const url of mediaUrls) {
            try {
                // Extract filename using string parsing (safe against ReDoS)
                let key: string | null = null;
                if (url.includes(AUDIO_PREFIX)) {
                    const filename = url.slice(url.indexOf(AUDIO_PREFIX) + AUDIO_PREFIX.length);
                    if (filename) key = `voice/${filename}`;
                } else if (url.includes(IMAGE_PREFIX)) {
                    const filename = url.slice(url.indexOf(IMAGE_PREFIX) + IMAGE_PREFIX.length);
                    if (filename) key = `images/${filename}`;
                }

                if (key) {
                    await r2Client.send(
                        new DeleteObjectCommand({
                            Bucket: R2_BUCKET_NAME,
                            Key: key,
                        })
                    );
                }
            } catch (err) {
                console.error('Failed to delete audio from R2:', err);
            }
        }

        const response = successResponse({ message: 'Comment deleted' });
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error deleting comment:', error);
        return apiErrors.internalError('Failed to delete comment');
    }
}
