import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { db } from '@/lib/db';
import { runWithConcurrency } from '@/lib/async-pool';
import { videoProxyPathToObjectKey } from '@/lib/video-upload-validation';
import { subtitleProxyPathToObjectKey } from '@/lib/subtitle-validation';
import { logError } from '@/lib/logger';

/** The path prefix for images served by the upload API. */
const IMAGE_PATH_PREFIX = '/api/upload/image/';
/** The path prefix for audio URLs served by the upload API. */
const AUDIO_PATH_PREFIX = '/api/upload/audio/';
const CLEANUP_DELETE_CONCURRENCY = 5;
const SAFE_IMAGE_PATH =
  /^\/api\/upload\/image\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;
const SAFE_AUDIO_PATH =
  /^\/api\/upload\/audio\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;

export interface R2CleanupResult {
  attempted: number;
  failed: number;
  failedKeys: string[];
}

/**
 * Extract the R2 object key from a media URL.
 * Accept only canonical upload URLs before deriving a storage key.
 */
export function mediaUrlToKey(url: string): string | null {
  if (SAFE_AUDIO_PATH.test(url)) {
    const filename = url.slice(AUDIO_PATH_PREFIX.length);
    return filename ? `voice/${filename}` : null;
  } else if (SAFE_IMAGE_PATH.test(url)) {
    const filename = url.slice(IMAGE_PATH_PREFIX.length);
    return filename ? `images/${filename}` : null;
  }

  return subtitleProxyPathToObjectKey(url) ?? videoProxyPathToObjectKey(url);
}

/**
 * Delete a list of media files from R2 (best-effort, logs failures).
 */
export async function deleteMediaFilesBestEffort(
  mediaUrls: string[],
  signal?: AbortSignal
): Promise<R2CleanupResult> {
  const invalidUrls: string[] = [];
  const mediaKeys = [
    ...new Set(
      mediaUrls
        .map((url) => {
          const key = mediaUrlToKey(url);
          if (!key) invalidUrls.push(url);
          return key;
        })
        .filter((key): key is string => Boolean(key))
    ),
  ];
  const failedKeys = new Set<string>();

  if (invalidUrls.length > 0) {
    console.error('Skipping non-canonical media URLs during R2 cleanup', {
      rejectedCount: invalidUrls.length,
      rejectedSamples: invalidUrls.slice(0, 10),
    });
  }

  await runWithConcurrency(mediaKeys, CLEANUP_DELETE_CONCURRENCY, async (key) => {
    if (signal?.aborted) {
      failedKeys.add(key);
      return;
    }
    try {
      await r2Client.send(
        new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }),
        ...(signal ? [{ abortSignal: signal }] : [])
      );
    } catch (err) {
      failedKeys.add(key);
      logError(`Failed to delete media from R2 (key: ${key}):`, err);
    }
  });

  return {
    attempted: mediaKeys.length,
    failed: failedKeys.size,
    failedKeys: [...failedKeys],
  };
}

/**
 * Collect all media URLs from comments under a given video (all versions).
 */
export async function collectVideoMediaUrls(videoId: string): Promise<string[]> {
  const [comments, assets, versions, subtitles] = await Promise.all([
    db.comment.findMany({
      where: {
        OR: [{ voiceUrl: { not: null } }, { images: { some: {} } }],
        version: { videoParentId: videoId },
      },
      select: { voiceUrl: true, images: { select: { url: true } } },
    }),
    db.videoAsset.findMany({
      where: {
        videoId,
        provider: 'R2_IMAGE',
      },
      select: { sourceUrl: true },
    }),
    db.videoVersion.findMany({
      where: { videoParentId: videoId, providerId: { in: ['r2', 'r2-image'] } },
      select: { originalUrl: true, thumbnailUrl: true },
    }),
    db.videoSubtitle.findMany({
      where: { version: { videoParentId: videoId } },
      select: { sourceUrl: true },
    }),
  ]);
  const urls: string[] = [];
  comments.forEach((c) => {
    if (c.voiceUrl) urls.push(c.voiceUrl);
    c.images.forEach((image) => urls.push(image.url));
  });
  assets.forEach((asset) => {
    if (asset.sourceUrl) urls.push(asset.sourceUrl);
  });
  versions.forEach((version) => {
    if (version.originalUrl) urls.push(version.originalUrl);
    if (version.thumbnailUrl) urls.push(version.thumbnailUrl);
  });
  subtitles.forEach((subtitle) => {
    if (subtitle.sourceUrl) urls.push(subtitle.sourceUrl);
  });
  return urls;
}

