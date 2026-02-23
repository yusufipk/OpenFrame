import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { rateLimit } from '@/lib/rate-limit';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { getGuestIdentityFromRequest } from '@/lib/guest-identity';
import { ProjectMemberRole, WorkspaceMemberRole } from '@prisma/client';

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
        const commentData = { ...comment } as Omit<typeof comment, 'version'> & { version?: unknown };
        delete commentData.version;
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
        const body = await request.json();
        const { content, isResolved, tagId, annotationData } = body;

        const comment = await db.comment.findUnique({
            where: { id: commentId },
            include: {
                version: {
                    include: {
                        video: {
                            include: {
                                project: {
                                    include: { members: true },
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
        const userId = session?.user?.id ?? null;
        const isOwner = userId === project.ownerId;
        const isAuthor = !!userId && comment.authorId === userId;
        const projectMembership = userId
            ? project.members.find((member) => member.userId === userId) ?? null
            : null;
        const isProjectAdmin = projectMembership?.role === ProjectMemberRole.ADMIN;
        const guestIdentityId = !userId ? getGuestIdentityFromRequest(request) : null;
        const isGuestAuthor = !userId
            && !comment.authorId
            && !!comment.guestIdentityId
            && guestIdentityId === comment.guestIdentityId;
        const canEditOwnContent = isAuthor || isGuestAuthor;

        // Check workspace role for resolve permissions.
        let workspaceRole: WorkspaceMemberRole | 'OWNER' | null = null;
        if (!isOwner && userId) {
            const wsMember = await db.workspaceMember.findUnique({
                where: {
                    workspaceId_userId: {
                        workspaceId: project.workspaceId,
                        userId,
                    },
                },
            });
            const wsOwner = await db.workspace.findUnique({
                where: { id: project.workspaceId },
                select: { ownerId: true },
            });
            if (wsOwner?.ownerId === userId) {
                workspaceRole = 'OWNER';
            } else if (wsMember) {
                workspaceRole = wsMember.role;
            }
        }
        const isWorkspaceAdmin = workspaceRole === 'OWNER' || workspaceRole === WorkspaceMemberRole.ADMIN;
        const canResolveComment = isOwner || isProjectAdmin || isWorkspaceAdmin;

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
        if (annotationData !== undefined) updateData.annotationData = annotationData;
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

        const { guestIdentityId: _updatedGuestIdentityId, ...updatedCommentData } = updatedComment;
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
                const { guestIdentityId: _replyGuestIdentityId, ...replyData } = reply;
                return {
                    ...replyData,
                    canEdit: canEditReply,
                    canDelete: canEditReply || isOwner,
                };
            }),
        });
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
