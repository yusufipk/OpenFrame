import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { checkVideoAccess } from '@/lib/content-access';
import { db } from '@/lib/db';
import { ensureGuestIdentityFromRequest } from '@/lib/guest-identity';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { validateShareLinkAccess } from '@/lib/share-links';
import { liveReviewEnabled } from './config';

export interface LiveViewer {
  userId: string | null;
  guestIdentityId: string | null;
  shareToken: string | null;
  name: string;
  hasAccess: boolean;
  canComment: boolean;
  canStart: boolean;
  setGuestCookie: boolean;
}

export async function resolveLiveViewer(
  request: NextRequest,
  videoId: string,
  guestName?: string
): Promise<LiveViewer> {
  const session = await auth();
  const userId = session?.user?.id ?? null;
  const access = await checkVideoAccess(videoId, userId ?? undefined);
  const shareSession = getShareSessionFromRequest(request, videoId);
  const shareAccess =
    shareSession && access.video
      ? await validateShareLinkAccess({
          token: shareSession.token,
          projectId: access.video.projectId,
          videoId,
          requiredPermission: 'VIEW',
          passwordVerified: shareSession.passwordVerified,
        })
      : null;
  const hasAccess =
    access.hasAccess || Boolean(shareAccess?.hasAccess && (userId || shareAccess.allowGuests));
  const guest = !userId && hasAccess ? ensureGuestIdentityFromRequest(request) : null;
  return {
    userId,
    guestIdentityId: guest?.identityId ?? null,
    shareToken: shareAccess?.hasAccess ? (shareSession?.token ?? null) : null,
    name: userId
      ? session?.user?.name?.trim().slice(0, 80) || 'Member'
      : guestName?.trim().slice(0, 80) || 'Guest',
    hasAccess,
    canComment: access.hasAccess || Boolean(shareAccess?.hasAccess && shareAccess.canComment),
    canStart: Boolean(userId && access.canEdit),
    setGuestCookie: guest?.shouldSetCookie ?? false,
  };
}

export async function refreshLiveParticipantAccess(participantId: string): Promise<{
  allowed: boolean;
  canComment: boolean;
  isManager: boolean;
  sessionId: string | null;
}> {
  if (!liveReviewEnabled()) {
    return { allowed: false, canComment: false, isManager: false, sessionId: null };
  }
  const participant = await db.liveReviewParticipant.findUnique({
    where: { id: participantId },
    include: { session: { include: { video: true } } },
  });
  if (!participant || participant.session.status !== 'active')
    return { allowed: false, canComment: false, isManager: false, sessionId: null };
  const { session } = participant;
  const version = await db.videoVersion.findFirst({
    where: { id: session.versionId, videoParentId: session.videoId },
  });
  if (!version || !['bunny', 'r2'].includes(version.providerId))
    return { allowed: false, canComment: false, isManager: false, sessionId: session.id };
  const access = await checkVideoAccess(session.videoId, participant.userId ?? undefined);
  let shareAccess = null;
  if (participant.shareToken) {
    shareAccess = await validateShareLinkAccess({
      token: participant.shareToken,
      projectId: session.video.projectId,
      videoId: session.videoId,
      requiredPermission: 'VIEW',
      passwordVerified: true,
    });
  }
  const allowed = Boolean(
    access.hasAccess || (shareAccess?.hasAccess && (participant.userId || shareAccess.allowGuests))
  );
  const canComment = allowed && Boolean(access.hasAccess || shareAccess?.canComment);
  const isManager =
    allowed &&
    participant.isManager &&
    participant.userId === session.managerUserId &&
    Boolean(access.canEdit);
  return { allowed, canComment, isManager, sessionId: session.id };
}
