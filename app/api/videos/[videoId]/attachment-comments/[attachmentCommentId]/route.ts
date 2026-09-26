import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { checkVideoAccess } from '@/lib/content-access';
import { db } from '@/lib/db';
import { getGuestIdentityFromRequest } from '@/lib/guest-identity';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { validateShareLinkAccess } from '@/lib/share-links';

type RouteParams = { params: Promise<{ videoId: string; attachmentCommentId: string }> };

const commentSelect = {
  id: true,
  authorId: true,
  guestIdentityId: true,
  asset: { select: { videoId: true } },
  sourceComment: { select: { version: { select: { videoParentId: true } } } },
} as const;

function belongsToVideo(
  comment: {
    asset: { videoId: string } | null;
    sourceComment: { version: { videoParentId: string } } | null;
  },
  videoId: string
): boolean {
  return (
    comment.asset?.videoId === videoId || comment.sourceComment?.version.videoParentId === videoId
  );
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'comment');
    if (limited) return limited;
    const { videoId, attachmentCommentId } = await params;
    const userId = (await auth())?.user?.id;
    const video = await db.video.findUnique({
      where: { id: videoId },
      select: { projectId: true },
    });
    if (!video) return apiErrors.notFound('Video');
    const direct = await checkVideoAccess(videoId, userId);
    const shareSession = getShareSessionFromRequest(request, videoId);
    const shared = shareSession
      ? await validateShareLinkAccess({
          token: shareSession.token,
          projectId: video.projectId,
          videoId,
          requiredPermission: 'COMMENT',
          passwordVerified: shareSession.passwordVerified,
        })
      : null;
    if (!direct.hasAccess && !shared?.canComment) return apiErrors.forbidden('Access denied');
    if (!userId && !direct.hasAccess && !shared?.allowGuests)
      return apiErrors.forbidden('Sign in required to comment');

    const existing = await db.attachmentComment.findUnique({
      where: { id: attachmentCommentId },
      select: commentSelect,
    });
    if (!existing || !belongsToVideo(existing, videoId))
      return apiErrors.notFound('Attachment comment');
    const guestIdentityId = userId ? null : getGuestIdentityFromRequest(request);
    const canDelete =
      direct.canEdit ||
      Boolean(userId && existing.authorId === userId) ||
      Boolean(!userId && guestIdentityId && existing.guestIdentityId === guestIdentityId);
    if (!canDelete)
      return apiErrors.forbidden('Only the author or an admin can delete this comment');

    const result = await db.$transaction(async (tx) => {
      const freshVideo = await tx.video.findUnique({
        where: { id: videoId },
        select: { projectId: true },
      });
      if (!freshVideo || freshVideo.projectId !== video.projectId) return 'forbidden' as const;
      const freshDirect = await checkVideoAccess(videoId, userId, tx);
      const freshShare = shareSession
        ? await tx.shareLink.findUnique({
            where: { token: shareSession.token },
            select: {
              projectId: true,
              videoId: true,
              permission: true,
              allowGuests: true,
              expiresAt: true,
              passwordHash: true,
            },
          })
        : null;
      const shareCanComment = Boolean(
        freshShare &&
        freshShare.projectId === video.projectId &&
        freshShare.videoId === videoId &&
        freshShare.permission === 'COMMENT' &&
        (!freshShare.expiresAt || freshShare.expiresAt.getTime() > Date.now()) &&
        (!freshShare.passwordHash || shareSession?.passwordVerified) &&
        (userId || freshShare.allowGuests)
      );
      if (!freshDirect.hasAccess && !(shareCanComment && freshDirect.ownerBillingActive))
        return 'forbidden' as const;
      const freshComment = await tx.attachmentComment.findUnique({
        where: { id: attachmentCommentId },
        select: commentSelect,
      });
      if (!freshComment || !belongsToVideo(freshComment, videoId)) return 'notfound' as const;
      const freshCanDelete =
        freshDirect.canEdit ||
        Boolean(userId && freshComment.authorId === userId) ||
        Boolean(!userId && guestIdentityId && freshComment.guestIdentityId === guestIdentityId);
      if (!freshCanDelete) return 'forbidden' as const;
      await tx.attachmentComment.delete({ where: { id: attachmentCommentId } });
      return 'deleted' as const;
    });
    if (result === 'notfound') return apiErrors.notFound('Attachment comment');
    if (result === 'forbidden') return apiErrors.forbidden('Access denied');
    return withCacheControl(
      successResponse({ message: 'Attachment comment deleted' }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error deleting attachment comment:', error);
    return apiErrors.internalError('Failed to delete attachment comment');
  }
}
