import { NextRequest } from 'next/server';
import { getSession, withApiToken } from '@/lib/api-tokens';
import { checkVideoAccess } from '@/lib/content-access';
import { db } from '@/lib/db';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { signBunnyVideoDirectory } from '@/lib/bunny-cdn-token';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ versionId: string }> };

// GET /api/versions/[versionId]/playback
// Signed CDN directory for a Bunny version. The player derives playlist.m3u8 and
// original from `baseUrl` and calls this again before `expiresAt`. Access mirrors
// GET /api/watch/[videoId]: a project relationship, or a share session with VIEW.
// The directory token also covers the original upload, so viewers without download
// rights can still play it through the player's Original source. That is intended;
// the download route stays the gate for saving files and for egress accounting.
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'media-playback');
    if (limited) return limited;

    const session = await getSession();
    const { versionId } = await params;

    const version = await db.videoVersion.findUnique({
      where: { id: versionId },
      select: {
        providerId: true,
        videoId: true,
        video: { select: { id: true, projectId: true } },
      },
    });
    if (!version) return apiErrors.notFound('Version');

    const access = await checkVideoAccess(version.video.id, session?.user?.id);
    const shareSession = getShareSessionFromRequest(request, version.video.id);
    const shareAccess = shareSession
      ? await validateShareLinkAccess({
          token: shareSession.token,
          projectId: version.video.projectId,
          videoId: version.video.id,
          requiredPermission: 'VIEW',
          passwordVerified: shareSession.passwordVerified,
        })
      : { hasAccess: false };

    if (!access.hasAccess && !shareAccess.hasAccess) {
      // Same reasoning as the download route: a stranger is told the version does not
      // exist, while someone who belongs to the project (a lapsed owner, say) gets 403.
      const belongsToProject = access.isOwner || access.isProjectMember || access.isWorkspaceMember;
      return belongsToProject
        ? apiErrors.forbidden('Access denied')
        : apiErrors.notFound('Version');
    }

    if (version.providerId !== 'bunny') {
      return apiErrors.badRequest('Playback URLs are issued for Bunny versions only');
    }

    const signed = signBunnyVideoDirectory(version.videoId);
    if (!signed) return apiErrors.notFound('Playback');

    return withCacheControl(successResponse(signed), 'private, no-store');
  } catch (error) {
    logError('Error issuing playback URL:', error);
    return apiErrors.internalError('Failed to issue playback URL');
  }
}

// The signed directory also covers the original upload, so a token needs the
// download permission, not just read.
export const GET = withApiToken('download', handleGet);
