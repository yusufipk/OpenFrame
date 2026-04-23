import { runWithConcurrency } from '@/lib/async-pool';

export interface BunnyVideoRef {
  providerId: string;
  videoId: string;
}

export interface BunnyCleanupResult {
  attempted: number;
  failed: number;
  failedIds: string[];
}

const BUNNY_API_BASE = 'https://video.bunnycdn.com';
const BUNNY_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const BUNNY_DELETE_CONCURRENCY = 5;

function getBunnyConfig(): { apiKey: string; libraryId: string } {
  const apiKey = process.env.BUNNY_STREAM_API_KEY;
  const libraryId =
    process.env.BUNNY_STREAM_LIBRARY_ID || process.env.NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID;

  if (!apiKey || !libraryId) {
    throw new Error(
      'Bunny cleanup failed: missing BUNNY_STREAM_API_KEY or BUNNY_STREAM_LIBRARY_ID.'
    );
  }

  return { apiKey, libraryId };
}

function normalizeVideoId(value: string): string | null {
  const trimmed = value.trim();
  return BUNNY_VIDEO_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function getUniqueBunnyVideoIds(videoRefs: BunnyVideoRef[]): string[] {
  return [
    ...new Set(
      videoRefs
        .filter((ref) => ref.providerId === 'bunny' && Boolean(ref.videoId))
        .map((ref) => normalizeVideoId(ref.videoId))
        .filter((videoId): videoId is string => Boolean(videoId))
    ),
  ];
}

export async function cleanupBunnyStreamVideosBestEffort(
  videoRefs: BunnyVideoRef[]
): Promise<BunnyCleanupResult> {
  const bunnyVideoIds = getUniqueBunnyVideoIds(videoRefs);
  if (bunnyVideoIds.length === 0) {
    return {
      attempted: 0,
      failed: 0,
      failedIds: [],
    };
  }

  let apiKey: string;
  let libraryId: string;
  try {
    const config = getBunnyConfig();
    apiKey = config.apiKey;
    libraryId = config.libraryId;
  } catch {
    return {
      attempted: bunnyVideoIds.length,
      failed: bunnyVideoIds.length,
      failedIds: bunnyVideoIds,
    };
  }

  const failedIds = new Set<string>();

  await runWithConcurrency(bunnyVideoIds, BUNNY_DELETE_CONCURRENCY, async (bunnyVideoId) => {
    try {
      const response = await fetch(
        `${BUNNY_API_BASE}/library/${libraryId}/videos/${encodeURIComponent(bunnyVideoId)}`,
        {
          method: 'DELETE',
          headers: {
            AccessKey: apiKey,
          },
        }
      );

      // Treat not-found as already deleted.
      if (response.status === 404) return;

      if (!response.ok) {
        failedIds.add(bunnyVideoId);
      }
    } catch {
      failedIds.add(bunnyVideoId);
    }
  });

  return {
    attempted: bunnyVideoIds.length,
    failed: failedIds.size,
    failedIds: [...failedIds],
  };
}

export async function cleanupBunnyStreamVideos(videoRefs: BunnyVideoRef[]): Promise<void> {
  const result = await cleanupBunnyStreamVideosBestEffort(videoRefs);
  if (result.failed === 0) return;

  const preview = result.failedIds.slice(0, 3).join(', ');
  throw new Error(`Bunny cleanup failed for ${result.failed} video(s): ${preview}`);
}
