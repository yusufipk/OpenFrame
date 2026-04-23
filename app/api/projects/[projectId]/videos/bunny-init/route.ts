import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import crypto from 'crypto';
import { cleanupBunnyStreamVideos } from '@/lib/bunny-stream-cleanup';
import { createBunnyUploadToken, verifyBunnyUploadToken } from '@/lib/bunny-upload-token';
import { isBunnyUploadsFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { enforceStorageQuota } from '@/lib/storage-quota';

type RouteParams = { params: Promise<{ projectId: string }> };

async function getProjectWithEditAccess(projectId: string, userId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      ownerId: true,
      workspaceId: true,
      visibility: true,
      workspace: { select: { ownerId: true } },
    },
  });

  if (!project) return null;

  const access = await checkProjectAccess(project, userId, { intent: 'manage' });
  const canEdit = access.canEdit;

  if (!canEdit) return null;

  return project;
}

// POST /api/projects/[projectId]/videos/bunny-init
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const project = await getProjectWithEditAccess(projectId, session.user.id);
    if (!project) {
      return apiErrors.forbidden('Access denied');
    }

    const body = await request.json().catch(() => null);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';

    if (!title) {
      return apiErrors.badRequest('Title is required');
    }

    if (!isBunnyUploadsFeatureEnabled()) {
      return apiErrors.badRequest('Direct uploads are disabled by this host');
    }

    const quotaError = await enforceStorageQuota(project.workspace.ownerId, BigInt(0));
    if (quotaError) return quotaError;

    const apiKey = process.env.BUNNY_STREAM_API_KEY;
    const libraryId =
      process.env.BUNNY_STREAM_LIBRARY_ID || process.env.NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID;

    if (!apiKey || !libraryId) {
      return apiErrors.internalError('Bunny Stream is not configured correctly');
    }

    // 1. Create video object in Bunny Stream
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
      logError('Failed to create Bunny Stream video', await bunnyRes.text());
      return apiErrors.internalError('Failed to initialize video upload with provider');
    }

    const bunnyVideo = await bunnyRes.json();
    const videoId = bunnyVideo.guid;
    if (typeof videoId !== 'string' || videoId.length === 0) {
      return apiErrors.internalError('Upload provider did not return a valid video identifier');
    }

    // 2. Generate TUS upload signature
    const expirationTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour validity

    // SHA256(library_id + api_key + expiration_time + video_id)
    const hash = crypto.createHash('sha256');
    hash.update(libraryId + apiKey + expirationTime + videoId);
    const signature = hash.digest('hex');
    const uploadToken = createBunnyUploadToken(
      {
        userId: session.user.id,
        projectId,
        videoId,
      },
      3600
    );

    const response = successResponse({
      videoId,
      libraryId,
      signature,
      expirationTime,
      uploadToken,
    });

    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error initializing Bunny upload:', error);
    return apiErrors.internalError('Failed to initialize upload');
  }
}

// DELETE /api/projects/[projectId]/videos/bunny-init
// Best-effort cleanup for interrupted uploads before a DB row is created.
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const project = await getProjectWithEditAccess(projectId, session.user.id);
    if (!project) {
      return apiErrors.forbidden('Access denied');
    }

    const body = await request.json().catch(() => null);
    const videoId = typeof body?.videoId === 'string' ? body.videoId.trim() : '';
    const uploadToken = typeof body?.uploadToken === 'string' ? body.uploadToken.trim() : '';

    if (!videoId || !uploadToken) {
      return apiErrors.badRequest('videoId and uploadToken are required');
    }

    const isValidUploadToken = verifyBunnyUploadToken(uploadToken, {
      userId: session.user.id,
      projectId,
      videoId,
    });
    if (!isValidUploadToken) {
      return apiErrors.forbidden('Invalid Bunny upload token');
    }

    await cleanupBunnyStreamVideos([{ providerId: 'bunny', videoId }]);

    const response = successResponse({ message: 'Pending upload cleaned up' });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error cleaning up pending Bunny upload:', error);
    return apiErrors.internalError('Failed to cleanup pending upload');
  }
}
