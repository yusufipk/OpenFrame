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
            include: {
                author: { select: { id: true, name: true, image: true } },
                replies: {
                    orderBy: { createdAt: 'asc' },
                    include: {
                        author: { select: { id: true, name: true, image: true } },
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

        if (!isOwner && !isMember && !isPublic) {
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

        const body = await request.json();
        const { content, isResolved } = body;

        // Only author can edit content
        if (content !== undefined && !isAuthor) {
            return apiErrors.forbidden('Only the author can edit comment content');
        }

        // Owner, author, or members can resolve/unresolve
        if (isResolved !== undefined && !isOwner && !isAuthor && !isMember) {
            return apiErrors.forbidden('Access denied');
        }

        const updateData: Record<string, unknown> = {};
        if (content !== undefined) updateData.content = content.trim();
        if (isResolved !== undefined) {
            updateData.isResolved = isResolved;
            updateData.resolvedAt = isResolved ? new Date() : null;
        }

        const updatedComment = await db.comment.update({
            where: { id: commentId },
            data: updateData,
            include: {
                author: { select: { id: true, name: true, image: true } },
                replies: {
                    include: {
                        author: { select: { id: true, name: true, image: true } },
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
                replies: { select: { voiceUrl: true } },
                version: {
                    include: {
                        video: { include: { project: true } },
                    },
                },
            },
        });

        if (!comment) {
            return apiErrors.notFound('Comment');
        }

        const isOwner = comment.version.video.project.ownerId === session.user.id;
        const isAuthor = comment.authorId === session.user.id;

        if (!isOwner && !isAuthor) {
            return apiErrors.forbidden('Only the author or project owner can delete this comment');
        }

        // Collect all voice URLs to delete from R2 (comment + its replies)
        const voiceUrls: string[] = [];
        if (comment.voiceUrl) voiceUrls.push(comment.voiceUrl);
        for (const reply of comment.replies) {
            if (reply.voiceUrl) voiceUrls.push(reply.voiceUrl);
        }

        await db.comment.delete({ where: { id: commentId } });

        // Clean up audio files from R2 (best-effort, don't block on failure)
        const AUDIO_PREFIX = '/api/upload/audio/';
        for (const url of voiceUrls) {
            try {
                // Extract filename using string parsing (safe against ReDoS)
                const idx = url.indexOf(AUDIO_PREFIX);
                const filename = idx !== -1 ? url.slice(idx + AUDIO_PREFIX.length) : null;
                if (filename) {
                    await r2Client.send(
                        new DeleteObjectCommand({
                            Bucket: R2_BUCKET_NAME,
                            Key: `voice/${filename}`,
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
