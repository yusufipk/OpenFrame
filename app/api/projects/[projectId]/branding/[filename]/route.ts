import { NextRequest } from 'next/server';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { checkFolderAccess, checkVideoAccess } from '@/lib/content-access';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { apiErrors } from '@/lib/api-response';
import { proxyR2MediaObject } from '@/lib/r2-media-proxy';
import { brandAssetFilename, brandAssetObjectKey } from '@/lib/project-branding';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string; filename: string }> };

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * Whoever may open the project, a folder in it or a video in it may see its branding.
 * The video and folder cases cover viewers who arrived through a share link or a
 * folder/video grant and have no access to the project as a whole.
 */
async function canViewBranding(
  request: NextRequest,
  project: { id: string; ownerId: string; workspaceId: string; visibility: string },
  userId: string | undefined
): Promise<boolean> {
  const projectAccess = await checkProjectAccess(project, userId);
  if (projectAccess.hasAccess) return true;

  const videoId = request.nextUrl.searchParams.get('videoId');
  if (videoId) {
    const videoAccess = await checkVideoAccess(videoId, userId);
    if (videoAccess.video?.projectId !== project.id) return false;
    if (videoAccess.hasAccess) return true;

    const shareSession = getShareSessionFromRequest(request, videoId);
    if (!shareSession) return false;
    const shareAccess = await validateShareLinkAccess({
      token: shareSession.token,
      projectId: project.id,
      videoId,
      requiredPermission: 'VIEW',
      passwordVerified: shareSession.passwordVerified,
    });
    return shareAccess.hasAccess;
  }

  const folderId = request.nextUrl.searchParams.get('folderId');
  if (folderId) {
    const folderAccess = await checkFolderAccess(project.id, folderId, userId);
    return !!folderAccess?.hasAccess;
  }

  return false;
}

// GET /api/projects/[projectId]/branding/[filename] - Serve the project's banner or logo
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { projectId, filename } = await params;

    const [project, session] = await Promise.all([
      db.project.findUnique({
        where: { id: projectId },
        select: {
          id: true,
          ownerId: true,
          workspaceId: true,
          visibility: true,
          brandBannerKey: true,
          brandLogoKey: true,
        },
      }),
      auth(),
    ]);

    // Only the project's current banner or logo is served here, never an arbitrary object.
    const isCurrentAsset =
      !!project &&
      (brandAssetFilename(project.brandBannerKey) === filename ||
        brandAssetFilename(project.brandLogoKey) === filename);
    if (!project || !isCurrentAsset) {
      return apiErrors.forbidden('Access denied');
    }

    if (!(await canViewBranding(request, project, session?.user?.id))) {
      return apiErrors.forbidden('Access denied');
    }

    const ext = filename.split('.').pop() ?? '';
    return proxyR2MediaObject({
      request,
      key: brandAssetObjectKey(filename),
      fallbackContentType: CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream',
      cacheControl: 'private, no-store',
      extraHeaders: {
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
      internalErrorMessage: 'Failed to retrieve branding image',
    });
  } catch (error) {
    logError('Error serving project branding:', error);
    return apiErrors.internalError('Failed to retrieve branding image');
  }
}
