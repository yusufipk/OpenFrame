import type { LiveViewer } from './access';
import { db } from '@/lib/db';
import { LIVE_MAX_PARTICIPANTS } from './protocol';

export class LiveRoomError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export async function startLiveRoom(videoId: string, versionId: string, viewer: LiveViewer) {
  if (!viewer.userId || !viewer.canStart) throw new LiveRoomError(403, 'Cannot start live review');
  const version = await db.videoVersion.findFirst({
    where: { id: versionId, videoParentId: videoId },
  });
  if (!version || !['bunny', 'r2'].includes(version.providerId))
    throw new LiveRoomError(400, 'Unsupported video version');
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.liveReviewSession.findFirst({
        where: { videoId, status: 'active' },
      });
      if (existing) throw new LiveRoomError(409, 'Live review already active');
      const room = await tx.liveReviewSession.create({
        data: { videoId, versionId, managerUserId: viewer.userId! },
      });
      const participant = await tx.liveReviewParticipant.create({
        data: {
          sessionId: room.id,
          userId: viewer.userId!,
          name: viewer.name,
          isManager: true,
          canComment: true,
        },
      });
      await tx.liveReviewSession.update({
        where: { id: room.id },
        data: { presenterId: participant.id, controlEpoch: 1 },
      });
      return { sessionId: room.id, participantId: participant.id };
    });
  } catch (error) {
    if (error instanceof LiveRoomError) throw error;
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002')
      throw new LiveRoomError(409, 'Live review already active');
    throw error;
  }
}

export async function joinLiveRoom(
  videoId: string,
  versionId: string,
  viewer: LiveViewer,
  reconnectId?: string
) {
  if (!viewer.hasAccess) throw new LiveRoomError(403, 'Access denied');
  return db.$transaction(async (tx) => {
    const room = await tx.liveReviewSession.findFirst({ where: { videoId, status: 'active' } });
    if (!room || room.versionId !== versionId)
      throw new LiveRoomError(404, 'Live review not found');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${room.id}))`;
    if (reconnectId) {
      const participant = await tx.liveReviewParticipant.findFirst({
        where: { id: reconnectId, sessionId: room.id },
      });
      if (
        !participant ||
        participant.userId !== viewer.userId ||
        participant.guestIdentityId !== viewer.guestIdentityId ||
        (participant.shareToken && participant.shareToken !== viewer.shareToken)
      )
        throw new LiveRoomError(403, 'Participant identity mismatch');
      await tx.liveReviewParticipant.update({
        where: { id: participant.id },
        data: { lastSeenAt: new Date(), canComment: viewer.canComment },
      });
      return { sessionId: room.id, participantId: participant.id };
    }
    const activeCount = await tx.liveReviewParticipant.count({
      where: { sessionId: room.id, lastSeenAt: { gt: new Date(Date.now() - 30_000) } },
    });
    if (activeCount >= LIVE_MAX_PARTICIPANTS) throw new LiveRoomError(409, 'Live review is full');
    const participant = await tx.liveReviewParticipant.create({
      data: {
        sessionId: room.id,
        userId: viewer.userId,
        guestIdentityId: viewer.guestIdentityId,
        shareToken: viewer.shareToken,
        name: viewer.name,
        isManager: Boolean(viewer.canStart && viewer.userId === room.managerUserId),
        canComment: viewer.canComment,
      },
    });
    return { sessionId: room.id, participantId: participant.id };
  });
}
