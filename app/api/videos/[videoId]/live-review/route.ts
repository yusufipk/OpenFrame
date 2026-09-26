import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { apiErrors, errorResponse, successResponse } from '@/lib/api-response';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { setGuestIdentityCookie } from '@/lib/guest-identity';
import { resolveLiveViewer } from '@/lib/live-review/access';
import {
  liveReviewAvailable,
  liveReviewEnabled,
  liveReviewHealthy,
  liveReviewPublicUrl,
} from '@/lib/live-review/config';
import { issueLiveTicket } from '@/lib/live-review/tickets';
import { joinLiveRoom, LiveRoomError, startLiveRoom } from '@/lib/live-review/state';
import type { LiveDiscovery, LiveJoinResult } from '@/lib/live-review/protocol';

type RouteParams = { params: Promise<{ videoId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { videoId } = await params;
  const session = await auth();
  const access = await resolveLiveViewer(request, videoId);
  if (!access.hasAccess)
    return session?.user?.id ? apiErrors.forbidden() : apiErrors.unauthorized();
  const active = await db.liveReviewSession.findFirst({
    where: { videoId, status: 'active' },
    select: { id: true, versionId: true },
  });
  const data: LiveDiscovery = {
    enabled: liveReviewEnabled(),
    available: await liveReviewHealthy(),
    canStart: access.canStart,
    session: active,
  };
  const response = successResponse(data);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  if (!isTrustedSameOriginRequest(request)) return apiErrors.forbidden();
  const { videoId } = await params;
  const session = await auth();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiErrors.badRequest();
  }
  if (
    !body ||
    (body.action !== 'start' && body.action !== 'join') ||
    typeof body.versionId !== 'string' ||
    body.versionId.length > 128 ||
    (body.guestName !== undefined &&
      (typeof body.guestName !== 'string' || body.guestName.length > 80)) ||
    (body.participantId !== undefined &&
      (typeof body.participantId !== 'string' || body.participantId.length > 128))
  )
    return apiErrors.badRequest();
  const viewer = await resolveLiveViewer(
    request,
    videoId,
    typeof body.guestName === 'string' ? body.guestName : undefined
  );
  if (!viewer.hasAccess)
    return session?.user?.id ? apiErrors.forbidden() : apiErrors.unauthorized();
  if (!liveReviewAvailable() || !(await liveReviewHealthy()))
    return errorResponse('Live review unavailable', 503, 'SERVICE_UNAVAILABLE');
  try {
    const room =
      body.action === 'start'
        ? await startLiveRoom(videoId, body.versionId, viewer)
        : await joinLiveRoom(
            videoId,
            body.versionId,
            viewer,
            typeof body.participantId === 'string' ? body.participantId : undefined
          );
    const ticket = await issueLiveTicket(room.sessionId, room.participantId);
    const data: LiveJoinResult = {
      ticket,
      participantId: room.participantId,
      websocketUrl: liveReviewPublicUrl()!,
      sessionId: room.sessionId,
      versionId: body.versionId,
    };
    const response = successResponse(data);
    response.headers.set('Cache-Control', 'no-store');
    if (viewer.setGuestCookie && viewer.guestIdentityId)
      setGuestIdentityCookie(response, viewer.guestIdentityId);
    return response;
  } catch (error) {
    if (error instanceof LiveRoomError) return errorResponse(error.message, error.status);
    throw error;
  }
}
