// Exercises lib/video-delete.ts, the cascade behind the bulk-delete route.
//
// It reads media URLs while their rows exist, deletes storage first, and removes
// rows only after cleanup succeeds. Failed cleanup retains rows for retry.
//
// tests/setup/api.ts does not stub `r2Client`, which deleteMediaFilesBestEffort
// reaches through, so this file replaces it with a recorder. Bunny goes over
// fetch(), which is stubbed per test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { POST as bulkDelete } from '@/app/api/projects/[projectId]/videos/bulk-delete/route';
import { apiRequest, callRoute } from '../helpers/request';
import { signedInAs } from '../helpers/session';
import { deleteProjectVideosWithCleanup, VideoStorageCleanupError } from '@/lib/video-delete';
import {
  createComment,
  createProject,
  createUser,
  createVersion,
  createVideo,
  createVideoAsset,
  createWorkspace,
  seedProject,
} from '../factories';

const r2 = vi.hoisted(() => ({
  bucket: 'openframe-delete-test-bucket',
  deletedKeys: [] as string[],
  rejectKeys: new Set<string>(),
}));

vi.mock('@/lib/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/r2')>();
  return {
    ...actual,
    R2_BUCKET_NAME: r2.bucket,
    r2Client: {
      send: async (command: { input?: { Key?: string } }) => {
        const key = command.input?.Key ?? '';
        if (r2.rejectKeys.has(key)) throw new Error(`storage refused ${key}`);
        r2.deletedKeys.push(key);
        return {};
      },
    },
  };
});

const TARGET_VIDEO_URL = '/api/upload/video/cccccccc-cccc-4ccc-8ccc-ccccccccccc1.mp4';
const TARGET_VIDEO_KEY = 'videos/cccccccc-cccc-4ccc-8ccc-ccccccccccc1.mp4';
const TARGET_COMMENT_IMAGE = '/api/upload/image/cccccccc-cccc-4ccc-8ccc-ccccccccccc2.png';
const TARGET_COMMENT_IMAGE_KEY = 'images/cccccccc-cccc-4ccc-8ccc-ccccccccccc2.png';
const TARGET_ASSET_IMAGE = '/api/upload/image/cccccccc-cccc-4ccc-8ccc-ccccccccccc3.png';
const TARGET_ASSET_IMAGE_KEY = 'images/cccccccc-cccc-4ccc-8ccc-ccccccccccc3.png';

const SURVIVOR_VIDEO_URL = '/api/upload/video/dddddddd-dddd-4ddd-8ddd-ddddddddddd1.mp4';
const SURVIVOR_VIDEO_KEY = 'videos/dddddddd-dddd-4ddd-8ddd-ddddddddddd1.mp4';
const SURVIVOR_COMMENT_IMAGE = '/api/upload/image/dddddddd-dddd-4ddd-8ddd-ddddddddddd2.png';
const SURVIVOR_COMMENT_IMAGE_KEY = 'images/dddddddd-dddd-4ddd-8ddd-ddddddddddd2.png';

