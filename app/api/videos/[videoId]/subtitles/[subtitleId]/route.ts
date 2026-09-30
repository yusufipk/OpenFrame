import { withApiToken } from '@/lib/api-tokens';
import { NextRequest } from 'next/server';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { db } from '@/lib/db';
import { logError } from '@/lib/logger';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { rateLimit } from '@/lib/rate-limit';
import { subtitleProxyPathToObjectKey } from '@/lib/subtitle-validation';
import { getVideoAssetAccessContext } from '@/lib/video-assets';

type RouteParams = { params: Promise<{ videoId: string; subtitleId: string }> };

// DELETE /api/videos/[videoId]/subtitles/[subtitleId]
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'subtitle-delete');
    if (limited) return limited;

    const { videoId, subtitleId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'VIEW');
    if (!context) return apiErrors.notFound('Video');
    if (!context.viewerUserId || !context.canManageAssets) {
      return apiErrors.forbidden('Access denied');
    }

    const subtitle = await db.videoSubtitle.findFirst({
      where: { id: subtitleId, version: { videoParentId: videoId } },
      select: { id: true, sourceUrl: true },
    });
    if (!subtitle) return apiErrors.notFound('Subtitle');

    // Storage first, row second, for the same reason video deletion does it in that
    // order: a refused delete leaves the row in place so the operation can be retried,
    // rather than orphaning an object nothing points at any more.
    const objectKey = subtitleProxyPathToObjectKey(subtitle.sourceUrl);
    if (objectKey) {
      await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: objectKey }));
    }

    await db.videoSubtitle.delete({ where: { id: subtitle.id } });

    const response = successResponse({ id: subtitle.id, deleted: true });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error deleting subtitle:', error);
    return apiErrors.internalError('Failed to delete subtitle');
  }
}

export const DELETE = withApiToken('delete', handleDelete);
