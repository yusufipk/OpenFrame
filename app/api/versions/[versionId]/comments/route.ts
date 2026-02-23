import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { notifyProjectOwner } from '@/lib/notifications';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';

type RouteParams = { params: Promise<{ versionId: string }> };
const SAFE_IMAGE_PATH = /^\/api\/upload\/image\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;
const SAFE_AUDIO_PATH = /^\/api\/upload\/audio\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;

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
        const shareSession = getShareSessionFromRequest(request, version.video.id);
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

        const shareAccess = shareSession
            ? await validateShareLinkAccess({
                token: shareSession.token,
                projectId: project.id,
                videoId: version.video.id,
                requiredPermission: 'VIEW',
                passwordVerified: shareSession.passwordVerified,
            })
            : { hasAccess: false, requiresPassword: false };

        if (!isOwner && !isMember && !isPublic && !isWorkspaceMember && !shareAccess.hasAccess) {
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
        const shareSession = getShareSessionFromRequest(request, version.video.id);
        const isOwner = session?.user?.id === project.ownerId;
        const isMember = project.members.length > 0;
        const isPublic = project.visibility === 'PUBLIC';

        // Check workspace membership for comment access
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

        const shareAccess = shareSession
            ? await validateShareLinkAccess({
                token: shareSession.token,
                projectId: project.id,
                videoId: version.video.id,
                requiredPermission: 'COMMENT',
                passwordVerified: shareSession.passwordVerified,
            })
            : { hasAccess: false, canComment: false, allowGuests: false, requiresPassword: false };

        // Check if user can comment
        const canComment = isOwner || isMember || isPublic || isWorkspaceMember || shareAccess.canComment;
        if (!canComment) {
            return apiErrors.forbidden('Access denied');
        }

        const body = await request.json();
        const { content, timestamp, timestampEnd, parentId, voiceUrl, voiceDuration, guestName, guestEmail, tagId, imageUrl, annotationData } = body;

        // Validate required fields
        if (timestamp === undefined || timestamp === null) {
            return apiErrors.badRequest('Timestamp is required');
        }

        const parsedTimestamp = parseFloat(timestamp);
        if (isNaN(parsedTimestamp)) {
            return apiErrors.badRequest('Timestamp must be a valid number');
        }

        if (!content && !voiceUrl && !imageUrl && !annotationData) {
            return apiErrors.badRequest('Either content, a voice recording, an image attachment, or an annotation is required');
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
        if (isGuest && shareAccess.hasAccess && !shareAccess.allowGuests) {
            return apiErrors.forbidden('This share link requires sign in to comment');
        }
        if (isGuest && !guestName) {
            return apiErrors.badRequest('Guest name is required for guest comments');
        }

        if (voiceUrl && !SAFE_AUDIO_PATH.test(voiceUrl)) {
            return apiErrors.badRequest('Voice URL must reference an uploaded audio file');
        }

        if (imageUrl && !SAFE_IMAGE_PATH.test(imageUrl)) {
            return apiErrors.badRequest('Image URL must reference an uploaded image file');
        }

        const comment = await db.comment.create({
            data: {
                content: content?.trim() || null,
                timestamp: parsedTimestamp,
                timestampEnd: timestampEnd ? parseFloat(timestampEnd) : null,
                parentId: parentId || null,
                voiceUrl: voiceUrl || null,
                voiceDuration: voiceDuration || null,
                imageUrl: imageUrl || null,
                annotationData: annotationData || null,
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
                    replyText: content?.trim() || (imageUrl ? '(image attachment)' : '(voice note)'),
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
                    commentText: content?.trim() || (imageUrl ? '(image attachment)' : '(voice note)'),
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
