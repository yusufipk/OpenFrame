import type { ContentClient } from '@/lib/content-access';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { collectVideoMediaUrls, deleteMediaFilesBestEffort } from '@/lib/r2-cleanup';
import { cleanupBunnyStreamVideosBestEffort } from '@/lib/bunny-stream-cleanup';
import { buildCleanupWarnings, type CleanupWarnings } from '@/lib/cleanup-warnings';

type BunnyRef = {
  providerId: string;
  videoId: string;
};

type CleanupInput = {
  bunny: Awaited<ReturnType<typeof cleanupBunnyStreamVideosBestEffort>>;
  r2: Awaited<ReturnType<typeof deleteMediaFilesBestEffort>>;
};

/**
 * Storage refused at least one delete, so the rows were left in place and nothing was
 * removed. Carries the cleanup detail so the route can log which keys failed.
 */
export class VideoStorageCleanupError extends Error {
  readonly cleanupInput: CleanupInput;

  constructor(cleanupInput: CleanupInput) {
    super('STORAGE_CLEANUP_FAILED');
    this.name = 'VideoStorageCleanupError';
    this.cleanupInput = cleanupInput;
  }
}

export async function deleteProjectVideosWithCleanup(
  projectId: string,
  videoIds: string[],
  client: ContentClient = db,
  signal?: AbortSignal
): Promise<{
  deletedCount: number;
  cleanupWarnings: CleanupWarnings | undefined;
  cleanupInput: CleanupInput;
}> {
  const uniqueVideoIds = [...new Set(videoIds)];
  if (uniqueVideoIds.length === 0) {
    throw new Error('EMPTY_VIDEO_IDS');
  }

  const videos = await client.video.findMany({
    where: {
      projectId,
      id: { in: uniqueVideoIds },
    },
    include: {
      versions: {
        select: {
          providerId: true,
          videoId: true,
        },
      },
      assets: {
        select: {
          provider: true,
          providerVideoId: true,
        },
      },
    },
  });

  if (videos.length !== uniqueVideoIds.length) {
    throw new Error('VIDEO_NOT_FOUND');
  }

  const bunnyRefs: BunnyRef[] = [];
  const mediaUrlSets = await Promise.all(videos.map((video) => collectVideoMediaUrls(video.id)));
  const mediaUrls = [...new Set(mediaUrlSets.flat())];

  for (const video of videos) {
    bunnyRefs.push(
      ...video.versions,
      ...video.assets
        .filter((asset) => asset.provider === 'BUNNY' && !!asset.providerVideoId)
        .map((asset) => ({
          providerId: 'bunny',
          videoId: asset.providerVideoId as string,
        }))
    );
  }

  // Storage first, rows second. The other order committed the deleteMany before the R2 and
  // Bunny calls ran, with nothing spanning the two, so a refused storage DELETE left the
  // object in the bucket with no row pointing at it and no way to retry: the video id no
  // longer resolved to anything. Leaving the rows in place instead keeps the delete
  // repeatable, and a second attempt cleans up whatever the first one could not.
  const [bunnyCleanupResult, r2CleanupResult] = await Promise.all([
    cleanupBunnyStreamVideosBestEffort(bunnyRefs, signal),
    deleteMediaFilesBestEffort(mediaUrls, signal),
  ]);

  const cleanupInput = {
    bunny: bunnyCleanupResult,
    r2: r2CleanupResult,
  };

  const cleanupWarnings = buildCleanupWarnings(cleanupInput);
  if (cleanupWarnings) {
    throw new VideoStorageCleanupError(cleanupInput);
  }

  await client.video.deleteMany({
    where: {
      projectId,
      id: { in: uniqueVideoIds },
    },
  });

  revalidatePath(`/projects/${projectId}`);

  return {
    deletedCount: videos.length,
    cleanupWarnings,
    cleanupInput,
  };
}
