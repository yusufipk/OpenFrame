import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { validateOptionalUrl } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { notifyProjectOwner } from '@/lib/notifications';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

type RouteParams = { params: Promise<{ versionId: string }> };

// GET /api/versions/[versionId]/comments
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { versionId } = await params;

        // Get version with project access info
        const version = await db.videoVersion.findUnique({
            where: { id: versionId },
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
        });

        if (!version) {
            return apiErrors.notFound('Version');
        }

        const project = version.video.project;
        const isOwner = session?.user?.id === project.ownerId;
        const isMember = project.members.length > 0;
        const isPublic = project.visibility === 'PUBLIC';

        if (!isOwner && !isMember && !isPublic) {
            return apiErrors.forbidden('Access denied');
        }

        const { searchParams } = new URL(request.url);
        const includeResolved = searchParams.get('includeResolved') !== 'false';

        const comments = await db.comment.findMany({
            where: {
                versionId,
                parentId: null, // Only top-level comments
                ...(includeResolved ? {} : { isResolved: false }),
            },
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
        });

        const response = successResponse({ comments });
        return withCacheControl(response, 'private, no-cache');
    } catch (error) {
        console.error('Error fetching comments:', error);
        return apiErrors.internalError('Failed to fetch comments');
    }
}

// POST /api/versions/[versionId]/comments
export async function POST(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'comment');
        if (limited) return limited;

        const session = await auth();
        const { versionId } = await params;

        const version = await db.videoVersion.findUnique({
            where: { id: versionId },
            include: {
                video: {
                    include: {
                        project: {
                            include: {
                                members: { where: { userId: session?.user?.id || '' } },
                                shareLinks: { where: { permission: 'COMMENT' } },
                            },
                        },
                    },
                },
            },
        });

        if (!version) {
            return apiErrors.notFound('Version');
        }

        const project = version.video.project;
        const isOwner = session?.user?.id === project.ownerId;
        const isMember = project.members.length > 0;
        const hasCommentLink = project.shareLinks.length > 0;
        const isPublic = project.visibility === 'PUBLIC';

        // Check if user can comment
        const canComment = isOwner || isMember || isPublic || hasCommentLink;
        if (!canComment) {
            return apiErrors.forbidden('Access denied');
        }

        const body = await request.json();
        const { content, timestamp, timestampEnd, parentId, voiceUrl, voiceDuration, guestName, guestEmail, tagId } = body;

        // Validate required fields
        if (timestamp === undefined || timestamp === null) {
            return apiErrors.badRequest('Timestamp is required');
        }

        if (!content && !voiceUrl) {
            return apiErrors.badRequest('Either content or voice recording is required');
        }

        // If replying, verify parent exists in same version
        if (parentId) {
            const parent = await db.comment.findFirst({
                where: { id: parentId, versionId },
            });
            if (!parent) {
                return apiErrors.badRequest('Parent comment not found');
            }
        }

        // Guest comment validation
        const isGuest = !session?.user?.id;
        if (isGuest && !guestName) {
            return apiErrors.badRequest('Guest name is required for guest comments');
        }

        // Validate voice URL uses safe scheme (allow internal /api/ paths)
        if (voiceUrl && !voiceUrl.startsWith('/api/')) {
            const voiceUrlError = validateOptionalUrl(voiceUrl, 'Voice URL');
            if (voiceUrlError) {
                return apiErrors.badRequest(voiceUrlError);
            }
        }

        const comment = await db.comment.create({
            data: {
                content: content?.trim() || null,
                timestamp: parseFloat(timestamp),
                timestampEnd: timestampEnd ? parseFloat(timestampEnd) : null,
                parentId: parentId || null,
                voiceUrl: voiceUrl || null,
                voiceDuration: voiceDuration || null,
                authorId: session?.user?.id || null,
                guestName: isGuest ? guestName : null,
                guestEmail: isGuest ? guestEmail : null,
                tagId: tagId || null,
                versionId,
            },
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

        // Notify project owner (fire-and-forget, skip self-notifications)
        const commentAuthorName = session?.user?.name || guestName || 'Someone';
        const isOwnProject = session?.user?.id === project.ownerId;
        if (!isOwnProject) {
            const baseUrl = process.env.NEXTAUTH_URL || '';
            const videoTitle = version.video.title || 'Untitled Video';
            const mins = Math.floor(parseFloat(timestamp) / 60);
            const secs = Math.floor(parseFloat(timestamp) % 60);
            const ts = `${mins}:${secs.toString().padStart(2, '0')}`;

            if (parentId) {
                // It's a reply — look up parent author
                const parentComment = await db.comment.findUnique({
                    where: { id: parentId },
                    include: { author: { select: { name: true } } },
                });
                notifyProjectOwner(project.ownerId, {
                    type: 'new_reply',
                    projectName: project.name,
                    videoTitle,
                    replyAuthor: commentAuthorName,
                    replyText: content?.trim() || '(voice note)',
                    parentAuthor: parentComment?.author?.name || parentComment?.guestName || 'Someone',
                    timestamp: ts,
                    url: `${baseUrl}/watch/${version.video.id}`,
                }).catch((err) => console.error('Notification failed:', err));
            } else {
                notifyProjectOwner(project.ownerId, {
                    type: 'new_comment',
                    projectName: project.name,
                    videoTitle,
                    commentAuthor: commentAuthorName,
                    commentText: content?.trim() || '(voice note)',
                    timestamp: ts,
                    url: `${baseUrl}/watch/${version.video.id}`,
                }).catch((err) => console.error('Notification failed:', err));
            }
        }

        const response = successResponse(comment, 201);
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error creating comment:', error);
        return apiErrors.internalError('Failed to create comment');
    }
}
