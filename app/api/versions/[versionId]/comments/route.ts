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
import {
  ensureGuestIdentityFromRequest,
  getGuestIdentityFromRequest,
  setGuestIdentityCookie,
} from '@/lib/guest-identity';
import {
  extractImageFileNameFromProxyUrl,
  extractAudioFileNameFromProxyUrl,
  sanitizeAssetDisplayName,
} from '@/lib/video-assets';
import { validateAnnotationStrokes } from '@/lib/validation';
import { logError } from '@/lib/logger';
import { reserveStorageQuota, releaseStorageReservation } from '@/lib/storage-quota';

type RouteParams = { params: Promise<{ versionId: string }> };
const SAFE_IMAGE_PATH =
  /^\/api\/upload\/image\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;
const SAFE_AUDIO_PATH =
  /^\/api\/upload\/audio\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;
const UNATTACHED_UPLOAD_TTL_MS = 15 * 60 * 1000;

type AttachmentCheck = { isFresh: boolean; sizeBytes: bigint };

async function isFreshAttachment(url: string, kind: 'audio' | 'image'): Promise<AttachmentCheck> {
  const prefix = kind === 'audio' ? '/api/upload/audio/' : '/api/upload/image/';
  if (!url.startsWith(prefix)) return { isFresh: false, sizeBytes: BigInt(0) };

  const filename = url.slice(prefix.length);
  const key = kind === 'audio' ? `voice/${filename}` : `images/${filename}`;

  try {
    const head = await r2Client.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      })
    );
    if (!head.LastModified) return { isFresh: false, sizeBytes: BigInt(0) };
    const isFresh = Date.now() - head.LastModified.getTime() <= UNATTACHED_UPLOAD_TTL_MS;
    return { isFresh, sizeBytes: BigInt(head.ContentLength ?? 0) };
  } catch {
    return { isFresh: false, sizeBytes: BigInt(0) };
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
    const offset = Math.min(Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10)), 50000);

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
      const matches = ifNoneMatch.split(',').map(normalizeEtag).includes(normalizeEtag(etag));

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
    logError('Error fetching comments:', error);
    return apiErrors.internalError('Failed to fetch comments');
  }
}