beforeEach(() => {
  r2.deletedKeys.length = 0;
  r2.rejectKeys.clear();
  vi.mocked(revalidatePath).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A video with an r2 version, a commented image and an R2 image asset. */
async function seedDeletableVideo(input: {
  projectId: string;
  ownerId: string;
  videoUrl: string;
  commentImageUrl: string;
  assetUrl?: string;
}) {
  const video = await createVideo({ projectId: input.projectId });
  const version = await createVersion({
    videoParentId: video.id,
    providerId: 'r2',
    originalUrl: input.videoUrl,
  });
  const comment = await createComment({
    versionId: version.id,
    imageUrl: input.commentImageUrl,
  });
  const asset = input.assetUrl
    ? await createVideoAsset({
        videoId: video.id,
        billedUserId: input.ownerId,
        provider: 'R2_IMAGE',
        sourceUrl: input.assetUrl,
      })
    : null;
  return { video, version, comment, asset };
}

describe('deleteProjectVideosWithCleanup input validation', () => {
  it('throws EMPTY_VIDEO_IDS for an empty list', async () => {
    const scenario = await seedProject();

    await expect(deleteProjectVideosWithCleanup(scenario.project.id, [])).rejects.toThrow(
      'EMPTY_VIDEO_IDS'
    );
  });

  it('throws VIDEO_NOT_FOUND for an id that does not exist', async () => {
    const scenario = await seedProject();

    await expect(
      deleteProjectVideosWithCleanup(scenario.project.id, ['no-such-video'])
    ).rejects.toThrow('VIDEO_NOT_FOUND');
  });

  // The projectId in the lookup is the only thing stopping a caller who is an
  // admin of project A from naming a video in project B. If the lookup ever
  // stopped scoping on it, this is where it shows.
  it('refuses the whole batch and deletes nothing when one id belongs to another project', async () => {
    const scenario = await seedProject();
    const otherProject = await createProject({
      ownerId: scenario.owner.id,
      workspaceId: scenario.workspace.id,
    });
    const mine = await createVideo({ projectId: scenario.project.id });
    const theirs = await createVideo({ projectId: otherProject.id });

    await expect(
      deleteProjectVideosWithCleanup(scenario.project.id, [mine.id, theirs.id])
    ).rejects.toThrow('VIDEO_NOT_FOUND');

    expect(await db.video.count()).toBe(2);
    expect(r2.deletedKeys).toEqual([]);
  });
});

describe('deleteProjectVideosWithCleanup cascade', () => {
  it('removes the video with its versions, comments and assets', async () => {
    const scenario = await seedProject();
    const seeded = await seedDeletableVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: TARGET_VIDEO_URL,
      commentImageUrl: TARGET_COMMENT_IMAGE,
      assetUrl: TARGET_ASSET_IMAGE,
    });

    const result = await deleteProjectVideosWithCleanup(scenario.project.id, [seeded.video.id]);

    expect(result.deletedCount).toBe(1);
    expect(await db.video.count()).toBe(0);
    expect(await db.videoVersion.count()).toBe(0);
    expect(await db.comment.count()).toBe(0);
    expect(await db.videoAsset.count()).toBe(0);
  });

  // The counterpart of the cascade: everything not named survives, rows and
  // objects alike.
  it('leaves a sibling video in the same project untouched, rows and objects', async () => {
    const scenario = await seedProject();
    const target = await seedDeletableVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: TARGET_VIDEO_URL,
      commentImageUrl: TARGET_COMMENT_IMAGE,
      assetUrl: TARGET_ASSET_IMAGE,
    });
    const survivor = await seedDeletableVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: SURVIVOR_VIDEO_URL,
      commentImageUrl: SURVIVOR_COMMENT_IMAGE,
    });

    await deleteProjectVideosWithCleanup(scenario.project.id, [target.video.id]);

    expect((await db.video.findMany({ select: { id: true } })).map((row) => row.id)).toEqual([
      survivor.video.id,
    ]);
    expect(await db.videoVersion.count()).toBe(1);
    expect(await db.comment.count()).toBe(1);
    expect(r2.deletedKeys).not.toContain(SURVIVOR_VIDEO_KEY);
    expect(r2.deletedKeys).not.toContain(SURVIVOR_COMMENT_IMAGE_KEY);
  });

  it('leaves a video in another project of the same workspace untouched', async () => {
    const scenario = await seedProject();
    const otherProject = await createProject({
      ownerId: scenario.owner.id,
      workspaceId: scenario.workspace.id,
    });
    const target = await seedDeletableVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: TARGET_VIDEO_URL,
      commentImageUrl: TARGET_COMMENT_IMAGE,
    });
    await seedDeletableVideo({
      projectId: otherProject.id,
      ownerId: scenario.owner.id,
      videoUrl: SURVIVOR_VIDEO_URL,
      commentImageUrl: SURVIVOR_COMMENT_IMAGE,
    });

    await deleteProjectVideosWithCleanup(scenario.project.id, [target.video.id]);

    expect(await db.video.count()).toBe(1);
    expect(r2.deletedKeys).not.toContain(SURVIVOR_VIDEO_KEY);
  });

  it('deletes exactly the storage objects the removed video referenced', async () => {
    const scenario = await seedProject();
    const target = await seedDeletableVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: TARGET_VIDEO_URL,
      commentImageUrl: TARGET_COMMENT_IMAGE,
      assetUrl: TARGET_ASSET_IMAGE,
    });
    await seedDeletableVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: SURVIVOR_VIDEO_URL,
      commentImageUrl: SURVIVOR_COMMENT_IMAGE,
    });

    await deleteProjectVideosWithCleanup(scenario.project.id, [target.video.id]);

    expect(new Set(r2.deletedKeys)).toEqual(
      new Set([TARGET_VIDEO_KEY, TARGET_COMMENT_IMAGE_KEY, TARGET_ASSET_IMAGE_KEY])
    );
  });

  it('counts a repeated id once', async () => {
    const scenario = await seedProject();
    const target = await seedDeletableVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: TARGET_VIDEO_URL,
      commentImageUrl: TARGET_COMMENT_IMAGE,
    });

    const result = await deleteProjectVideosWithCleanup(scenario.project.id, [
      target.video.id,
      target.video.id,
    ]);

    // Without the dedupe, videos.length (1) would not match uniqueVideoIds
    // (2) and the call would throw VIDEO_NOT_FOUND on a perfectly valid request.
    expect(result.deletedCount).toBe(1);
    expect(await db.video.count()).toBe(0);
  });

  it('deletes several videos in one call and reports the count', async () => {
    const scenario = await seedProject();
    const first = await seedDeletableVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: TARGET_VIDEO_URL,
      commentImageUrl: TARGET_COMMENT_IMAGE,
    });
    const second = await seedDeletableVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: SURVIVOR_VIDEO_URL,
      commentImageUrl: SURVIVOR_COMMENT_IMAGE,
    });

    const result = await deleteProjectVideosWithCleanup(scenario.project.id, [
      first.video.id,
      second.video.id,
    ]);

    expect(result.deletedCount).toBe(2);
    expect(await db.video.count()).toBe(0);
    expect(new Set(r2.deletedKeys)).toEqual(
      new Set([
        TARGET_VIDEO_KEY,
        TARGET_COMMENT_IMAGE_KEY,
        SURVIVOR_VIDEO_KEY,
        SURVIVOR_COMMENT_IMAGE_KEY,
      ])
    );
  });

  it('revalidates the project page so the video list is not served from cache', async () => {
    const scenario = await seedProject();
    const target = await createVideo({ projectId: scenario.project.id });

    await deleteProjectVideosWithCleanup(scenario.project.id, [target.id]);

    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith(`/projects/${scenario.project.id}`);
  });
});

