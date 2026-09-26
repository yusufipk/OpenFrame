import { checkVideoAccess } from '@/lib/content-access';
import { notifyLiveReviewComments } from '@/lib/live-review/notify';
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
import { runWithConcurrency } from '@/lib/async-pool';
import { validateAnnotationStrokes } from '@/lib/validation';
import { parseCommentImageUrls } from '@/lib/comment-images';
import { isFreshAttachment } from '@/lib/upload-freshness';
import { extractImageFileNameFromProxyUrl, sanitizeAssetDisplayName } from '@/lib/video-assets';
import {
  reserveStorageQuota,
  releaseStorageReservation,
  UPLOAD_RESERVATION_PURPOSES,
} from '@/lib/storage-quota';
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
        images: { select: { id: true, url: true }, orderBy: { position: 'asc' } },
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
            images: { select: { id: true, url: true }, orderBy: { position: 'asc' } },
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
    const access = await checkVideoAccess(comment.version.video.id, session?.user?.id);

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
  // Carried out of the try so the catch below can scope the release to the
  // account the hold was opened against.
  let attachmentReservationId: string | null = null;
  let attachmentBilledUserId: string | null = null;
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
        images: { select: { url: true }, orderBy: { position: 'asc' } },
        version: {
          include: {
            video: {
              include: {
                project: { include: { workspace: { select: { ownerId: true } } } },
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
    const access = await checkVideoAccess(comment.version.video.id, userId ?? undefined);
    const currentShare = getShareSessionFromRequest(request, comment.version.video.id);
    const currentLinkAccess = currentShare
      ? await validateShareLinkAccess({
          token: currentShare.token,
          projectId: project.id,
          videoId: comment.version.video.id,
          requiredPermission: 'COMMENT',
          passwordVerified: currentShare.passwordVerified,
        })
      : null;
    if (!access?.hasAccess && !currentLinkAccess?.canComment)
      return apiErrors.forbidden('Access denied');
    const isOwner = userId === project.ownerId;
    const isAuthor = !!userId && comment.authorId === userId;
    const guestIdentityId = !userId ? getGuestIdentityFromRequest(request) : null;
    const isGuestAuthor =
      !userId &&
      !comment.authorId &&
      !!comment.guestIdentityId &&
      guestIdentityId === comment.guestIdentityId;
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
        : {
            hasAccess: false,
            canComment: false,
            canDownload: false,
            allowGuests: false,
            requiresPassword: false,
          };
      const hasGuestAccess =
        project.visibility === 'PUBLIC' || (shareAccess.canComment && shareAccess.allowGuests);
      if (!hasGuestAccess) {
        return apiErrors.forbidden('Access denied');
      }
    }

    // `imageUrls` (or the legacy `imageUrl`) is the full list the comment should
    // end up with, so anything the caller left out is detached.
    const wantsImageUpdate = body.imageUrls !== undefined || body.imageUrl !== undefined;

    // Only author can edit content, tag or attachments
    if (
      (content !== undefined ||
        tagId !== undefined ||
        annotationData !== undefined ||
        wantsImageUpdate) &&
      !canEditOwnContent
    ) {
      return apiErrors.forbidden('Only the author can edit comment content');
    }

    let desiredImageUrls: string[] = [];
    let removedImageUrls: string[] = [];
    let addedImages: { url: string; sizeBytes: bigint }[] = [];

    if (wantsImageUpdate) {
      const parsedImageUrls = parseCommentImageUrls(body);
      if ('error' in parsedImageUrls) {
        return apiErrors.badRequest(parsedImageUrls.error);
      }
      desiredImageUrls = parsedImageUrls.urls;

      const existingUrls = comment.images.map((image) => image.url);
      const addedUrls = desiredImageUrls.filter((url) => !existingUrls.includes(url));
      removedImageUrls = existingUrls.filter((url) => !desiredImageUrls.includes(url));

      if (addedUrls.length > 0) {
        // A file that already hangs off another comment would trip the unique
        // index mid-transaction, so refuse it here and answer with a 400.
        const alreadyClaimed = await db.commentImage.findFirst({
          where: { url: { in: addedUrls } },
          select: { id: true },
        });
        if (alreadyClaimed) {
          return apiErrors.badRequest('Image is already attached to another comment');
        }

        const checks = await Promise.all(
          addedUrls.map(async (url) => ({ url, ...(await isFreshAttachment(url, 'image')) }))
        );
        if (checks.some((check) => !check.isFresh)) {
          return apiErrors.badRequest('Image upload expired. Please upload again.');
        }
        addedImages = checks;
      }

      const addedBytes = addedImages.reduce((total, image) => total + image.sizeBytes, BigInt(0));
      if (addedBytes > BigInt(0)) {
        const reserveResult = await reserveStorageQuota(
          project.workspace.ownerId,
          addedBytes,
          UPLOAD_RESERVATION_PURPOSES.ATTACHMENT
        );
        if ('error' in reserveResult) return reserveResult.error;
        attachmentReservationId = reserveResult.reservationId;
        attachmentBilledUserId = project.workspace.ownerId;
      }
    }

    // Owner, author, members, or workspace members can resolve/unresolve
    if (isResolved !== undefined && !canResolveComment) {
      return apiErrors.forbidden('Only admins can resolve comments');
    }

    const updateData: Record<string, unknown> = {};
    if (content !== undefined && typeof content === 'string') updateData.content = content.trim();
    if (tagId !== undefined) {
      // Verify tag belongs to this project to prevent cross-project tag leakage (IDOR)
      if (tagId !== null) {
        const tag = await db.commentTag.findFirst({
          where: { id: tagId, projectId: project.id },
        });
        if (!tag) {
          return apiErrors.badRequest('Tag not found');
        }
      }
      updateData.tagId = tagId;
    }
    if (annotationData !== undefined) {
      if (annotationData === null) {
        updateData.annotationData = null;
      } else {
        if (!Array.isArray(annotationData)) {
          return apiErrors.badRequest('annotationData must be an array of valid stroke objects');
        }
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
    if (wantsImageUpdate) {
      // The legacy column keeps pointing at the first image.
      updateData.imageUrl = desiredImageUrls[0] ?? null;
    }

    const updatedComment = await db.$transaction(async (tx) => {
      // Consume the hold inside the transaction so quota is never double-counted.
      if (attachmentReservationId) {
        await tx.uploadReservation.deleteMany({
          where: {
            id: attachmentReservationId,
            billedUserId: project.workspace.ownerId,
            purpose: UPLOAD_RESERVATION_PURPOSES.ATTACHMENT,
          },
        });
      }

      if (wantsImageUpdate) {
        if (removedImageUrls.length > 0) {
          // Only the link is dropped. The file stays in R2 and in the assets pane,
          // which is where a detached upload is deleted from and where its storage
          // is already accounted for.
          await tx.commentImage.deleteMany({
            where: { commentId, url: { in: removedImageUrls } },
          });
        }

        for (const [index, url] of desiredImageUrls.entries()) {
          const added = addedImages.find((image) => image.url === url);
          if (!added) {
            await tx.commentImage.update({ where: { url }, data: { position: index } });
            continue;
          }

          await tx.commentImage.create({ data: { commentId, url, position: index } });

          const fileName = extractImageFileNameFromProxyUrl(url);
          await tx.videoAsset.create({
            data: {
              videoId: comment.version.video.id,
              kind: 'IMAGE',
              provider: 'R2_IMAGE',
              displayName: sanitizeAssetDisplayName(null, fileName || 'Comment Image'),
              sourceUrl: url,
              thumbnailUrl: url,
              sizeBytes: added.sizeBytes,
              uploadedByUserId: userId,
              uploadedByGuestIdentityId: userId ? null : guestIdentityId,
              uploadedByGuestName: userId
                ? null
                : sanitizeAssetDisplayName(comment.guestName, 'Guest').slice(0, 80),
              billedUserId: project.workspace.ownerId,
            },
          });
        }
      }

      return tx.comment.update({
        where: { id: commentId },
        data: updateData,
        include: {
          author: { select: { id: true, name: true, image: true } },
          tag: { select: { id: true, name: true, color: true } },
          images: { select: { id: true, url: true }, orderBy: { position: 'asc' } },
          replies: {
            include: {
              author: { select: { id: true, name: true, image: true } },
              tag: { select: { id: true, name: true, color: true } },
              images: { select: { id: true, url: true }, orderBy: { position: 'asc' } },
            },
          },
        },
      });
    });

    const updatedCommentData = Object.fromEntries(
      Object.entries(updatedComment).filter(([key]) => key !== 'guestIdentityId')
    );
    await notifyLiveReviewComments(comment.versionId);
    const response = successResponse({
      ...updatedCommentData,
      canEdit: canEditOwnContent,
      canDelete: canEditOwnContent || isOwner,
      replies: updatedComment.replies.map((reply) => {
        const canEditReply = !!userId
          ? reply.authorId === userId
          : !!guestIdentityId &&
            !reply.authorId &&
            !!reply.guestIdentityId &&
            reply.guestIdentityId === guestIdentityId;
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
    await releaseStorageReservation(
      attachmentReservationId,
      attachmentBilledUserId,
      UPLOAD_RESERVATION_PURPOSES.ATTACHMENT
    );
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
        images: { select: { url: true } },
        replies: {
          select: { voiceUrl: true, images: { select: { url: true } } },
        },
      },
    });

    if (!comment) {
      return apiErrors.notFound('Comment');
    }

    const project = comment.version.video.project;
    const userId = session?.user?.id ?? null;
    const isAuthor = !!userId && comment.authorId === userId;

    // Project owners/admins and workspace admins can delete any comment
    const access = userId ? await checkVideoAccess(comment.version.video.id, userId) : null;
    const currentShare = getShareSessionFromRequest(request, comment.version.video.id);
    const currentLinkAccess = currentShare
      ? await validateShareLinkAccess({
          token: currentShare.token,
          projectId: project.id,
          videoId: comment.version.video.id,
          requiredPermission: 'COMMENT',
          passwordVerified: currentShare.passwordVerified,
        })
      : null;
    if (!access?.hasAccess && !currentLinkAccess?.canComment)
      return apiErrors.forbidden('Access denied');
    const isPrivilegedUser = !!access?.canEdit;

    let canDelete = isAuthor || isPrivilegedUser;
    if (!canDelete && !userId) {
      const guestIdentityId = getGuestIdentityFromRequest(request);
      const isGuestAuthor =
        !comment.authorId &&
        !!comment.guestIdentityId &&
        guestIdentityId === comment.guestIdentityId;

      if (isGuestAuthor) {
        const shareSession = getShareSessionFromRequest(request, comment.version.video.id);
        const shareAccess = shareSession
          ? await validateShareLinkAccess({
              token: shareSession.token,
              projectId: project.id,
              videoId: comment.version.video.id,
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
        const hasGuestAccess =
          project.visibility === 'PUBLIC' || (shareAccess.canComment && shareAccess.allowGuests);
        if (!hasGuestAccess) {
          return apiErrors.forbidden('Access denied');
        }
        canDelete = true;
      }
    }

    if (!canDelete) {
      return apiErrors.forbidden('You do not have permission to delete this comment');
    }

    // Collect all media URLs to delete from R2 (comment + its replies)
    const mediaUrls: string[] = [];
    if (comment.voiceUrl) mediaUrls.push(comment.voiceUrl);
    for (const image of comment.images) mediaUrls.push(image.url);
    for (const reply of comment.replies) {
      if (reply.voiceUrl) mediaUrls.push(reply.voiceUrl);
      for (const image of reply.images) mediaUrls.push(image.url);
    }

    await db.comment.delete({ where: { id: commentId } });

    // Clean up media files from R2 (best-effort, don't block on failure)
    const AUDIO_PREFIX = '/api/upload/audio/';
    const IMAGE_PREFIX = '/api/upload/image/';
    const mediaKeys = [
      ...new Set(
        mediaUrls
          .map((url) => {
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
          })
          .filter((key): key is string => Boolean(key))
      ),
    ];

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

    await notifyLiveReviewComments(comment.versionId);
    const response = successResponse({ message: 'Comment deleted' });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error deleting comment:', error);
    return apiErrors.internalError('Failed to delete comment');
  }
}
