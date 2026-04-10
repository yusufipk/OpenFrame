import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { rateLimit } from '@/lib/rate-limit';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { getGuestIdentityFromRequest } from '@/lib/guest-identity';
import { runWithConcurrency } from '@/lib/async-pool';
import { validateAnnotationStrokes } from '@/lib/validation';
import { logError } from '@/lib/logger';

const CLEANUP_DELETE_CONCURRENCY = 5;

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
                                project: true,
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
        const access = await checkProjectAccess(project, session?.user?.id);

        if (!access.hasAccess) {
            return apiErrors.forbidden('Access denied');
        }

        // Strip internal project data from response
        const commentData = { ...comment } as Omit<typeof comment, 'version'> & { version?: unknown };
        delete commentData.version;
        const response = successResponse(commentData);
        return withCacheControl(response, 'private, no-cache');
    } catch (error) {
        logError('Error fetching comment:', error);
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
        const body = await request.json();
        const { content, isResolved, tagId, annotationData } = body;

        const comment = await db.comment.findUnique({
            where: { id: commentId },
            include: {
                version: {
                    include: {
                        video: {
                            include: {
                                project: true,
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
        const userId = session?.user?.id ?? null;
        const access = await checkProjectAccess(project, userId ?? undefined, { intent: 'manage' });
        const isOwner = userId === project.ownerId;
        const isAuthor = !!userId && comment.authorId === userId;
        const guestIdentityId = !userId ? getGuestIdentityFromRequest(request) : null;
        const isGuestAuthor = !userId
            && !comment.authorId
            && !!comment.guestIdentityId
            && guestIdentityId === comment.guestIdentityId;
        const canEditOwnContent = isAuthor || isGuestAuthor;
        const canResolveComment = access.canEdit;

        if (!userId && !isGuestAuthor) {
            const shareSession = getShareSessionFromRequest(request, comment.version.video.id);
            const shareAccess = shareSession
                ? await validateShareLinkAccess({
                    token: shareSession.token,
                    projectId: project.id,
                    videoId: comment.version.video.id,
                    requiredPermission: 'COMMENT',
                    passwordVerified: shareSession.passwordVerified,
                })
                : { hasAccess: false, canComment: false, canDownload: false, allowGuests: false, requiresPassword: false };
            const hasGuestAccess = project.visibility === 'PUBLIC' || (shareAccess.canComment && shareAccess.allowGuests);
            if (!hasGuestAccess) {
                return apiErrors.forbidden('Access denied');
            }
        }

        // Only author can edit content or tag
        if ((content !== undefined || tagId !== undefined || annotationData !== undefined) && !canEditOwnContent) {
            return apiErrors.forbidden('Only the author can edit comment content');
        }

        // Owner, author, members, or workspace members can resolve/unresolve
        if (isResolved !== undefined && !canResolveComment) {
            return apiErrors.forbidden('Only admins can resolve comments');
        }

        const updateData: Record<string, unknown> = {};
        if (content !== undefined && typeof content === 'string') updateData.content = content.trim();
        if (tagId !== undefined) updateData.tagId = tagId;
        if (annotationData !== undefined) {
            if (annotationData === null) {
                updateData.annotationData = null;
            } else {
                const validStrokes = validateAnnotationStrokes(annotationData);
                if (validStrokes === null) {
                    return apiErrors.badRequest('annotationData must be an array of valid stroke objects');
                }
                updateData.annotationData = JSON.stringify(validStrokes);
            }
        }
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

        const updatedCommentData = Object.fromEntries(
            Object.entries(updatedComment).filter(([key]) => key !== 'guestIdentityId')
        );
        const response = successResponse({
            ...updatedCommentData,
            canEdit: canEditOwnContent,
            canDelete: canEditOwnContent || isOwner,
            replies: updatedComment.replies.map((reply) => {
                const canEditReply = !!userId
                    ? reply.authorId === userId
                    : !!guestIdentityId
                    && !reply.authorId
                    && !!reply.guestIdentityId
                    && reply.guestIdentityId === guestIdentityId;
                const replyData = Object.fromEntries(
                    Object.entries(reply).filter(([key]) => key !== 'guestIdentityId')
                );
                return {
                    ...replyData,
                    canEdit: canEditReply,
                    canDelete: canEditReply || isOwner,
                };
            }),
        });
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        logError('Error updating comment:', error);
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

        const comment = await db.comment.findUnique({
            where: { id: commentId },
            include: {
                version: {
                    include: {
                        video: {
                            include: {
                                project: true,
                            },
                        },
                    },
                },
                replies: { select: { voiceUrl: true, imageUrl: true } },
            },
        });

        if (!comment) {
            return apiErrors.notFound('Comment');
        }

        const userId = session?.user?.id ?? null;
        const isAuthor = !!userId && comment.authorId === userId;

        let canDeleteOwnComment = isAuthor;
        if (!userId) {
            const guestIdentityId = getGuestIdentityFromRequest(request);
            const isGuestAuthor = !comment.authorId
                && !!comment.guestIdentityId
                && guestIdentityId === comment.guestIdentityId;

            if (isGuestAuthor) {
                const project = comment.version.video.project;
                const shareSession = getShareSessionFromRequest(request, comment.version.video.id);
                const shareAccess = shareSession
                    ? await validateShareLinkAccess({
                        token: shareSession.token,
                        projectId: project.id,
                        videoId: comment.version.video.id,
                        requiredPermission: 'COMMENT',
                        passwordVerified: shareSession.passwordVerified,
                    })
                    : { hasAccess: false, canComment: false, canDownload: false, allowGuests: false, requiresPassword: false };
                const hasGuestAccess = project.visibility === 'PUBLIC' || (shareAccess.canComment && shareAccess.allowGuests);
                if (!hasGuestAccess) {
                    return apiErrors.forbidden('Access denied');
                }
                canDeleteOwnComment = true;
            }
        }

        if (!canDeleteOwnComment) {
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
        const mediaKeys = [...new Set(mediaUrls.map((url) => {
            // Extract filename using string parsing (safe against ReDoS)
            if (url.includes(AUDIO_PREFIX)) {
                const filename = url.slice(url.indexOf(AUDIO_PREFIX) + AUDIO_PREFIX.length);
                return filename ? `voice/${filename}` : null;
            }
            if (url.includes(IMAGE_PREFIX)) {
                const filename = url.slice(url.indexOf(IMAGE_PREFIX) + IMAGE_PREFIX.length);
                return filename ? `images/${filename}` : null;
            }
            return null;
        }).filter((key): key is string => Boolean(key)))];

        await runWithConcurrency(mediaKeys, CLEANUP_DELETE_CONCURRENCY, async (key) => {
            try {
                await r2Client.send(
                    new DeleteObjectCommand({
                        Bucket: R2_BUCKET_NAME,
                        Key: key,
                    })
                );
            } catch (err) {
                logError(`Failed to delete media from R2 (key: ${key}):`, err);
            }
        });

        const response = successResponse({ message: 'Comment deleted' });
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        logError('Error deleting comment:', error);
        return apiErrors.internalError('Failed to delete comment');
    }
}
