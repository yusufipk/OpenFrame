import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse } from '@/lib/api-response';
import { checkVideoAccess } from '@/lib/content-access';
import { ensureGuestIdentityFromRequest, setGuestIdentityCookie } from '@/lib/guest-identity';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { validateShareLinkAccess } from '@/lib/share-links';
import { updateVideoPresence } from '@/lib/video-presence';

type RouteParams = { params: Promise<{ videoId: string }> };
const CLIENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    if (!request.headers.get('origin') || !isTrustedSameOriginRequest(request))
      return apiErrors.forbidden();
    const limited = await rateLimit(request, 'video-presence', {
      windowMs: 60_000,
      maxRequests: 240,
    });
    if (limited) return limited;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return apiErrors.badRequest();
    }
    if (
      !body ||
      typeof body.clientId !== 'string' ||
      !CLIENT_ID_PATTERN.test(body.clientId) ||
      (body.action !== 'heartbeat' && body.action !== 'leave') ||
      typeof body.isPlaying !== 'boolean'
    )
      return apiErrors.badRequest();

    const { videoId } = await params;
    const session = await auth();
    const userId = session?.user?.id ?? null;
    const access = await checkVideoAccess(videoId, userId ?? undefined);
    if (!access.video) return apiErrors.notFound('Video');

    const shareSession = getShareSessionFromRequest(request, videoId);
    const shareAccess =
      !access.hasAccess && shareSession
        ? await validateShareLinkAccess({
            token: shareSession.token,
            projectId: access.video.projectId,
            videoId,
            requiredPermission: 'VIEW',
            passwordVerified: shareSession.passwordVerified,
          })
        : null;
    if (!access.hasAccess && !shareAccess?.hasAccess) {
      return userId ? apiErrors.forbidden() : apiErrors.unauthorized();
    }

    const guest = userId ? null : ensureGuestIdentityFromRequest(request);
    const participants = await updateVideoPresence({
      videoId,
      projectId: access.video.projectId,
      clientId: body.clientId,
      action: body.action,
      isPlaying: body.isPlaying,
      viewer: {
        userId,
        guestIdentityId: guest?.identityId ?? null,
        name: session?.user?.name?.trim().slice(0, 80) || 'Member',
        shareToken: access.hasAccess ? null : shareSession!.token,
        sharePasswordHash: access.hasAccess ? null : (shareAccess?.link?.passwordHash ?? null),
      },
    });
    const response = successResponse({ participants });
    response.headers.set('Cache-Control', 'private, no-store');
    if (guest?.shouldSetCookie) setGuestIdentityCookie(response, guest.identityId);
    return response;
  } catch (error) {
    logError('Error updating video presence:', error);
    return apiErrors.internalError('Failed to update video presence');
  }
}