describe('deleteProjectVideosWithCleanup and Bunny', () => {
  /** Stubs the Bunny API and records the URL of every request made to it. */
  function stubBunny(status: number) {
    vi.stubEnv('BUNNY_STREAM_API_KEY', 'test-bunny-key');
    vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '9999');
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return new Response(null, { status });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, requestedUrls };
  }

  it('asks Bunny to delete bunny versions and bunny assets, and nothing else', async () => {
    const { requestedUrls } = stubBunny(200);
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVersion({
      videoParentId: video.id,
      versionNumber: 1,
      providerId: 'bunny',
      providerVideoId: 'bunny-version-id-1',
    });
    await createVersion({
      videoParentId: video.id,
      versionNumber: 2,
      providerId: 'youtube',
      providerVideoId: 'youtube-video-id-1',
    });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      provider: 'BUNNY',
      providerVideoId: 'bunny-asset-id-1',
      sourceUrl: 'https://iframe.mediadelivery.net/play/9999/bunny-asset-id-1',
    });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      provider: 'YOUTUBE',
      providerVideoId: 'youtube-asset-id-1',
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });

    const result = await deleteProjectVideosWithCleanup(scenario.project.id, [video.id]);

    expect(new Set(requestedUrls)).toEqual(
      new Set([
        'https://video.bunnycdn.com/library/9999/videos/bunny-version-id-1',
        'https://video.bunnycdn.com/library/9999/videos/bunny-asset-id-1',
      ])
    );
    expect(result.cleanupInput.bunny).toEqual({ attempted: 2, failed: 0, failedIds: [] });
    expect(result.cleanupWarnings).toBeUndefined();
  });

  it('makes no Bunny request when the video has no bunny media', async () => {
    const { fetchMock } = stubBunny(200);
    const scenario = await seedProject();
    const target = await seedDeletableVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: TARGET_VIDEO_URL,
      commentImageUrl: TARGET_COMMENT_IMAGE,
    });

    const result = await deleteProjectVideosWithCleanup(scenario.project.id, [target.video.id]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.cleanupInput.bunny.attempted).toBe(0);
  });
});

