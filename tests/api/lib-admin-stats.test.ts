// Exercises lib/admin-stats.ts, the aggregation behind the two admin
// dashboards, against real Postgres.
//
// Two things make the module worth a suite of its own rather than coverage
// through the pages that render it. First, `getCachedUserBunnyStorage` is not
// only a dashboard number: lib/storage-quota.ts adds its answer to a user's
// used bytes before granting an upload, so a grouping mistake here refuses or
// grants real uploads. Second, every figure is a byte count, and the
// download-egress path carries a BigInt column into a JavaScript number, which
// is exactly the seam this repo has already been bitten on.
//
// Only the boundaries are faked: `r2Client` (ListObjectsV2), global `fetch`
// (the Bunny API) and `getStripe()`. Every row the module aggregates over is a
// real row in the test database, because the aggregation is the thing under
// test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// tests/setup/api.ts replaces `getCachedUserBunnyStorage` with a vi.fn() that
// answers `{}`, because it sits in the middle of reserveStorageQuota() and
// would otherwise reach the Bunny API from every upload test. This file is the
// one place that has to run the real implementation, so it drops that
// registration entirely. `vi.unmock` is hoisted like `vi.mock`, so it lands
// after the setup file's registration and wins. `mockRestore()` would not do
// the job: the stub is a bare vi.fn(), not a spy over the real export, so
// restoring it yields a function that returns undefined.
vi.unmock('@/lib/admin-stats');

import { DownloadEgressSource, VideoAssetKind, VideoAssetProvider } from '@prisma/client';
import { db } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import {
  getCachedBunnyStorageStats,
  getCachedStripeStats,
  getCachedTotalStorage,
  getCachedUserBunnyStorage,
  getCachedUserDownloadEgress,
  getCachedUserMediaStorage,
  getUserBunnyStorageBytes,
  refreshR2StorageSnapshot,
} from '@/lib/admin-stats';
import {
  createComment,
  createProject,
  createUser,
  createVersion,
  createVideo,
  createVideoAsset,
  createWorkspace,
  nextSeq,
  seedProject,
  seedVersion,
} from '../factories';

// ---------------------------------------------------------------------------
// R2 boundary
// ---------------------------------------------------------------------------
// vi.mock factories are hoisted above every const in the file, so the recorder
// has to be hoisted with them. The setup file stubs the named helpers in
// `@/lib/r2` but not `r2Client`, which is what listAllR2FileSizes() reaches
// for.
const r2 = vi.hoisted(() => ({
  bucket: 'openframe-admin-stats-test-bucket',
  /** Successive ListObjectsV2 responses, one consumed per send(). */
  pages: [] as Array<{
    Contents?: Array<{ Key?: string; Size?: number }>;
    IsTruncated?: boolean;
    NextContinuationToken?: string;
  }>,
  /** The continuation token on each send(), in call order. */
  requestedTokens: [] as Array<string | undefined>,
  /** The bucket on each send(), in call order. */
  requestedBuckets: [] as string[],
  /** Set to make the next send() reject, for the storage-unreachable path. */
  failure: null as Error | null,
}));

vi.mock('@/lib/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/r2')>();
  return {
    ...actual,
    R2_BUCKET_NAME: r2.bucket,
    r2Client: {
      send: async (command: { input?: { Bucket?: string; ContinuationToken?: string } }) => {
        if (r2.failure) throw r2.failure;
        r2.requestedBuckets.push(command.input?.Bucket ?? '');
        r2.requestedTokens.push(command.input?.ContinuationToken);
        return r2.pages[r2.requestedTokens.length - 1] ?? { Contents: [], IsTruncated: false };
      },
    },
  };
});

// The snapshot lives on globalThis so it survives a Next.js server render, which
// also means it survives from one test to the next. Clear it, or a test that
// expects "no snapshot yet" passes or fails on file order.
const adminGlobals = globalThis as unknown as {
  adminR2StorageSnapshot?: unknown;
  adminR2StorageSnapshotPromise?: unknown;
};

beforeEach(() => {
  delete adminGlobals.adminR2StorageSnapshot;
  delete adminGlobals.adminR2StorageSnapshotPromise;
  r2.pages = [];
  r2.requestedTokens.length = 0;
  r2.requestedBuckets.length = 0;
  r2.failure = null;
  // Every degrade path in this module logs through logError(). Keep the suite
  // output readable without hiding a genuine failure.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Takes an R2 snapshot holding exactly these keys and sizes.
 *
 * The recorders are cleared first because the fake client picks its response by
 * call count, so a second snapshot in the same test would otherwise run off the
 * end of the script and list an empty bucket.
 */
async function snapshotBucket(fileSizes: Record<string, number>): Promise<string> {
  r2.requestedTokens.length = 0;
  r2.requestedBuckets.length = 0;
  r2.pages = [
    {
      Contents: Object.entries(fileSizes).map(([Key, Size]) => ({ Key, Size })),
      IsTruncated: false,
    },
  ];
  return refreshR2StorageSnapshot();
}

// ---------------------------------------------------------------------------
// Bunny boundary
// ---------------------------------------------------------------------------

interface BunnyPage {
  status?: number;
  body?: unknown;
}

interface BunnyCalls {
  urls: string[];
  accessKeys: Array<string | undefined>;
}

/** Answers the Bunny video-list endpoint with these pages, in order. */
function stubBunnyPages(pages: BunnyPage[]): BunnyCalls {
  const calls: BunnyCalls = { urls: [], accessKeys: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
      calls.urls.push(String(input));
      calls.accessKeys.push(init?.headers?.AccessKey);
      // Past the end of the script, answer an empty page so a runaway loop
      // terminates instead of hanging the suite.
      const page = pages[calls.urls.length - 1] ?? { body: { items: [] } };
      const status = page.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => page.body,
      };
    })
  );
  return calls;
}

