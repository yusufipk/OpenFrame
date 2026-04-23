import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, computeProjectAccess, projectAccessInclude } from '@/lib/auth';
import { apiErrors, successResponse } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ videoId: string }> };

// GET /api/watch/[videoId]/progress - Get watch progress for the current user
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return apiErrors.unauthorized('Authentication required');
    }

    const { videoId } = await params;

    // Get the video and its active version (project access data pre-fetched in same query)
    const userId = session.user.id;
    const video = await db.video.findUnique({
      where: { id: videoId },
      include: {
        project: { include: projectAccessInclude(userId) },
        versions: {
          where: { isActive: true },
          take: 1,
        },
      },
    });

    if (!video) {
      return apiErrors.notFound('Video');
    }

    const access = computeProjectAccess(video.project, userId);

    if (!access.hasAccess) {
      return apiErrors.forbidden('Access denied');
    }

    const activeVersion = video.versions[0];
    if (!activeVersion) {
      return apiErrors.notFound('Video version');
    }

    // Get watch progress for this user and version
    const progress = await db.watchProgress.findUnique({
      where: {
        userId_versionId: {
          userId: session.user.id,
          versionId: activeVersion.id,
        },
      },
    });

    return successResponse({
      progress: progress ? progress.progress : 0,
      duration: progress?.duration || activeVersion.duration || 0,
      percentage: progress?.percentage || 0,
      updatedAt: progress?.updatedAt || null,
    });
  } catch (error) {
    logError('Error fetching watch progress:', error);
    return apiErrors.internalError('Failed to fetch watch progress');
  }
}

// POST /api/watch/[videoId]/progress - Save watch progress for the current user
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    // Rate limit watch progress updates (30 per minute to allow pause + periodic + visibility changes)
    const limited = await rateLimit(request, 'watch-progress');
    if (limited) return limited;

    const session = await auth();

    if (!session?.user?.id) {
      return apiErrors.unauthorized('Authentication required');
    }

    const { videoId } = await params;
    const body = await request.json();
    const { progress, duration, versionId } = body;

    const MAX_VIDEO_SECONDS = 86_400; // 24 hours — reasonable upper bound for any video

    if (
      typeof progress !== 'number' ||
      !isFinite(progress) ||
      progress < 0 ||
      progress > MAX_VIDEO_SECONDS
    ) {
      return apiErrors.badRequest('Invalid progress value');
    }

    if (
      duration !== undefined &&
      (typeof duration !== 'number' ||
        !isFinite(duration) ||
        duration < 0 ||
        duration > MAX_VIDEO_SECONDS)
    ) {
      return apiErrors.badRequest('Invalid duration value');
    }

    if (versionId !== undefined && typeof versionId !== 'string') {
      return apiErrors.badRequest('Invalid versionId');
    }

    // Always load the requested video and validate access before writing progress.
    // If versionId is provided, verify it belongs to this video; otherwise resolve active version.
    // Project access data is pre-fetched in the same query — no extra round-trips.
    const userId = session.user.id;
    const video = await db.video.findUnique({
      where: { id: videoId },
      include: {
        project: { include: projectAccessInclude(userId) },
        versions: {
          where: versionId ? { id: versionId } : { isActive: true },
          take: 1,
        },
      },
    });

    if (!video) {
      return apiErrors.notFound('Video');
    }

    const access = computeProjectAccess(video.project, userId);
    if (!access.hasAccess) {
      return apiErrors.forbidden('Access denied');
    }

    const targetVersion = video.versions[0];
    if (!targetVersion) {
      return apiErrors.notFound('Video version');
    }

    // Calculate percentage
    const safeDuration = duration || 0;
    const percentage = safeDuration > 0 ? Math.min(100, (progress / safeDuration) * 100) : 0;

    // Client already filters tiny deltas (<2s) before sending — safe to upsert directly.
    const watchProgress = await db.watchProgress.upsert({
      where: {
        userId_versionId: {
          userId: session.user.id,
          versionId: targetVersion.id,
        },
      },
      update: {
        progress,
        duration: safeDuration,
        percentage,
      },
      create: {
        userId: session.user.id,
        versionId: targetVersion.id,
        progress,
        duration: safeDuration,
        percentage,
      },
    });

    return successResponse({
      success: true,
      progress: watchProgress.progress,
      percentage: watchProgress.percentage,
    });
  } catch (error) {
    logError('Error saving watch progress:', error);
    return apiErrors.internalError('Failed to save watch progress');
  }
}
