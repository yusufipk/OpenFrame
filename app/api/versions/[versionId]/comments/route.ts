import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth, computeProjectAccess, projectAccessInclude } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { notifyProjectOwner } from '@/lib/notifications';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { ensureGuestIdentityFromRequest, getGuestIdentityFromRequest, setGuestIdentityCookie } from '@/lib/guest-identity';
import { extractImageFileNameFromProxyUrl, sanitizeAssetDisplayName } from '@/lib/video-assets';

type RouteParams = { params: Promise<{ versionId: string }> };
const SAFE_IMAGE_PATH = /^\/api\/upload\/image\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;
const SAFE_AUDIO_PATH = /^\/api\/upload\/audio\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;
const UNATTACHED_UPLOAD_TTL_MS = 15 * 60 * 1000;

async function isFreshAttachment(url: string, kind: 'audio' | 'image'): Promise<boolean> {
    const prefix = kind === 'audio' ? '/api/upload/audio/' : '/api/upload/image/';
    if (!url.startsWith(prefix)) return false;

    const filename = url.slice(prefix.length);
    const key = kind === 'audio' ? `voice/${filename}` : `images/${filename}`;

    try {
        const head = await r2Client.send(
            new HeadObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: key,
            })
        );
        if (!head.LastModified) return false;
        return Date.now() - head.LastModified.getTime() <= UNATTACHED_UPLOAD_TTL_MS;
    } catch {
        return false;
    }
}