/** Credentials plus a one-page library holding exactly these videos. */
function stubBunnyLibrary(sizes: Record<string, number>): BunnyCalls {
  vi.stubEnv('BUNNY_STREAM_API_KEY', 'bunny-key-for-admin-stats');
  vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '4242');
  const items = Object.entries(sizes).map(([guid, storageSize]) => ({ guid, storageSize }));
  return stubBunnyPages([{ body: { items, totalItems: items.length } }]);
}

function bunnyCredentials(): void {
  vi.stubEnv('BUNNY_STREAM_API_KEY', 'bunny-key-for-admin-stats');
  vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '4242');
}

// ---------------------------------------------------------------------------
// Download egress
// ---------------------------------------------------------------------------
// DownloadEgressEvent carries no foreign keys (see prisma/schema.prisma), so
// the ids other than billedUserId can be synthetic. There is no factory for it
// and tests/factories is shared, so the builder lives here.
async function recordDownload(billedUserId: string, estimatedBytes: bigint): Promise<void> {
  const seq = nextSeq();
  await db.downloadEgressEvent.create({
    data: {
      versionId: `egress-version-${seq}`,
      videoId: `egress-video-${seq}`,
      projectId: `egress-project-${seq}`,
      workspaceId: `egress-workspace-${seq}`,
      billedUserId,
      source: DownloadEgressSource.ORIGINAL,
      estimatedBytes,
    },
  });
}

// ---------------------------------------------------------------------------
// Stripe boundary
// ---------------------------------------------------------------------------

/** Installs a Stripe double whose price lookup answers this price. */
function stubStripePrice(price: { unit_amount?: number | null; currency?: string }): {
  retrievedPriceIds: string[];
} {
  const retrievedPriceIds: string[] = [];
  vi.mocked(getStripe as unknown as () => unknown).mockReturnValue({
    prices: {
      retrieve: vi.fn(async (priceId: string) => {
        retrievedPriceIds.push(priceId);
        return price;
      }),
    },
  });
  return { retrievedPriceIds };
}

