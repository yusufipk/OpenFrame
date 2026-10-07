import { NextRequest } from 'next/server';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { auth } from '@/lib/auth';
import { checkVideoAccess } from '@/lib/content-access';
import { db } from '@/lib/db';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';

type RouteParams = { params: Promise<{ videoId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    if (!request.headers.get('origin') || !isTrustedSameOriginRequest(request)) {
      return apiErrors.forbidden('Cross-origin requests are not allowed');
    }

    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const { videoId } = await params;
    const shareSession = getShareSessionFromRequest(request, videoId);
    if (!shareSession) return apiErrors.unauthorized();

    const video = await db.video.findUnique({
      where: { id: videoId },
      select: { projectId: true },
    });
    if (!video) return apiErrors.notFound('Video');

    const access = await validateShareLinkAccess({
      token: shareSession.token,
      projectId: video.projectId,
      videoId,
      passwordVerified: shareSession.passwordVerified,
    });
    if (!access.hasAccess || !access.link) return apiErrors.forbidden('Access denied');

    const session = await auth();
    if (session?.user?.id) {
      const viewerAccess = await checkVideoAccess(videoId, session.user.id);
      // Editors previewing their own share link do not count as reviewer opens.
      if (viewerAccess.canEdit) {
        return withCacheControl(successResponse({ recorded: false }), 'private, no-store');
      }
    }

    // One statement preserves the first open under concurrent requests. Matching
    // the token also prevents an in-flight request from recording a rotated link.
    const updated = await db.$executeRaw`
      UPDATE "share_links"
      SET "firstOpenedAt" = COALESCE("firstOpenedAt", statement_timestamp()),
          "lastOpenedAt" = GREATEST("lastOpenedAt", statement_timestamp())
      WHERE "id" = ${access.link.id}
        AND "token" = ${shareSession.token}
        AND ("expiresAt" IS NULL OR "expiresAt" > statement_timestamp())
    `;
    if (!updated) return apiErrors.forbidden('Share link is no longer available');

    return withCacheControl(successResponse({ recorded: true }), 'private, no-store');
  } catch (error) {
    logError('Error recording share link open:', error);
    return apiErrors.internalError('Failed to record share link open');
  }
}
