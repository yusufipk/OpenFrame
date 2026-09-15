import { checkVideoAccess } from '@/lib/content-access';
import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { apiErrors } from '@/lib/api-response';
import { proxyR2MediaObject } from '@/lib/r2-media-proxy';
import { logError } from '@/lib/logger';
import {
  SAFE_SUBTITLE_FILENAME,
  SUBTITLE_CONTENT_TYPE,
  SUBTITLE_OBJECT_KEY_PREFIX,
  subtitleFileNameToProxyUrl,
} from '@/lib/subtitle-validation';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename } = await params;

    // Validate filename to prevent path traversal
    if (!SAFE_SUBTITLE_FILENAME.test(filename)) {
      return apiErrors.badRequest('Invalid filename');
    }

    // Parallelize the DB lookup and session check to narrow the timing delta
    // between "subtitle not found" and "subtitle found, access denied" responses.
    const [subtitle, session] = await Promise.all([
      db.videoSubtitle.findUnique({
        where: { sourceUrl: subtitleFileNameToProxyUrl(filename) },
        select: {
          version: {
            select: {
              video: {
                select: {
                  id: true,
                  projectId: true,
                  project: {
                    select: { id: true, ownerId: true, workspaceId: true, visibility: true },
                  },
                },
              },
            },
          },
        },
      }),
      auth(),
    ]);

    const video = subtitle?.version?.video ?? null;
    if (!video) {
      return apiErrors.forbidden('Access denied');
    }

    const access = await checkVideoAccess(video.id, session?.user?.id);

    if (!access.hasAccess) {
      const shareSession = getShareSessionFromRequest(request, video.id);
      const shareAccess = shareSession
        ? await validateShareLinkAccess({
            token: shareSession.token,
            projectId: video.projectId,
            videoId: video.id,
            requiredPermission: 'VIEW',
            passwordVerified: shareSession.passwordVerified,
          })
        : null;

      if (!shareAccess?.hasAccess) {
        return apiErrors.forbidden('Access denied');
      }
    }

    return proxyR2MediaObject({
      request,
      key: `${SUBTITLE_OBJECT_KEY_PREFIX}${filename}`,
      fallbackContentType: SUBTITLE_CONTENT_TYPE,
      cacheControl: 'private, no-store',
      extraHeaders: {
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
      internalErrorMessage: 'Failed to retrieve subtitle',
    });
  } catch (error: unknown) {
    logError('Error serving subtitle:', error);
    return apiErrors.internalError('Failed to retrieve subtitle');
  }
}