describe('refreshR2StorageSnapshot', () => {
  it('walks every page of the bucket listing and totals the object sizes', async () => {
    r2.pages = [
      {
        Contents: [
          { Key: 'voice/one.webm', Size: 100 },
          { Key: 'images/two.png', Size: 250 },
        ],
        IsTruncated: true,
        NextContinuationToken: 'page-two',
      },
      {
        Contents: [{ Key: 'videos/three.mp4', Size: 1000 }],
        IsTruncated: false,
      },
    ];

    await refreshR2StorageSnapshot();

    expect(await getCachedTotalStorage()).toBe(1350);
    // The second request must carry the token the first one handed back, or the
    // listing silently stops at 1000 objects and every total is wrong.
    expect(r2.requestedTokens).toEqual([undefined, 'page-two']);
    expect(r2.requestedBuckets).toEqual([r2.bucket, r2.bucket]);
  });

  it('counts an object with no reported size as zero and skips one with no key', async () => {
    r2.pages = [
      {
        Contents: [
          { Key: 'voice/sizeless.webm' },
          { Key: 'images/known.png', Size: 40 },
          { Size: 999 },
        ],
        IsTruncated: false,
      },
    ];

    await refreshR2StorageSnapshot();

    expect(await getCachedTotalStorage()).toBe(40);
  });

  it('reports an empty bucket as zero bytes rather than as unavailable', async () => {
    await refreshR2StorageSnapshot();

    expect(await getCachedTotalStorage()).toBe(0);
  });

  it('answers the moment of the refresh as an ISO timestamp', async () => {
    const before = Date.now();

    const refreshedAt = await refreshR2StorageSnapshot();

    expect(refreshedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(refreshedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(refreshedAt)).toBeLessThanOrEqual(Date.now());
  });

  it('propagates a storage failure to the caller instead of storing a partial snapshot', async () => {
    await snapshotBucket({ 'images/kept.png': 77 });
    r2.failure = new Error('storage is unreachable');

    await expect(refreshR2StorageSnapshot()).rejects.toThrow('storage is unreachable');

    // The previous snapshot survives, so the dashboard keeps showing the last
    // known figure rather than dropping to the -1 sentinel.
    r2.failure = null;
    expect(await getCachedTotalStorage()).toBe(77);
  });
});

describe('getCachedTotalStorage', () => {
  it('answers -1 when no snapshot has been taken yet', async () => {
    expect(await getCachedTotalStorage()).toBe(-1);
  });

  it('never touches storage on its own, so the sentinel is not a listing failure', async () => {
    await getCachedTotalStorage();

    expect(r2.requestedTokens).toEqual([]);
  });

  it('answers the byte total of the most recent snapshot', async () => {
    await snapshotBucket({ 'images/a.png': 5 });
    expect(await getCachedTotalStorage()).toBe(5);

    await snapshotBucket({ 'images/a.png': 5, 'voice/b.webm': 15 });

    expect(await getCachedTotalStorage()).toBe(20);
  });
});

describe('getCachedBunnyStorageStats', () => {
  it('totals the library and indexes each video by its guid', async () => {
    const calls = stubBunnyLibrary({ 'bunny-one': 500, 'bunny-two': 250 });

    const stats = await getCachedBunnyStorageStats();

    expect(stats).toEqual({ totalBytes: 750, byVideoId: { 'bunny-one': 500, 'bunny-two': 250 } });
    expect(calls.urls).toHaveLength(1);
    expect(calls.urls[0]).toBe(
      'https://video.bunnycdn.com/library/4242/videos?page=1&itemsPerPage=100'
    );
    expect(calls.accessKeys).toEqual(['bunny-key-for-admin-stats']);
  });

  it('stops requesting pages once the reported item count is covered', async () => {
    bunnyCredentials();
    const calls = stubBunnyPages([
      { body: { items: [{ guid: 'bunny-one', storageSize: 10 }], totalItems: 1 } },
    ]);

    const stats = await getCachedBunnyStorageStats();

    expect(stats.totalBytes).toBe(10);
    expect(calls.urls).toHaveLength(1);
  });

  it('keeps paging when the API reports no total and stops at the first empty page', async () => {
    bunnyCredentials();
    const calls = stubBunnyPages([
      { body: { items: [{ guid: 'bunny-one', storageSize: 10 }] } },
      { body: { items: [{ guid: 'bunny-two', storageSize: 32 }] } },
      { body: { items: [] } },
    ]);

    const stats = await getCachedBunnyStorageStats();

    expect(stats).toEqual({ totalBytes: 42, byVideoId: { 'bunny-one': 10, 'bunny-two': 32 } });
    expect(calls.urls).toHaveLength(3);
    expect(calls.urls[1]).toContain('page=2');
    expect(calls.urls[2]).toContain('page=3');
  });

  it('reads the capitalised item list Bunny sometimes returns', async () => {
    bunnyCredentials();
    stubBunnyPages([{ body: { Items: [{ guid: 'bunny-one', storageSize: 64 }], TotalItems: 1 } }]);

    expect(await getCachedBunnyStorageStats()).toEqual({
      totalBytes: 64,
      byVideoId: { 'bunny-one': 64 },
    });
  });

  it('accepts any of the three size field names and treats an absent one as zero', async () => {
    bunnyCredentials();
    stubBunnyPages([
      {
        body: {
          items: [
            { guid: 'by-storage-size', storageSize: 5 },
            { guid: 'by-storage', storage: 7 },
            { guid: 'by-size', size: 11 },
            { guid: 'no-size-at-all' },
            { guid: 'negative-size', size: -400 },
          ],
          totalItems: 5,
        },
      },
    ]);

    expect(await getCachedBunnyStorageStats()).toEqual({
      totalBytes: 23,
      byVideoId: {
        'by-storage-size': 5,
        'by-storage': 7,
        'by-size': 11,
        'no-size-at-all': 0,
        'negative-size': 0,
      },
    });
  });

  it('skips an item with no guid rather than indexing it under an empty key', async () => {
    bunnyCredentials();
    stubBunnyPages([
      {
        body: {
          items: [{ storageSize: 900 }, { guid: 'bunny-one', storageSize: 3 }],
          totalItems: 2,
        },
      },
    ]);

    expect(await getCachedBunnyStorageStats()).toEqual({
      totalBytes: 3,
      byVideoId: { 'bunny-one': 3 },
    });
  });

  // -1 rather than 0 is the whole point: 0 would tell the dashboard that Bunny
  // holds nothing, and would tell getCachedUserBunnyStorage to charge every
  // user zero bytes.
  it('degrades to -1 instead of throwing when the Bunny API answers an error', async () => {
    bunnyCredentials();
    stubBunnyPages([{ status: 500, body: {} }]);

    expect(await getCachedBunnyStorageStats()).toEqual({ totalBytes: -1, byVideoId: {} });
  });

  it('degrades to -1 instead of throwing when fetch itself fails', async () => {
    bunnyCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network timeout');
      })
    );

    expect(await getCachedBunnyStorageStats()).toEqual({ totalBytes: -1, byVideoId: {} });
  });

  // The flag defaults to on, so a self-hosted deployment that never configured Bunny
  // lands here: credentials missing while the feature is nominally enabled. That used to
  // key on the flag alone, throw "Missing Bunny Stream credentials." out of
  // getBunnyConfig() and report -1, which reads as "we could not measure" rather than
  // "there is nothing to measure".
  it('reports a genuine zero when the Bunny credentials are not configured', async () => {
    vi.stubEnv('BUNNY_STREAM_API_KEY', undefined);
    vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', undefined);
    vi.stubEnv('NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID', undefined);
    const calls = stubBunnyPages([]);

    expect(await getCachedBunnyStorageStats()).toEqual({ totalBytes: 0, byVideoId: {} });
    expect(calls.urls).toEqual([]);
  });

  it('reports a genuine zero without calling Bunny when the feature flag is off', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'false');
    const calls = stubBunnyLibrary({ 'bunny-one': 500 });

    expect(await getCachedBunnyStorageStats()).toEqual({ totalBytes: 0, byVideoId: {} });
    expect(calls.urls).toEqual([]);
  });

  it('falls back to the public library id when the server-side one is unset', async () => {
    vi.stubEnv('BUNNY_STREAM_API_KEY', 'bunny-key-for-admin-stats');
    vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', undefined);
    vi.stubEnv('NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID', '7171');
    const calls = stubBunnyPages([{ body: { items: [], totalItems: 0 } }]);

    await getCachedBunnyStorageStats();

    expect(calls.urls[0]).toContain('/library/7171/videos');
  });
});

