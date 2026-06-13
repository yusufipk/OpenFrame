import { NextRequest } from 'next/server';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { apiErrors } from '@/lib/api-response';
import { proxyR2MediaObject } from '@/lib/r2-media-proxy';
import { buildVideoObjectKey, SAFE_VIDEO_BASENAME } from '@/lib/video-upload-validation';
import { logError } from '@/lib/logger';

const VIDEO_CONTENT_TYPE_MAP: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
};

function getVideoContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return VIDEO_CONTENT_TYPE_MAP[ext] || 'application/octet-stream';
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename } = await params;

    if (!SAFE_VIDEO_BASENAME.test(filename)) {
      return apiErrors.badRequest('Invalid filename');
    }

    const originalUrl = `/api/upload/video/${filename}`;
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

    const [versions, assets, session] = await Promise.all([
      db.videoVersion.findMany({
        where: { originalUrl },
        take: 2,
        select: {
          id: true,
          video: { select: videoSelect },
        },
      }),
      db.videoAsset.findMany({
        where: { sourceUrl: originalUrl },
        take: 2,
        select: {
          id: true,
          video: { select: videoSelect },
        },
      }),
      auth(),
    ]);

    const uniqueVideos = new Map<string, (typeof versions)[number]['video']>();
    for (const version of versions) {
      uniqueVideos.set(version.video.id, version.video);
    }
    for (const asset of assets) {
      uniqueVideos.set(asset.video.id, asset.video);
    }
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
        : {
            hasAccess: false,
            canComment: false,
            canDownload: false,
            allowGuests: false,
            requiresPassword: false,
          };

      if (!shareAccess.hasAccess) {
        return apiErrors.forbidden('Access denied');
      }
    }

    const key = buildVideoObjectKey(filename);
    return proxyR2MediaObject({
      request,
      key,
      fallbackContentType: getVideoContentType(filename),
      cacheControl: 'private, max-age=3600',
      internalErrorMessage: 'Failed to load video',
    });
  } catch (error) {
    logError('Error serving video upload:', error);
    return apiErrors.internalError('Failed to load video');
  }
}