// POST /api/versions/[versionId]/comments
export async function POST(request: NextRequest, { params }: RouteParams) {
  let attachmentReservationId: string | null = null;
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
      : {
          hasAccess: false,
          canComment: false,
          canDownload: false,
          allowGuests: false,
          requiresPassword: false,
        };

    // Check if user can comment
    const canComment = access.hasAccess || shareAccess.canComment;
    if (!canComment) {
      return apiErrors.forbidden('Access denied');
    }

    const body = await request.json();
    const {
      content,
      timestamp,
      timestampEnd,
      parentId,
      voiceUrl,
      voiceDuration,
      guestName,
      guestEmail,
      tagId,
      imageUrl,
      annotationData,
    } = body;

    // Validate required fields
    if (timestamp === undefined || timestamp === null) {
      return apiErrors.badRequest('Timestamp is required');
    }

    const parsedTimestamp = parseFloat(timestamp);
    if (isNaN(parsedTimestamp)) {
      return apiErrors.badRequest('Timestamp must be a valid number');
    }

    if (!content && !voiceUrl && !imageUrl && !annotationData) {
      return apiErrors.badRequest(
        'Either content, a voice recording, an image attachment, or an annotation is required'
      );
    }

    // Length limits to prevent DB bloat and DoS on export/notification paths
    if (content !== undefined && content !== null && String(content).length > 10_000) {
      return apiErrors.badRequest('Comment content must be 10,000 characters or fewer');
    }
    if (guestName !== undefined && guestName !== null && String(guestName).length > 100) {
      return apiErrors.badRequest('Guest name must be 100 characters or fewer');
    }
    if (guestEmail !== undefined && guestEmail !== null) {
      const emailStr = String(guestEmail);
      if (emailStr.length > 254) {
        return apiErrors.badRequest('Guest email must be 254 characters or fewer');
      }
      // RFC 5321 / HTML5 email pattern — simple but sufficient for a stored-value guard
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRe.test(emailStr)) {
        return apiErrors.badRequest('Guest email must be a valid email address');
      }
    }

    // Validate annotation data structure to prevent prototype pollution and stored XSS.
    // Reject anything that is not a well-formed array of AnnotationStroke objects.
    // The HTTP body is already JSON-parsed by Next.js; double-encoded strings are rejected.
    let serializedAnnotationData: string | null = null;
    if (annotationData !== undefined && annotationData !== null) {
      if (!Array.isArray(annotationData)) {
        return apiErrors.badRequest('annotationData must be an array of valid stroke objects');
      }
      const validStrokes = validateAnnotationStrokes(annotationData);
      if (validStrokes === null) {
        return apiErrors.badRequest('annotationData must be an array of valid stroke objects');
      }
      // Re-serialize to canonical JSON — strips any extra properties from the input.
      serializedAnnotationData = JSON.stringify(validStrokes);
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

    // Verify tag belongs to this project to prevent cross-project tag leakage (IDOR)
    if (tagId) {
      const tag = await db.commentTag.findFirst({
        where: { id: tagId, projectId: project.id },
      });
      if (!tag) {
        return apiErrors.badRequest('Tag not found');
      }
    }

    if (voiceUrl && !SAFE_AUDIO_PATH.test(voiceUrl)) {
      return apiErrors.badRequest('Voice URL must reference an uploaded audio file');
    }
    let voiceSizeBytes = BigInt(0);
    if (voiceUrl) {
      const voiceCheck = await isFreshAttachment(voiceUrl, 'audio');
      if (!voiceCheck.isFresh) {
        return apiErrors.badRequest('Voice upload expired. Please upload again.');
      }
      voiceSizeBytes = voiceCheck.sizeBytes;
    }

    if (imageUrl && !SAFE_IMAGE_PATH.test(imageUrl)) {
      return apiErrors.badRequest('Image URL must reference an uploaded image file');
    }
    let imageSizeBytes = BigInt(0);
    if (imageUrl) {
      const imageCheck = await isFreshAttachment(imageUrl, 'image');
      if (!imageCheck.isFresh) {
        return apiErrors.badRequest('Image upload expired. Please upload again.');
      }
      imageSizeBytes = imageCheck.sizeBytes;
    }

    const guestIdentity = isGuest ? ensureGuestIdentityFromRequest(request) : null;

    // Enforce per-workspace storage quota for any R2 attachments on this comment.
    // Uses the advisory-locked reservation path so concurrent comment submissions
    // see each other's in-flight sizes, eliminating the TOCTOU race.
    const totalAttachmentBytes = voiceSizeBytes + imageSizeBytes;
    if (totalAttachmentBytes > BigInt(0)) {
      const reserveResult = await reserveStorageQuota(
        project.workspace.ownerId,
        totalAttachmentBytes
      );
      if ('error' in reserveResult) return reserveResult.error;
      attachmentReservationId = reserveResult.reservationId;
    }

    // Use a transaction to create both the comment and any asset rows atomically.
    // Consume the reservation inside the transaction so quota is never double-counted.
    const result = await db.$transaction(async (tx) => {
      if (attachmentReservationId) {
        await tx.uploadReservation.deleteMany({
          where: { id: attachmentReservationId, billedUserId: project.workspace.ownerId },
        });
      }
      const comment = await tx.comment.create({
        data: {
          content: content?.trim() || null,
          timestamp: parsedTimestamp,
          timestampEnd: timestampEnd ? parseFloat(timestampEnd) : null,
          parentId: parentId || null,
          voiceUrl: voiceUrl || null,
          voiceDuration: voiceDuration || null,
          imageUrl: imageUrl || null,
          annotationData: serializedAnnotationData,
          authorId: session?.user?.id || null,
          guestName: isGuest ? guestName : null,
          guestEmail: isGuest ? guestEmail : null,
          guestIdentityId: isGuest ? (guestIdentity?.identityId ?? null) : null,
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
            sizeBytes: imageSizeBytes,
            uploadedByUserId: session?.user?.id || null,
            uploadedByGuestIdentityId: isGuest ? (guestIdentity?.identityId ?? null) : null,
            uploadedByGuestName: isGuest ? safeGuestName : null,
            billedUserId: project.workspace.ownerId,
          },
        });
      }

      // If a voice recording was attached, also track it in the assets pane
      if (voiceUrl) {
        const fileName = extractAudioFileNameFromProxyUrl(voiceUrl);
        const displayName = sanitizeAssetDisplayName(null, fileName || 'Voice Comment');
        const safeGuestName = sanitizeAssetDisplayName(guestName, 'Guest').slice(0, 80);

        await tx.videoAsset.create({
          data: {
            videoId: version.video.id,
            kind: 'AUDIO',
            provider: 'R2_AUDIO',
            displayName,
            sourceUrl: voiceUrl,
            sizeBytes: voiceSizeBytes,
            uploadedByUserId: session?.user?.id || null,
            uploadedByGuestIdentityId: isGuest ? (guestIdentity?.identityId ?? null) : null,
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
        }).catch((err) => logError('Notification failed:', err));
      } else {
        notifyProjectOwner(project.ownerId, {
          type: 'new_comment',
          projectName: project.name,
          videoTitle,
          commentAuthor: commentAuthorName,
          commentText: content?.trim() || (imageUrl ? '(image attachment)' : '(voice note)'),
          timestamp: ts,
          url: `${baseUrl}/watch/${version.video.id}`,
        }).catch((err) => logError('Notification failed:', err));
      }
    }

    const viewerUserId = session?.user?.id ?? null;
    const viewerGuestIdentityId = viewerUserId
      ? null
      : (guestIdentity?.identityId ?? getGuestIdentityFromRequest(request));
    const canEditComment = viewerUserId
      ? comment.authorId === viewerUserId
      : !!viewerGuestIdentityId &&
        !!comment.guestIdentityId &&
        comment.guestIdentityId === viewerGuestIdentityId;
    const commentData = Object.fromEntries(
      Object.entries(comment).filter(([key]) => key !== 'guestIdentityId')
    );

    const response = successResponse(
      {
        ...commentData,
        canEdit: canEditComment,
        canDelete: canEditComment || viewerUserId === project.ownerId,
      },
      201
    );
    if (isGuest && guestIdentity?.shouldSetCookie) {
      setGuestIdentityCookie(response, guestIdentity.identityId);
    }
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    await releaseStorageReservation(attachmentReservationId);
    logError('Error creating comment:', error);
    return apiErrors.internalError('Failed to create comment');
  }
}