// This block is the reason the file unmocks `@/lib/admin-stats`: everywhere
// else in the api project these calls answer `{}`.
describe('getCachedUserBunnyStorage', () => {
  it('attributes each Bunny video to the owner of the project it lives in', async () => {
    const first = await seedProject();
    const second = await seedProject();
    const firstVideo = await createVideo({ projectId: first.project.id });
    const secondVideo = await createVideo({ projectId: second.project.id });
    await createVersion({
      videoParentId: firstVideo.id,
      providerId: 'bunny',
      providerVideoId: 'bunny-first',
    });
    await createVersion({
      videoParentId: secondVideo.id,
      providerId: 'bunny',
      providerVideoId: 'bunny-second',
    });
    stubBunnyLibrary({ 'bunny-first': 500, 'bunny-second': 900 });

    const perUser = await getCachedUserBunnyStorage();

    expect(perUser).toEqual({ [first.owner.id]: 500, [second.owner.id]: 900 });
  });

  it('adds up several Bunny videos owned by the same user', async () => {
    const scenario = await seedProject();
    const firstVideo = await createVideo({ projectId: scenario.project.id });
    const secondVideo = await createVideo({ projectId: scenario.project.id });
    await createVersion({
      videoParentId: firstVideo.id,
      providerId: 'bunny',
      providerVideoId: 'bunny-first',
    });
    await createVersion({
      videoParentId: secondVideo.id,
      providerId: 'bunny',
      providerVideoId: 'bunny-second',
    });
    stubBunnyLibrary({ 'bunny-first': 500, 'bunny-second': 900 });

    expect(await getCachedUserBunnyStorage()).toEqual({ [scenario.owner.id]: 1400 });
  });

  it('bills a Bunny asset to the user it records as the billed user', async () => {
    const scenario = await seedProject();
    const uploader = await createUser();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: uploader.id,
      kind: VideoAssetKind.VIDEO,
      provider: VideoAssetProvider.BUNNY,
      providerVideoId: 'bunny-asset',
    });
    stubBunnyLibrary({ 'bunny-asset': 1234 });

    const perUser = await getCachedUserBunnyStorage();

    expect(perUser).toEqual({ [uploader.id]: 1234 });
    expect(perUser[scenario.owner.id]).toBeUndefined();
  });

  // Two versions of the same Bunny video (a relabelled upload, say) are one
  // object in the library, so charging the owner twice would inflate the number
  // that lib/storage-quota.ts checks an upload against.
  it('counts a Bunny video once per user however many rows point at it', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVersion({
      videoParentId: video.id,
      versionNumber: 1,
      providerId: 'bunny',
      providerVideoId: 'bunny-shared',
    });
    await createVersion({
      videoParentId: video.id,
      versionNumber: 2,
      providerId: 'bunny',
      providerVideoId: 'bunny-shared',
    });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      kind: VideoAssetKind.VIDEO,
      provider: VideoAssetProvider.BUNNY,
      providerVideoId: 'bunny-shared',
    });
    stubBunnyLibrary({ 'bunny-shared': 700 });

    expect(await getCachedUserBunnyStorage()).toEqual({ [scenario.owner.id]: 700 });
  });

  it('ignores versions and assets that are not on Bunny', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVersion({
      videoParentId: video.id,
      providerId: 'r2',
      providerVideoId: 'bunny-first',
    });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      provider: VideoAssetProvider.R2_IMAGE,
    });
    stubBunnyLibrary({ 'bunny-first': 500 });

    expect(await getCachedUserBunnyStorage()).toEqual({});
  });

  // An orphan: the row still names a Bunny video that the library no longer
  // holds. It has to resolve to zero bytes rather than to undefined, or the
  // arithmetic downstream turns into NaN.
  it('charges zero for a Bunny video the library no longer knows about', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVersion({
      videoParentId: video.id,
      providerId: 'bunny',
      providerVideoId: 'bunny-deleted-upstream',
    });
    stubBunnyLibrary({ 'bunny-still-there': 4096 });

    const perUser = await getCachedUserBunnyStorage();

    expect(perUser).toEqual({ [scenario.owner.id]: 0 });
    expect(Number.isNaN(perUser[scenario.owner.id])).toBe(false);
  });

  // The -1 sentinel means "Bunny did not answer", and the module must not turn
  // that into "this user stores nothing", because lib/storage-quota.ts would then
  // hand out headroom the user does not have. Bunny's figure is gone; the size
  // declared when the upload was admitted is still in our own rows, so that is
  // what the account is charged until Bunny can be reached again.
  it('falls back to the declared sizes when the Bunny library could not be read', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVersion({
      videoParentId: video.id,
      providerId: 'bunny',
      providerVideoId: 'bunny-first',
      sizeBytes: BigInt(2048),
    });
    bunnyCredentials();
    stubBunnyPages([{ status: 503, body: {} }]);

    expect(await getCachedUserBunnyStorage()).toEqual({ [scenario.owner.id]: 2048 });
  });

  it('is empty on a database with no videos at all', async () => {
    stubBunnyLibrary({ 'bunny-orphan': 999 });

    expect(await getCachedUserBunnyStorage()).toEqual({});
  });
});