describe('deleteProjectVideosWithCleanup when storage fails', () => {
  // Storage runs first and the rows go second. Deleting the rows first left the object in
  // the bucket with nothing pointing at it and no way to retry, because the video id no
  // longer resolved. Keeping the rows makes the delete repeatable.
  it('keeps the rows and reports the failure when a key cannot be deleted', async () => {
    const scenario = await seedProject();
    const target = await seedDeletableVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: TARGET_VIDEO_URL,
      commentImageUrl: TARGET_COMMENT_IMAGE,
    });
    r2.rejectKeys.add(TARGET_VIDEO_KEY);

    await expect(
      deleteProjectVideosWithCleanup(scenario.project.id, [target.video.id])
    ).rejects.toBeInstanceOf(VideoStorageCleanupError);

    // The row is still there, so the caller can try again.
    expect(await db.video.count()).toBe(1);
    // The rest of the sweep still ran.
    expect(r2.deletedKeys).toEqual([TARGET_COMMENT_IMAGE_KEY]);
  });

  it('carries the failed keys on the error so the route can log them', async () => {
    const scenario = await seedProject();
    const target = await seedDeletableVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: TARGET_VIDEO_URL,
      commentImageUrl: TARGET_COMMENT_IMAGE,
    });
    r2.rejectKeys.add(TARGET_VIDEO_KEY);

    const error = await deleteProjectVideosWithCleanup(scenario.project.id, [
      target.video.id,
    ]).catch((err: unknown) => err as VideoStorageCleanupError);

    expect(error.cleanupInput.r2).toEqual({
      attempted: 2,
      failed: 1,
      failedKeys: [TARGET_VIDEO_KEY],
    });
  });

  // A Bunny video that survives the delete is billed and invisible in the app, so it gets
  // the same treatment as an orphaned R2 object.
  it('keeps the rows when Bunny refuses the delete', async () => {
    vi.stubEnv('BUNNY_STREAM_API_KEY', 'test-bunny-key');
    vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '9999');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 }))
    );
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVersion({
      videoParentId: video.id,
      providerId: 'bunny',
      providerVideoId: 'bunny-version-id-2',
    });

    const error = await deleteProjectVideosWithCleanup(scenario.project.id, [video.id]).catch(
      (err: unknown) => err as VideoStorageCleanupError
    );

    expect(error).toBeInstanceOf(VideoStorageCleanupError);
    expect(error.cleanupInput.bunny).toMatchObject({ attempted: 1, failed: 1 });
    expect(await db.video.count()).toBe(1);
  });

  it('reports no warnings when both providers succeed', async () => {
    const scenario = await seedProject();
    const target = await seedDeletableVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: TARGET_VIDEO_URL,
      commentImageUrl: TARGET_COMMENT_IMAGE,
    });

    const result = await deleteProjectVideosWithCleanup(scenario.project.id, [target.video.id]);

    expect(result.cleanupWarnings).toBeUndefined();
    expect(result.cleanupInput.r2.failed).toBe(0);
  });
});