function normalizeEtag(value: string): string {
    return value.trim().replace(/^W\//, '');
}

// GET /api/versions/[versionId]/comments
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { versionId } = await params;
        const userId = session?.user?.id;

        // Get version with project access data pre-fetched in the same query
        const version = await db.videoVersion.findUnique({
            where: { id: versionId },
            include: {
                video: {
                    include: {
                        project: { include: projectAccessInclude(userId) },
                    },
                },
            },
        });

        if (!version) {
            return apiErrors.notFound('Version');
        }

        const project = version.video.project;
        const access = computeProjectAccess(project, userId);
        const shareSession = getShareSessionFromRequest(request, version.video.id);

        const shareAccess = shareSession
            ? await validateShareLinkAccess({
                token: shareSession.token,
                projectId: project.id,
                videoId: version.video.id,
                requiredPermission: 'VIEW',
                passwordVerified: shareSession.passwordVerified,
            })
            : { hasAccess: false, requiresPassword: false };

        if (!access.hasAccess && !shareAccess.hasAccess) {
            return apiErrors.forbidden('Access denied');
        }

        const { searchParams } = new URL(request.url);
        const includeResolved = searchParams.get('includeResolved') !== 'false';
        const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') ?? '200', 10)), 500);
        const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10));

        const commentsFilter = {
            versionId,
            parentId: null as null,
            ...(includeResolved ? {} : { isResolved: false }),
        };

        const [commentsRevision, total] = await Promise.all([
            db.comment.aggregate({
                where: { versionId, ...(includeResolved ? {} : { isResolved: false }) },
                _count: { id: true },
                _max: { updatedAt: true },
            }),
            db.comment.count({ where: commentsFilter }),
        ]);

        const etag = `"comments:${versionId}:${includeResolved ? 1 : 0}:${commentsRevision._count.id}:${commentsRevision._max.updatedAt?.getTime() ?? 0}"`;
        const ifNoneMatch = request.headers.get('if-none-match');
        if (ifNoneMatch) {
            const matches = ifNoneMatch
                .split(',')
                .map(normalizeEtag)
                .includes(normalizeEtag(etag));

            if (matches) {
                const notModified = new NextResponse(null, { status: 304 });
                notModified.headers.set('ETag', etag);
                return withCacheControl(notModified, 'private, no-cache');
            }
        }

        const comments = await db.comment.findMany({
            where: commentsFilter,
            orderBy: { timestamp: 'asc' },
            skip: offset,
            take: limit,
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

        const response = successResponse({
            comments,
            total,
            hasMore: offset + comments.length < total,
            offset,
            limit,
        });
        response.headers.set('ETag', etag);
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
        const userId = session?.user?.id;

        const version = await db.videoVersion.findUnique({
            where: { id: versionId },
            include: {
                video: {
                    include: {
                        project: {
                            include: {
                                ...projectAccessInclude(userId),
                                // workspace.select is already included by projectAccessInclude;
                                // ownerId is present on workspace via projectAccessInclude
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
        const access = computeProjectAccess(project, userId);
        const shareSession = getShareSessionFromRequest(request, version.video.id);

        const shareAccess = shareSession
            ? await validateShareLinkAccess({
                token: shareSession.token,
                projectId: project.id,
                videoId: version.video.id,
                requiredPermission: 'COMMENT',
                passwordVerified: shareSession.passwordVerified,
            })
            : { hasAccess: false, canComment: false, canDownload: false, allowGuests: false, requiresPassword: false };

        // Check if user can comment
        const canComment = access.hasAccess || shareAccess.canComment;
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
        if (voiceUrl && !(await isFreshAttachment(voiceUrl, 'audio'))) {
            return apiErrors.badRequest('Voice upload expired. Please upload again.');
        }

        if (imageUrl && !SAFE_IMAGE_PATH.test(imageUrl)) {
            return apiErrors.badRequest('Image URL must reference an uploaded image file');
        }
        if (imageUrl && !(await isFreshAttachment(imageUrl, 'image'))) {
            return apiErrors.badRequest('Image upload expired. Please upload again.');
        }

        const guestIdentity = isGuest ? ensureGuestIdentityFromRequest(request) : null;

        // Use a transaction to create both comment and asset (if image is attached)
        const result = await db.$transaction(async (tx) => {
            const comment = await tx.comment.create({
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
                    guestIdentityId: isGuest ? guestIdentity?.identityId ?? null : null,
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

            // If an image was attached to the comment, also add it to the assets pane
            if (imageUrl) {
                const fileName = extractImageFileNameFromProxyUrl(imageUrl);
                const displayName = sanitizeAssetDisplayName(null, fileName || 'Comment Image');
                const safeGuestName = sanitizeAssetDisplayName(guestName, 'Guest').slice(0, 80);
                
                await tx.videoAsset.create({
                    data: {
                        videoId: version.video.id,
                        kind: 'IMAGE',
                        provider: 'R2_IMAGE',
                        displayName,
                        sourceUrl: imageUrl,
                        thumbnailUrl: imageUrl,
                        uploadedByUserId: session?.user?.id || null,
                        uploadedByGuestIdentityId: isGuest ? guestIdentity?.identityId ?? null : null,
                        uploadedByGuestName: isGuest ? safeGuestName : null,
                        billedUserId: project.workspace.ownerId,
                    },
                });
            }

            return comment;
        });

        const comment = result;

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

        const viewerUserId = session?.user?.id ?? null;
        const viewerGuestIdentityId = viewerUserId
            ? null
            : guestIdentity?.identityId ?? getGuestIdentityFromRequest(request);
        const canEditComment = viewerUserId
            ? comment.authorId === viewerUserId
            : !!viewerGuestIdentityId
            && !!comment.guestIdentityId
            && comment.guestIdentityId === viewerGuestIdentityId;
        const commentData = Object.fromEntries(
            Object.entries(comment).filter(([key]) => key !== 'guestIdentityId')
        );

        const response = successResponse({
            ...commentData,
            canEdit: canEditComment,
            canDelete: canEditComment || viewerUserId === project.ownerId,
        }, 201);
        if (isGuest && guestIdentity?.shouldSetCookie) {
            setGuestIdentityCookie(response, guestIdentity.identityId);
        }
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error creating comment:', error);
        return apiErrors.internalError('Failed to create comment');
    }
}
