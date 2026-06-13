import { VideoAssetProvider } from '@prisma/client';
import { NextRequest } from 'next/server';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { db } from '@/lib/db';
import { cleanupBunnyStreamVideosBestEffort } from '@/lib/bunny-stream-cleanup';
import { deleteMediaFilesBestEffort } from '@/lib/r2-cleanup';
import { buildCleanupWarnings, logCleanupWarnings } from '@/lib/cleanup-warnings';
import { canDeleteAssetForViewer, getVideoAssetAccessContext } from '@/lib/video-assets';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ videoId: string; assetId: string }> };

// DELETE /api/videos/[videoId]/assets/[assetId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'asset-delete');
    if (limited) return limited;

    const { videoId, assetId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'COMMENT');
    if (!context) return apiErrors.notFound('Video');
    if (!context.canUploadAssets) return apiErrors.forbidden('Access denied');

    const asset = await db.videoAsset.findFirst({
      where: { id: assetId, videoId },
      select: {
        id: true,
        provider: true,
        sourceUrl: true,
        providerVideoId: true,
        thumbnailUrl: true,
        uploadedByUserId: true,
        uploadedByGuestIdentityId: true,
      },
    });

    if (!asset) return apiErrors.notFound('Asset');
    if (!canDeleteAssetForViewer(asset, context)) {
      return apiErrors.forbidden('You can only delete assets you uploaded');
    }

    let shouldDeleteImageObject = false;
    let shouldDeleteAudioObject = false;
    let shouldDeleteVideoObject = false;
    let shouldDeleteVideoThumbnail = false;
    await db.$transaction(async (tx) => {
      await tx.videoAsset.delete({ where: { id: asset.id } });

      if (asset.provider === VideoAssetProvider.R2_IMAGE) {
        const [assetReferenceCount, commentReferenceCount] = await Promise.all([
          tx.videoAsset.count({ where: { sourceUrl: asset.sourceUrl } }),
          tx.comment.count({ where: { imageUrl: asset.sourceUrl } }),
        ]);
        shouldDeleteImageObject = assetReferenceCount === 0 && commentReferenceCount === 0;
      }

      if (asset.provider === VideoAssetProvider.R2_AUDIO) {
        const [assetReferenceCount, commentReferenceCount] = await Promise.all([
          tx.videoAsset.count({ where: { sourceUrl: asset.sourceUrl } }),
          tx.comment.count({ where: { voiceUrl: asset.sourceUrl } }),
        ]);
        shouldDeleteAudioObject = assetReferenceCount === 0 && commentReferenceCount === 0;
      }

      if (asset.provider === VideoAssetProvider.R2_VIDEO) {
        const [assetReferenceCount, versionReferenceCount] = await Promise.all([
          tx.videoAsset.count({ where: { sourceUrl: asset.sourceUrl } }),
          tx.videoVersion.count({ where: { originalUrl: asset.sourceUrl } }),
        ]);
        shouldDeleteVideoObject = assetReferenceCount === 0 && versionReferenceCount === 0;

        if (asset.thumbnailUrl) {
          const [assetThumbnailCount, commentImageCount] = await Promise.all([
            tx.videoAsset.count({ where: { thumbnailUrl: asset.thumbnailUrl } }),
            tx.comment.count({ where: { imageUrl: asset.thumbnailUrl } }),
          ]);
          shouldDeleteVideoThumbnail = assetThumbnailCount === 0 && commentImageCount === 0;
        }
      }
    });

    let r2CleanupResult: Awaited<ReturnType<typeof deleteMediaFilesBestEffort>> | undefined;
    if (asset.provider === VideoAssetProvider.R2_IMAGE && shouldDeleteImageObject) {
      r2CleanupResult = await deleteMediaFilesBestEffort([asset.sourceUrl]);
    }
    if (asset.provider === VideoAssetProvider.R2_AUDIO && shouldDeleteAudioObject) {
      r2CleanupResult = await deleteMediaFilesBestEffort([asset.sourceUrl]);
    }
    if (asset.provider === VideoAssetProvider.R2_VIDEO) {
      const urlsToDelete: string[] = [];
      if (shouldDeleteVideoObject && asset.sourceUrl) {
        urlsToDelete.push(asset.sourceUrl);
      }
      if (shouldDeleteVideoThumbnail && asset.thumbnailUrl) {
        urlsToDelete.push(asset.thumbnailUrl);
      }
      if (urlsToDelete.length > 0) {
        r2CleanupResult = await deleteMediaFilesBestEffort(urlsToDelete);
      }
    }

    let bunnyCleanupResult:
      | Awaited<ReturnType<typeof cleanupBunnyStreamVideosBestEffort>>
      | undefined;
    if (asset.provider === VideoAssetProvider.BUNNY && asset.providerVideoId) {
      bunnyCleanupResult = await cleanupBunnyStreamVideosBestEffort([
        {
          providerId: 'bunny',
          videoId: asset.providerVideoId,
        },
      ]);
    }

    const cleanupInput = {
      bunny: bunnyCleanupResult,
      r2: r2CleanupResult,
    };
    const cleanupWarnings = buildCleanupWarnings(cleanupInput);
    if (cleanupWarnings) {
      logCleanupWarnings({ entityType: 'video-asset', entityId: asset.id }, cleanupInput);
    }

    const response = successResponse({
      message: 'Asset deleted',
      ...(cleanupWarnings ? { cleanupWarnings } : {}),
    });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error deleting video asset:', error);
    return apiErrors.internalError('Failed to delete asset');
  }
}
