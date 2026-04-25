import { NextRequest } from 'next/server';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import {
  createGuestUploadToken,
  deriveGuestUploadContext,
  guestUploadTokenTtlSeconds,
  type GuestUploadIntent,
} from '@/lib/guest-upload-token';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ videoId: string }> };

function validateSameOriginRequest(request: NextRequest): Response | null {
  const origin = request.headers.get('origin');
  if (!origin) {
    return apiErrors.forbidden('Missing Origin header');
  }

  if (!isTrustedSameOriginRequest(request)) {
    return apiErrors.forbidden('Cross-origin requests are not allowed');
  }

  return null;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const originError = validateSameOriginRequest(request);
    if (originError) return originError;

    const limited = await rateLimit(request, 'guest-upload-token', {
      windowMs: 60 * 1000,
      maxRequests: 20,
    });
    if (limited) return limited;

    const session = await auth();
    if (session?.user?.id) {
      return apiErrors.badRequest('Upload token is only required for guest uploads');
    }

    const { videoId } = await params;
    const body = await request.json().catch(() => ({}));
    const intent = body?.intent;
    if (intent !== 'audio' && intent !== 'image') {
      return apiErrors.badRequest('intent must be "audio" or "image"');
    }

    const video = await db.video.findUnique({
      where: { id: videoId },
      include: { project: true },
    });
    if (!video) {
      return apiErrors.notFound('Video');
    }

    const access = await checkProjectAccess(video.project, session?.user?.id);
    const shareSession = getShareSessionFromRequest(request, video.id);
    const shareAccess = shareSession
      ? await validateShareLinkAccess({
          token: shareSession.token,
          projectId: video.projectId,
          videoId: video.id,
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

    const canCommentWithMembership = !!session?.user?.id && access.hasAccess;
    const canCommentWithShareLink = shareAccess.canComment && shareAccess.allowGuests;
    if (!canCommentWithMembership && !canCommentWithShareLink) {
      return apiErrors.forbidden('Access denied');
    }

    const context = deriveGuestUploadContext(request, shareSession?.token ?? null);
    if (!context) {
      return apiErrors.forbidden('Missing trusted client IP header');
    }

    const token = createGuestUploadToken({
      projectId: video.projectId,
      videoId: video.id,
      intent: intent as GuestUploadIntent,
      context,
    });

    const response = successResponse({
      token,
      intent,
      expiresInSeconds: guestUploadTokenTtlSeconds,
    });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error issuing guest upload token:', error);
    return apiErrors.internalError('Failed to issue upload token');
  }
}