/**
 * Collect all media URLs from comments under all videos in a project.
 */
export async function collectProjectMediaUrls(projectId: string): Promise<string[]> {
  const [comments, assets, versions, subtitles] = await Promise.all([
    db.comment.findMany({
      where: {
        OR: [{ voiceUrl: { not: null } }, { images: { some: {} } }],
        version: { video: { projectId } },
      },
      select: { voiceUrl: true, images: { select: { url: true } } },
    }),
    db.videoAsset.findMany({
      where: {
        provider: 'R2_IMAGE',
        video: { projectId },
      },
      select: { sourceUrl: true },
    }),
    db.videoVersion.findMany({
      where: { providerId: { in: ['r2', 'r2-image'] }, video: { projectId } },
      select: { originalUrl: true, thumbnailUrl: true },
    }),
    db.videoSubtitle.findMany({
      where: { version: { video: { projectId } } },
      select: { sourceUrl: true },
    }),
  ]);
  const urls: string[] = [];
  comments.forEach((c) => {
    if (c.voiceUrl) urls.push(c.voiceUrl);
    c.images.forEach((image) => urls.push(image.url));
  });
  assets.forEach((asset) => {
    if (asset.sourceUrl) urls.push(asset.sourceUrl);
  });
  versions.forEach((version) => {
    if (version.originalUrl) urls.push(version.originalUrl);
    if (version.thumbnailUrl) urls.push(version.thumbnailUrl);
  });
  subtitles.forEach((subtitle) => {
    if (subtitle.sourceUrl) urls.push(subtitle.sourceUrl);
  });
  return urls;
}

/**
 * Collect all media URLs from comments under all projects in a workspace.
 */
export async function collectWorkspaceMediaUrls(workspaceId: string): Promise<string[]> {
  const [comments, assets, versions, subtitles] = await Promise.all([
    db.comment.findMany({
      where: {
        OR: [{ voiceUrl: { not: null } }, { images: { some: {} } }],
        version: { video: { project: { workspaceId } } },
      },
      select: { voiceUrl: true, images: { select: { url: true } } },
    }),
    db.videoAsset.findMany({
      where: {
        provider: 'R2_IMAGE',
        video: { project: { workspaceId } },
      },
      select: { sourceUrl: true },
    }),
    db.videoVersion.findMany({
      where: { providerId: { in: ['r2', 'r2-image'] }, video: { project: { workspaceId } } },
      select: { originalUrl: true, thumbnailUrl: true },
    }),
    db.videoSubtitle.findMany({
      where: { version: { video: { project: { workspaceId } } } },
      select: { sourceUrl: true },
    }),
  ]);
  const urls: string[] = [];
  comments.forEach((c) => {
    if (c.voiceUrl) urls.push(c.voiceUrl);
    c.images.forEach((image) => urls.push(image.url));
  });
  assets.forEach((asset) => {
    if (asset.sourceUrl) urls.push(asset.sourceUrl);
  });
  versions.forEach((version) => {
    if (version.originalUrl) urls.push(version.originalUrl);
    if (version.thumbnailUrl) urls.push(version.thumbnailUrl);
  });
  subtitles.forEach((subtitle) => {
    if (subtitle.sourceUrl) urls.push(subtitle.sourceUrl);
  });
  return urls;
}

/**
 * Delete all media files for a video from R2.
 * Call BEFORE deleting the video from the database (cascade would remove comment rows).
 */
export async function cleanupVideoMediaFiles(videoId: string) {
  const urls = await collectVideoMediaUrls(videoId);
  await deleteMediaFilesBestEffort(urls);
}

/**
 * Delete all media files for a project from R2.
 * Call BEFORE deleting the project from the database.
 */
export async function cleanupProjectMediaFiles(projectId: string) {
  const urls = await collectProjectMediaUrls(projectId);
  await deleteMediaFilesBestEffort(urls);
}

/**
 * Delete all media files for a workspace from R2.
 * Call BEFORE deleting the workspace from the database.
 */
export async function cleanupWorkspaceMediaFiles(workspaceId: string) {
  const urls = await collectWorkspaceMediaUrls(workspaceId);
  await deleteMediaFilesBestEffort(urls);
}