describe('getCachedUserMediaStorage', () => {
  it('splits a user comment media into voice and image and totals both', async () => {
    const scenario = await seedVersion();
    await createComment({
      versionId: scenario.version.id,
      voiceUrl: '/api/upload/audio/note.webm',
      imageUrl: '/api/upload/image/shot.png',
    });
    await snapshotBucket({ 'voice/note.webm': 300, 'images/shot.png': 700 });

    expect(await getCachedUserMediaStorage()).toEqual({
      [scenario.owner.id]: { total: 1000, voice: 300, image: 700 },
    });
  });

  // Comment media is billed through the workspace owner, matching the join in
  // lib/storage-quota.ts, not through the owner of the project the comment
  // happens to sit in.
  it('bills comment media to the workspace owner rather than the project owner', async () => {
    const workspaceOwner = await createUser();
    const projectOwner = await createUser();
    const workspace = await createWorkspace({ ownerId: workspaceOwner.id });
    const project = await createProject({
      ownerId: projectOwner.id,
      workspaceId: workspace.id,
    });
    const video = await createVideo({ projectId: project.id });
    const version = await createVersion({ videoParentId: video.id });
    await createComment({ versionId: version.id, voiceUrl: '/api/upload/audio/note.webm' });
    await snapshotBucket({ 'voice/note.webm': 120 });

    const perUser = await getCachedUserMediaStorage();

    expect(perUser).toEqual({ [workspaceOwner.id]: { total: 120, voice: 120, image: 0 } });
    expect(perUser[projectOwner.id]).toBeUndefined();
  });

  it('adds R2 image and audio assets to the user they are billed to', async () => {
    const scenario = await seedProject();
    const uploader = await createUser();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: uploader.id,
      provider: VideoAssetProvider.R2_IMAGE,
      sourceUrl: '/api/upload/image/asset.png',
    });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: uploader.id,
      kind: VideoAssetKind.AUDIO,
      provider: VideoAssetProvider.R2_AUDIO,
      sourceUrl: '/api/upload/audio/asset.webm',
    });
    await snapshotBucket({ 'images/asset.png': 11, 'voice/asset.webm': 22 });

    expect(await getCachedUserMediaStorage()).toEqual({
      [uploader.id]: { total: 33, voice: 22, image: 11 },
    });
  });

  it('leaves video and Bunny assets out, since they are not comment media', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      kind: VideoAssetKind.VIDEO,
      provider: VideoAssetProvider.R2_VIDEO,
      sourceUrl: '/api/upload/video/movie.mp4',
    });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      kind: VideoAssetKind.VIDEO,
      provider: VideoAssetProvider.BUNNY,
      providerVideoId: 'bunny-one',
      sourceUrl: '/api/upload/video/other.mp4',
    });
    await snapshotBucket({ 'images/movie.mp4': 5000, 'voice/other.mp4': 5000 });

    expect(await getCachedUserMediaStorage()).toEqual({});
  });

  // The same object reached through both a comment row and an asset row is one
  // object in the bucket, so it must be charged once.
  it('counts an object once when both a comment and an asset point at it', async () => {
    const scenario = await seedVersion();
    await createComment({
      versionId: scenario.version.id,
      imageUrl: '/api/upload/image/same.png',
    });
    await createVideoAsset({
      videoId: scenario.video.id,
      billedUserId: scenario.owner.id,
      provider: VideoAssetProvider.R2_IMAGE,
      sourceUrl: '/api/upload/image/same.png',
    });
    await snapshotBucket({ 'images/same.png': 640 });

    expect(await getCachedUserMediaStorage()).toEqual({
      [scenario.owner.id]: { total: 640, voice: 0, image: 640 },
    });
  });

  it('keeps one user media out of another user total', async () => {
    const first = await seedVersion();
    const second = await seedVersion();
    await createComment({
      versionId: first.version.id,
      imageUrl: '/api/upload/image/first.png',
    });
    await createComment({
      versionId: second.version.id,
      imageUrl: '/api/upload/image/second.png',
    });
    await snapshotBucket({ 'images/first.png': 100, 'images/second.png': 900 });

    expect(await getCachedUserMediaStorage()).toEqual({
      [first.owner.id]: { total: 100, voice: 0, image: 100 },
      [second.owner.id]: { total: 900, voice: 0, image: 900 },
    });
  });

  // An orphaned row: the comment still names a file that is no longer in the
  // bucket. The user must still appear, at zero, rather than vanish or count
  // NaN bytes.
  it('charges zero for a comment whose file is no longer in the bucket', async () => {
    const scenario = await seedVersion();
    await createComment({
      versionId: scenario.version.id,
      voiceUrl: '/api/upload/audio/deleted.webm',
    });
    await snapshotBucket({ 'images/unrelated.png': 4096 });

    expect(await getCachedUserMediaStorage()).toEqual({
      [scenario.owner.id]: { total: 0, voice: 0, image: 0 },
    });
  });

  it('ignores comments that carry no media at all', async () => {
    const scenario = await seedVersion();
    await createComment({ versionId: scenario.version.id, content: 'just text' });
    await snapshotBucket({ 'images/unrelated.png': 4096 });

    expect(await getCachedUserMediaStorage()).toEqual({});
  });

  it('is empty on an empty database', async () => {
    await snapshotBucket({ 'images/orphan.png': 4096 });

    expect(await getCachedUserMediaStorage()).toEqual({});
  });

  // Without a snapshot the module cannot size anything, and it answers an empty
  // map rather than a map full of zeros. The difference matters: zeros would
  // read on the dashboard as "this user stores nothing".
  it('answers an empty map when no R2 snapshot has been taken', async () => {
    const scenario = await seedVersion();
    await createComment({
      versionId: scenario.version.id,
      imageUrl: '/api/upload/image/shot.png',
    });

    expect(await getCachedUserMediaStorage()).toEqual({});
  });
});

