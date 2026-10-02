import { NextRequest } from 'next/server';
import { VideoAssetProvider } from '@prisma/client';
import { withApiToken } from '@/lib/api-tokens';
import { db } from '@/lib/db';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { getVideoAssetAccessContext } from '@/lib/video-assets';
import { signBunnyVideoDirectory } from '@/lib/bunny-cdn-token';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ videoId: string; assetId: string }> };

// GET /api/videos/[videoId]/assets/[assetId]/playback
// Signed CDN directory for a Bunny video asset. Gated like the asset list, which
// only exposes a video asset's source to viewers who may download assets.
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'media-playback');
    if (limited) return limited;

    const { videoId, assetId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'VIEW');
    if (!context) return apiErrors.notFound('Video');
    if (!context.hasViewAccess) {
      return context.viewerBelongsToProject
        ? apiErrors.forbidden('Access denied')
        : apiErrors.notFound('Video');
    }
    if (!context.canDownloadAssets) {
      return apiErrors.forbidden('Downloads are disabled for this project');
    }

    const asset = await db.videoAsset.findFirst({
      where: { id: assetId, videoId },
      select: { provider: true, providerVideoId: true },
    });
    if (!asset) return apiErrors.notFound('Asset');
    if (asset.provider !== VideoAssetProvider.BUNNY || !asset.providerVideoId) {
      return apiErrors.badRequest('Playback URLs are issued for Bunny assets only');
    }

    const signed = signBunnyVideoDirectory(asset.providerVideoId);
    if (!signed) return apiErrors.notFound('Playback');

    return withCacheControl(successResponse(signed), 'private, no-store');
  } catch (error) {
    logError('Error issuing asset playback URL:', error);
    return apiErrors.internalError('Failed to issue playback URL');
  }
}

// The signed directory also covers the original upload, so a token needs the
// download permission, not just read.
export const GET = withApiToken('download', handleGet);