describe('deleteProjectVideosWithCleanup media collection order', () => {
  // collectVideoMediaUrls runs before the deleteMany. If it ran after, the
  // cascade would already have taken the comment rows and their images would
  // stay in storage forever, silently.
  it('deletes comment media even though the cascade removes the comment rows', async () => {
    const scenario = await seedProject();
    const target = await seedDeletableVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: TARGET_VIDEO_URL,
      commentImageUrl: TARGET_COMMENT_IMAGE,
    });

    await deleteProjectVideosWithCleanup(scenario.project.id, [target.video.id]);

    expect(await db.comment.count()).toBe(0);
    expect(r2.deletedKeys).toContain(TARGET_COMMENT_IMAGE_KEY);
  });

  it('scopes media collection per video so two videos sharing a project do not cross over', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const project = await createProject({ ownerId: owner.id, workspaceId: workspace.id });
    const target = await seedDeletableVideo({
      projectId: project.id,
      ownerId: owner.id,
      videoUrl: TARGET_VIDEO_URL,
      commentImageUrl: TARGET_COMMENT_IMAGE,
    });
    await seedDeletableVideo({
      projectId: project.id,
      ownerId: owner.id,
      videoUrl: SURVIVOR_VIDEO_URL,
      commentImageUrl: SURVIVOR_COMMENT_IMAGE,
    });

    const result = await deleteProjectVideosWithCleanup(project.id, [target.video.id]);

    expect(result.cleanupInput.r2.attempted).toBe(2);
    expect(new Set(r2.deletedKeys)).toEqual(new Set([TARGET_VIDEO_KEY, TARGET_COMMENT_IMAGE_KEY]));
  });
});

it('commits a successful slow bulk cleanup beyond the ordinary twenty-second transaction budget', async () => {
  const f = await seedProject();
  const video = await createVideo({ projectId: f.project.id });
  await createVersion({
    videoParentId: video.id,
    providerId: 'bunny',
    providerVideoId: 'slow-bunny-video',
  });
  vi.stubEnv('BUNNY_STREAM_API_KEY', 'test');
  vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '123');
  const fetchMock = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20500));
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  signedInAs(f.owner);
  const response = await callRoute(
    bulkDelete,
    apiRequest(`/api/projects/${f.project.id}/videos/bulk-delete`, {
      body: { videoIds: [video.id] },
    }),
    { projectId: f.project.id }
  );
  expect(response.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await db.video.findUnique({ where: { id: video.id } })).toBeNull();
}, 30000);

it('retains rows after an aborted cleanup and drains all active storage requests', async () => {
  const f = await seedProject();
  const video = await createVideo({ projectId: f.project.id });
  await createVersion({
    videoParentId: video.id,
    providerId: 'bunny',
    providerVideoId: 'aborted-bunny-video',
  });
  vi.stubEnv('BUNNY_STREAM_API_KEY', 'test');
  vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '123');
  const controller = new AbortController();
  let active = 0;
  const finishRequests: Array<() => void> = [];
  const fetchMock = vi.fn((_url, options: { signal: AbortSignal }) => {
    active++;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => {
          finishRequests.push(() => {
            active--;
            reject(new Error('aborted'));
          });
        },
        { once: true }
      );
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const pending = deleteProjectVideosWithCleanup(f.project.id, [video.id], db, controller.signal);
  void pending.catch(() => {});
  await vi.waitFor(() => expect(active).toBe(1));
  let settled = false;
  void pending
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);
  expect(active).toBe(finishRequests.length);
  expect(active).toBeGreaterThan(0);
  for (const finish of finishRequests) finish();
  await expect(pending).rejects.toBeInstanceOf(VideoStorageCleanupError);
  expect(active).toBe(0);
  expect(await db.video.findUnique({ where: { id: video.id } })).not.toBeNull();
});