describe('getCachedUserDownloadEgress', () => {
  it('sums the estimated bytes of every download billed to a user', async () => {
    const first = await createUser();
    const second = await createUser();
    await recordDownload(first.id, BigInt(1000));
    await recordDownload(first.id, BigInt(2500));
    await recordDownload(second.id, BigInt(7));

    expect(await getCachedUserDownloadEgress()).toEqual({
      [first.id]: 3500,
      [second.id]: 7,
    });
  });

  it('is empty when nothing has been downloaded', async () => {
    await createUser();

    expect(await getCachedUserDownloadEgress()).toEqual({});
  });

  it('reports zero for a user whose downloads all measured zero bytes', async () => {
    const user = await createUser();
    await recordDownload(user.id, BigInt(0));

    expect(await getCachedUserDownloadEgress()).toEqual({ [user.id]: 0 });
  });

  // estimatedBytes is a BigInt column and the dashboard wants a number. A
  // 9 PB total is not realistic, but the conversion is the same one every row
  // goes through, and the answer must be bytes rather than any other unit.
  it('returns the sum in bytes, not in any larger unit', async () => {
    const user = await createUser();
    await recordDownload(user.id, BigInt(5) * BigInt(1024) * BigInt(1024));

    expect(await getCachedUserDownloadEgress()).toEqual({ [user.id]: 5_242_880 });
  });

  it('carries a sum that fits in a double across exactly', async () => {
    const user = await createUser();
    await recordDownload(user.id, BigInt(Number.MAX_SAFE_INTEGER));

    expect(await getCachedUserDownloadEgress()).toEqual({ [user.id]: 9_007_199_254_740_991 });
  });

  // Past 2^53 a Number() cast silently rounds. The module clamps instead, so an
  // absurd total reads as "at the ceiling" rather than as a quietly wrong
  // figure.
  it('clamps a sum beyond the safe integer range instead of rounding it', async () => {
    const user = await createUser();
    await recordDownload(user.id, BigInt(Number.MAX_SAFE_INTEGER));
    await recordDownload(user.id, BigInt(1000));

    expect(await getCachedUserDownloadEgress()).toEqual({ [user.id]: Number.MAX_SAFE_INTEGER });
  });
});

