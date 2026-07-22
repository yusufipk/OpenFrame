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

// Map extensions to content types
const CONTENT_TYPE_MAP: Record<string, string> = {
  webm: 'audio/webm',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};
function getContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return CONTENT_TYPE_MAP[ext] || 'audio/webm';
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
    const voiceUrl = `/api/upload/audio/${filename}`;
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
    const [comments, videoAssets, session] = await Promise.all([
      db.comment.findMany({
        where: { voiceUrl },
        take: 2,
        select: {
          version: {
            select: { video: { select: videoSelect } },
          },
        },
      }),
      db.videoAsset.findMany({
        where: { sourceUrl: voiceUrl },
        take: 2,
        select: { video: { select: videoSelect } },
      }),
      auth(),
    ]);

    const uniqueVideos = new Map<string, (typeof videoAssets)[number]['video']>();
    comments.forEach((comment) => {
      if (comment.version?.video) uniqueVideos.set(comment.version.video.id, comment.version.video);
    });
    videoAssets.forEach((videoAsset) => uniqueVideos.set(videoAsset.video.id, videoAsset.video));

    if (uniqueVideos.size > 1) {
      return apiErrors.forbidden('Access denied');
    }

    const video = uniqueVideos.values().next().value ?? null;
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

    const key = `voice/${filename}`;
    return proxyR2MediaObject({
      request,
      key,
      fallbackContentType: getContentType(filename),
      cacheControl: 'private, no-store',
      extraHeaders: {
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
      internalErrorMessage: 'Failed to retrieve audio',
    });
  } catch (error: unknown) {
    logError('Error serving audio:', error);
    return apiErrors.internalError('Failed to retrieve audio');
  }
}
