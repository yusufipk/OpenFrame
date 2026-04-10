import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { createBunnyUploadToken, verifyBunnyUploadToken } from '@/lib/bunny-upload-token';
import { cleanupBunnyStreamVideos } from '@/lib/bunny-stream-cleanup';
import {
  createGuestUploadToken,
  deriveGuestUploadContext,
  enforceGuestUploadQuota,
  verifyGuestUploadToken,
} from '@/lib/guest-upload-token';
import { isBunnyUploadsFeatureEnabled } from '@/lib/feature-flags';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { getVideoAssetAccessContext, SAFE_BUNNY_VIDEO_ID } from '@/lib/video-assets';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ videoId: string }> };

// POST /api/videos/[videoId]/assets/bunny-init
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'asset-bunny-init');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'COMMENT');
    if (!context) return apiErrors.notFound('Video');
    if (!context.canUploadAssets) return apiErrors.forbidden('Access denied');

    const body = await request.json().catch(() => null);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) return apiErrors.badRequest('Title is required');

    if (!isBunnyUploadsFeatureEnabled()) {
      return apiErrors.badRequest('Direct uploads are disabled by this host');
    }

    const shareSession = getShareSessionFromRequest(request, context.video.id);
    if (!context.viewerUserId) {
      const quotaError = await enforceGuestUploadQuota(request, context.video.id, 'bunny', shareSession?.token ?? null);
      if (quotaError) return quotaError;
    }

    const apiKey = process.env.BUNNY_STREAM_API_KEY;
    const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID || process.env.NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID;
    if (!apiKey || !libraryId) {
      return apiErrors.internalError('Bunny Stream is not configured correctly');
    }

    const bunnyRes = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos`, {
      method: 'POST',
      headers: {
        AccessKey: apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ title }),
    });

    if (!bunnyRes.ok) {
      logError('Failed to create Bunny Stream video asset', await bunnyRes.text());
      return apiErrors.internalError('Failed to initialize Bunny upload');
    }

    const bunnyVideo = await bunnyRes.json();
    const bunnyVideoId = typeof bunnyVideo?.guid === 'string' ? bunnyVideo.guid.trim() : '';
    if (!bunnyVideoId || !SAFE_BUNNY_VIDEO_ID.test(bunnyVideoId)) {
      return apiErrors.internalError('Upload provider did not return a valid video identifier');
    }

    const expirationTime = Math.floor(Date.now() / 1000) + 3600;
    const hash = crypto.createHash('sha256');
    hash.update(libraryId + apiKey + expirationTime + bunnyVideoId);
    const signature = hash.digest('hex');

    let uploadToken = '';
    if (context.viewerUserId) {
      uploadToken = createBunnyUploadToken({
        userId: context.viewerUserId,
        projectId: context.video.projectId,
        videoId: bunnyVideoId,
      }, 3600);
    } else {
      const expectedContext = deriveGuestUploadContext(request, shareSession?.token ?? null);
      if (!expectedContext) {
        return apiErrors.forbidden('Missing trusted client IP header');
      }

      uploadToken = createGuestUploadToken({
        projectId: context.video.projectId,
        videoId: context.video.id,
        intent: 'bunny',
        context: expectedContext,
      }, 3600);
    }

    const response = successResponse({
      videoId: bunnyVideoId,
      libraryId,
      signature,
      expirationTime,
      uploadToken,
    });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error initializing Bunny asset upload:', error);
    return apiErrors.internalError('Failed to initialize asset upload');
  }
}

// DELETE /api/videos/[videoId]/assets/bunny-init
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'asset-bunny-init');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'COMMENT');
    if (!context) return apiErrors.notFound('Video');
    if (!context.canUploadAssets) return apiErrors.forbidden('Access denied');

    const body = await request.json().catch(() => null);
    const bunnyVideoId = typeof body?.videoId === 'string' ? body.videoId.trim() : '';
    const uploadToken = typeof body?.uploadToken === 'string' ? body.uploadToken.trim() : '';
    if (!bunnyVideoId || !uploadToken || !SAFE_BUNNY_VIDEO_ID.test(bunnyVideoId)) {
      return apiErrors.badRequest('videoId and uploadToken are required');
    }

    if (context.viewerUserId) {
      const isValidUploadToken = verifyBunnyUploadToken(uploadToken, {
        userId: context.viewerUserId,
        projectId: context.video.projectId,
        videoId: bunnyVideoId,
      });
      if (!isValidUploadToken) {
        return apiErrors.forbidden('Invalid Bunny upload token');
      }
    } else {
      const shareSession = getShareSessionFromRequest(request, context.video.id);
      const expectedContext = deriveGuestUploadContext(request, shareSession?.token ?? null);
      if (!expectedContext) {
        return apiErrors.forbidden('Missing trusted client IP header');
      }

      const isValidUploadToken = verifyGuestUploadToken(uploadToken, {
        projectId: context.video.projectId,
        videoId: context.video.id,
        intent: 'bunny',
        context: expectedContext,
      });
      if (!isValidUploadToken) {
        return apiErrors.forbidden('Invalid Bunny upload token');
      }
    }

    await cleanupBunnyStreamVideos([{ providerId: 'bunny', videoId: bunnyVideoId }]);
    const response = successResponse({ message: 'Pending upload cleaned up' });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error cleaning up Bunny asset upload:', error);
    return apiErrors.internalError('Failed to cleanup pending upload');
  }
}