describe('getCachedStripeStats', () => {
  beforeEach(() => {
    // getStripe() is mocked in tests/setup/api.ts and its implementation is
    // module state, so it survives afterEach. Reset it so no test inherits
    // another test's price.
    vi.mocked(getStripe as unknown as () => unknown).mockReset();
    vi.stubEnv('STRIPE_PRICE_ID', 'price_admin_stats_test');
  });

  it('counts users by subscription status and prices the active ones', async () => {
    await createUser({ subscriptionStatus: 'ACTIVE' });
    await createUser({ subscriptionStatus: 'ACTIVE' });
    await createUser({ subscriptionStatus: 'TRIALING' });
    await createUser({ subscriptionStatus: 'PAST_DUE' });
    await createUser({ subscriptionStatus: 'CANCELED' });
    // Free means free: no trial left to run, or these would be counted as the
    // cardless trials they would then be.
    await createUser({ subscriptionStatus: 'FREE', trialEndsAt: null });
    await createUser({ subscriptionStatus: 'FREE', trialEndsAt: null });
    await createUser({ subscriptionStatus: 'FREE', trialEndsAt: null });
    const stripe = stubStripePrice({ unit_amount: 1900, currency: 'eur' });

    expect(await getCachedStripeStats()).toEqual({
      activeSubscribers: 2,
      trialingUsers: 1,
      pastDueUsers: 1,
      canceledUsers: 1,
      freeUsers: 3,
      otherStatusUsers: 0,
      mrrCents: 3800,
      currency: 'eur',
    });
    expect(stripe.retrievedPriceIds).toEqual(['price_admin_stats_test']);
  });

  // The cardless trial writes only trialEndsAt, so the account sits at FREE with no
  // Stripe subscription behind it. Counting the status column alone reported every
  // one of them as a free user and left "On Trial" at zero on the dashboard.
  it('counts a cardless trial as trialing rather than as free', async () => {
    await createUser({ subscriptionStatus: 'FREE', trialEndsAt: new Date(Date.now() + 60_000) });
    await createUser({ subscriptionStatus: 'FREE', trialEndsAt: null });
    stubStripePrice({ unit_amount: 1900, currency: 'usd' });

    const stats = await getCachedStripeStats();

    expect(stats?.trialingUsers).toBe(1);
    expect(stats?.freeUsers).toBe(1);
  });

  it('counts an expired trial back as a free user', async () => {
    await createUser({ subscriptionStatus: 'FREE', trialEndsAt: new Date(Date.now() - 60_000) });
    stubStripePrice({ unit_amount: 1900, currency: 'usd' });

    const stats = await getCachedStripeStats();

    expect(stats?.trialingUsers).toBe(0);
    expect(stats?.freeUsers).toBe(1);
  });

  // A Stripe trial is already TRIALING and is not sitting in the FREE bucket, so it
  // must not be added on top of the cardless count.
  it('does not double count a Stripe trial that also carries a trial end date', async () => {
    await createUser({
      subscriptionStatus: 'TRIALING',
      trialEndsAt: new Date(Date.now() + 60_000),
    });
    stubStripePrice({ unit_amount: 1900, currency: 'usd' });

    const stats = await getCachedStripeStats();

    expect(stats?.trialingUsers).toBe(1);
    expect(stats?.freeUsers).toBe(0);
  });

  // UNPAID, INCOMPLETE and INCOMPLETE_EXPIRED are real values of the enum that used to
  // belong to none of the reported buckets, so those users were counted nowhere and the
  // five totals silently did not add up to the user table. They must not be folded into
  // one of the five either.
  it('counts the statuses the five named buckets do not cover', async () => {
    await createUser({ subscriptionStatus: 'UNPAID' });
    await createUser({ subscriptionStatus: 'INCOMPLETE' });
    await createUser({ subscriptionStatus: 'INCOMPLETE_EXPIRED' });
    stubStripePrice({ unit_amount: 1900, currency: 'usd' });

    const stats = await getCachedStripeStats();

    expect(stats).toEqual({
      activeSubscribers: 0,
      trialingUsers: 0,
      pastDueUsers: 0,
      canceledUsers: 0,
      freeUsers: 0,
      otherStatusUsers: 3,
      mrrCents: 0,
      currency: 'usd',
    });
  });

  it('reports zeros and no revenue on an empty database', async () => {
    stubStripePrice({ unit_amount: 1900, currency: 'usd' });

    expect(await getCachedStripeStats()).toEqual({
      activeSubscribers: 0,
      trialingUsers: 0,
      pastDueUsers: 0,
      canceledUsers: 0,
      freeUsers: 0,
      otherStatusUsers: 0,
      mrrCents: 0,
      currency: 'usd',
    });
  });

  // The user counts come from the database and are still true when Stripe is
  // down, so the module keeps them and only the revenue figure degrades.
  it('keeps the user counts and degrades the revenue to zero usd when Stripe fails', async () => {
    await createUser({ subscriptionStatus: 'ACTIVE' });
    await createUser({ subscriptionStatus: 'TRIALING' });
    vi.mocked(getStripe as unknown as () => unknown).mockImplementation(() => {
      throw new Error('Stripe is unreachable');
    });

    expect(await getCachedStripeStats()).toEqual({
      activeSubscribers: 1,
      trialingUsers: 1,
      pastDueUsers: 0,
      canceledUsers: 0,
      freeUsers: 0,
      otherStatusUsers: 0,
      mrrCents: 0,
      currency: 'usd',
    });
  });

  it('degrades the revenue when the price lookup itself rejects', async () => {
    await createUser({ subscriptionStatus: 'ACTIVE' });
    vi.mocked(getStripe as unknown as () => unknown).mockReturnValue({
      prices: {
        retrieve: vi.fn(async () => {
          throw new Error('price not found');
        }),
      },
    });

    const stats = await getCachedStripeStats();

    expect(stats?.activeSubscribers).toBe(1);
    expect(stats?.mrrCents).toBe(0);
    expect(stats?.currency).toBe('usd');
  });

  // Each plan and interval is priced from its own Stripe price, a yearly price
  // counts a twelfth, and storage blocks are priced at their interval's price.
  it('prices each plan and its storage blocks per month', async () => {
    vi.stubEnv('STRIPE_PRICE_ID_STUDIO_YEARLY', 'price_admin_studio_year');
    vi.stubEnv('STRIPE_PRICE_ID_STORAGE_YEARLY', 'price_admin_storage_year');
    const studio = await createUser({ subscriptionStatus: 'ACTIVE' });
    await db.user.update({
      where: { id: studio.id },
      data: { billingPlan: 'STUDIO', billingInterval: 'YEAR', storageBlocks: 2 },
    });
    await createUser({ subscriptionStatus: 'ACTIVE' });
    // A different amount per price, so swapping the plan and block prices, or a
    // monthly and a yearly one, changes the total.
    const amounts: Record<string, number> = {
      price_admin_stats_test: 1000,
      price_admin_studio_year: 29000,
      price_admin_storage_year: 5000,
    };
    const retrieved: string[] = [];
    vi.mocked(getStripe as unknown as () => unknown).mockReturnValue({
      prices: {
        retrieve: vi.fn(async (priceId: string) => {
          retrieved.push(priceId);
          return { unit_amount: amounts[priceId], currency: 'usd' };
        }),
      },
    });

    const stats = await getCachedStripeStats();

    // Solo monthly 1000, plus (29000 Studio yearly + 2 x 5000 storage yearly) / 12 = 3250.
    expect(stats?.mrrCents).toBe(4250);
    expect([...retrieved].sort()).toEqual(
      ['price_admin_stats_test', 'price_admin_storage_year', 'price_admin_studio_year'].sort()
    );
  });

  it('treats a price with no unit amount as free rather than as NaN', async () => {
    await createUser({ subscriptionStatus: 'ACTIVE' });
    stubStripePrice({ unit_amount: null, currency: 'gbp' });

    const stats = await getCachedStripeStats();

    expect(stats?.mrrCents).toBe(0);
    expect(stats?.currency).toBe('gbp');
  });

  it('answers null without querying Stripe when the billing flag is off', async () => {
    await createUser({ subscriptionStatus: 'ACTIVE' });
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');
    const stripe = stubStripePrice({ unit_amount: 1900, currency: 'usd' });

    expect(await getCachedStripeStats()).toBeNull();
    expect(stripe.retrievedPriceIds).toEqual([]);
  });

  it('answers null when the flag is on but Stripe is not configured', async () => {
    await createUser({ subscriptionStatus: 'ACTIVE' });
    vi.stubEnv('STRIPE_SECRET_KEY', undefined);

    expect(await getCachedStripeStats()).toBeNull();
  });
});

