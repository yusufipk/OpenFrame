import { NextRequest } from 'next/server';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { apiErrors } from '@/lib/api-response';
import { proxyR2MediaObject } from '@/lib/r2-media-proxy';
import { logError } from '@/lib/logger';

// Only allow UUID filenames with safe extensions
const SAFE_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;

const CONTENT_TYPE_MAP: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};
function getContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return CONTENT_TYPE_MAP[ext] || 'application/octet-stream';
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename } = await params;

    // Validate filename to prevent path traversal
    if (!SAFE_FILENAME.test(filename)) {
      return apiErrors.badRequest('Invalid filename');
    }

    // Parallelize the DB lookup and session check to narrow the timing delta
    // between "asset not found" and "asset found, access denied" responses.
    const imageUrl = `/api/upload/image/${filename}`;
    const projectSelect = {
      id: true,
      ownerId: true,
      workspaceId: true,
      visibility: true,
    } as const;
    const videoSelect = {
      id: true,
      projectId: true,
      project: { select: projectSelect },
    } as const;
    const [comment, videoAsset, session] = await Promise.all([
      db.comment.findFirst({
        where: { imageUrl },
        select: {
          version: {
            select: { video: { select: videoSelect } },
          },
        },
      }),
      db.videoAsset.findFirst({
        where: { sourceUrl: imageUrl },
        select: { video: { select: videoSelect } },
      }),
      auth(),
    ]);

    const video = comment?.version?.video ?? videoAsset?.video ?? null;
    if (!video) {
      return apiErrors.forbidden('Access denied');
    }

    const access = await checkProjectAccess(video.project, session?.user?.id);

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

    const key = `images/${filename}`;
    return proxyR2MediaObject({
      request,
      key,
      fallbackContentType: getContentType(filename),
      cacheControl: 'private, no-store',
      extraHeaders: {
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
      internalErrorMessage: 'Failed to retrieve image',
    });
  } catch (error: unknown) {
    logError('Error serving image:', error);
    return apiErrors.internalError('Failed to retrieve image');
  }
}