// The per-user figure the quota checks read, which deliberately does not come
// from the cached map above.
//
// The bug this exists for: the declared size lands on the row at the moment an
// upload finalizes and the reservation is deleted in the same transaction. A map
// computed up to two minutes earlier does not have that row in it, so for those
// two minutes the upload that just succeeded counted as nothing. The uploader
// watched their usage fall back to zero and the next upload was measured against
// a total that ignored the one before it.
describe('getUserBunnyStorageBytes', () => {
  it('counts a finished upload straight away, without waiting for Bunny', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    // Bunny has the video but reports nothing for it yet, which is what an
    // encode in progress looks like.
    stubBunnyLibrary({ 'bunny-encoding': 0 });
    await createVersion({
      videoParentId: video.id,
      providerId: 'bunny',
      providerVideoId: 'bunny-encoding',
      sizeBytes: BigInt(2_500_000_000),
    });

    expect(await getUserBunnyStorageBytes(scenario.owner.id)).toBe(2_500_000_000);
  });

  // What Bunny reports mid-encode is partial: it counts what has been written so
  // far and climbs as each rendition lands. A 2.5 GB source read as 475 MB
  // halfway through and settled above 3 GB once it finished. Letting the partial
  // figure displace the declared size would hand most of the quota back in the
  // middle of an encode, which is exactly what the declared size is there to stop.
  it('keeps the declared size while Bunny figure is still climbing', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVersion({
      videoParentId: video.id,
      providerId: 'bunny',
      providerVideoId: 'bunny-encoding',
      sizeBytes: BigInt(2_500_000_000),
    });
    stubBunnyLibrary({ 'bunny-encoding': 474_900_000 });

    expect(await getUserBunnyStorageBytes(scenario.owner.id)).toBe(2_500_000_000);
  });

  // And gets out of the way once the renditions are all there, because they are
  // the actual bill and they add up to more than the source.
  it('takes Bunny own figure once it passes the declared size', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVersion({
      videoParentId: video.id,
      providerId: 'bunny',
      providerVideoId: 'bunny-encoded',
      sizeBytes: BigInt(2_500_000_000),
    });
    stubBunnyLibrary({ 'bunny-encoded': 3_600_000_000 });

    expect(await getUserBunnyStorageBytes(scenario.owner.id)).toBe(3_600_000_000);
  });

  it('counts only the videos billed to the user asked about', async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    const myVideo = await createVideo({ projectId: mine.project.id });
    const theirVideo = await createVideo({ projectId: theirs.project.id });
    await createVersion({
      videoParentId: myVideo.id,
      providerId: 'bunny',
      providerVideoId: 'bunny-mine',
      sizeBytes: BigInt(700),
    });
    await createVersion({
      videoParentId: theirVideo.id,
      providerId: 'bunny',
      providerVideoId: 'bunny-theirs',
      sizeBytes: BigInt(900),
    });
    stubBunnyLibrary({ 'bunny-mine': 0, 'bunny-theirs': 0 });

    expect(await getUserBunnyStorageBytes(mine.owner.id)).toBe(700);
    expect(await getUserBunnyStorageBytes(theirs.owner.id)).toBe(900);
  });

  it('adds Bunny assets to the user they are billed to, deduped against versions', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVersion({
      videoParentId: video.id,
      providerId: 'bunny',
      providerVideoId: 'bunny-shared',
      sizeBytes: BigInt(500),
    });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      kind: VideoAssetKind.VIDEO,
      provider: VideoAssetProvider.BUNNY,
      providerVideoId: 'bunny-shared',
      sizeBytes: BigInt(500),
    });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      kind: VideoAssetKind.VIDEO,
      provider: VideoAssetProvider.BUNNY,
      providerVideoId: 'bunny-asset-only',
      sizeBytes: BigInt(300),
    });
    stubBunnyLibrary({ 'bunny-shared': 0, 'bunny-asset-only': 0 });

    // The shared id is one video however many rows point at it.
    expect(await getUserBunnyStorageBytes(scenario.owner.id)).toBe(800);
  });

  it('is zero for a user with no Bunny videos', async () => {
    const scenario = await seedProject();
    stubBunnyLibrary({ 'bunny-someone-else': 999 });

    expect(await getUserBunnyStorageBytes(scenario.owner.id)).toBe(0);
  });
});
