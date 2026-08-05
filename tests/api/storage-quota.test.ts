// Exercises lib/storage-quota.ts against real Postgres.
//
// This is the one place in the suite where the interesting behaviour lives in
// SQL rather than in TypeScript: `reserveStorageQuota` takes a per-user
// advisory transaction lock (pg_advisory_xact_lock over a 64-bit md5 hash) so
// that two simultaneous uploads see each other's in-flight reservations instead
// of both measuring the same headroom. A mocked Prisma client cannot show that
// either way, and no amount of clicking in the app can either.
//
// Note on BigInt: tsconfig targets ES2017 so a `1n` literal is a compile error.
// Always BigInt(1), and always compare BigInt against BigInt.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getCachedUserBunnyStorage } from '@/lib/admin-stats';
import {
  PLAN_STORAGE_LIMIT_BYTES,
  enforceStorageQuota,
  getUserStorageInfo,
  getUserTotalStorageBytes,
  releaseStorageReservation,
  reserveStorageQuota,
} from '@/lib/storage-quota';
import { GET as getStorageSettings } from '@/app/api/settings/storage/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  createExpiredUser,
  createProject,
  createSubscribedUser,
  createUploadReservation,
  createUser,
  createVersion,
  createVideo,
  createVideoAsset,
  createWorkspace,
  seedProject,
} from '../factories';

const GIB = BigInt(1024) * BigInt(1024) * BigInt(1024);

function bunnyStorage(map: Record<string, number>): void {
  vi.mocked(getCachedUserBunnyStorage).mockResolvedValue(map);
}

// The mock implementation is module state, so it survives afterEach. Reset it so
// no test inherits another test's Bunny figures.
beforeEach(() => {
  bunnyStorage({});
});

/** Bytes of headroom left before the plan limit, as a bigint. */
function headroom(usedBytes: bigint): bigint {
  return PLAN_STORAGE_LIMIT_BYTES - usedBytes;
}

describe('PLAN_STORAGE_LIMIT_BYTES', () => {
  it('is 200 GiB', () => {
    expect(PLAN_STORAGE_LIMIT_BYTES).toBe(BigInt(200) * GIB);
  });
});

// Everything else in this file bills a subscribed account, because the plan
// ceiling and the advisory lock are what those tests are about. This block is
// the other half: the same code paths, held to the trial ceiling instead.
describe('the trial ceiling', () => {
  it('reports the trial limit rather than the plan limit for a trial account', async () => {
    const user = await createUser();

    expect((await getUserStorageInfo(user.id)).limitBytes).toBe(BigInt(3) * GIB);
  });

  it('refuses an upload that a paying account of the same size would be allowed', async () => {
    const trialUser = await createUser();
    const paidUser = await createSubscribedUser();
    const fourGiB = BigInt(4) * GIB;

    expect((await enforceStorageQuota(trialUser.id, fourGiB))?.status).toBe(507);
    expect(await enforceStorageQuota(paidUser.id, fourGiB)).toBeNull();
  });

  it('holds a reservation to the trial ceiling too, not only the plain check', async () => {
    const user = await createUser();
    await createUploadReservation({ billedUserId: user.id, sizeBytes: BigInt(2) * GIB });

    const result = await reserveStorageQuota(user.id, BigInt(2) * GIB);

    expect('error' in result).toBe(true);
    expect((result as { error: Response }).error.status).toBe(507);
  });

  it('still lets a trial account upload inside its own ceiling', async () => {
    const user = await createUser();

    const result = await reserveStorageQuota(user.id, BigInt(1) * GIB);

    expect('reservationId' in result).toBe(true);
  });
});

describe('getUserTotalStorageBytes', () => {
  it('is zero for a user with nothing stored', async () => {
    const user = await createSubscribedUser();

    expect(await getUserTotalStorageBytes(user.id)).toBe(BigInt(0));
  });

  it('sums R2 image, audio and video assets billed to the user', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      provider: 'R2_IMAGE',
      sizeBytes: BigInt(100),
    });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      provider: 'R2_AUDIO',
      sizeBytes: BigInt(200),
    });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      provider: 'R2_VIDEO',
      sizeBytes: BigInt(400),
    });

    expect(await getUserTotalStorageBytes(scenario.owner.id)).toBe(BigInt(700));
  });

  it('ignores assets billed to somebody else and non-R2 providers', async () => {
    const scenario = await seedProject();
    const other = await createSubscribedUser();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: other.id,
      provider: 'R2_IMAGE',
      sizeBytes: BigInt(9999),
    });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      provider: 'YOUTUBE',
      sizeBytes: BigInt(9999),
    });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      provider: 'BUNNY',
      providerVideoId: 'bunny-1',
      sizeBytes: BigInt(9999),
    });

    expect(await getUserTotalStorageBytes(scenario.owner.id)).toBe(BigInt(0));
  });

  // Versions are billed through the workspace owner, not through the project
  // owner or the uploader, which is what the join in the raw SQL encodes.
  it('sums r2 video versions through the workspace owner', async () => {
    const workspaceOwner = await createSubscribedUser();
    const workspace = await createWorkspace({ ownerId: workspaceOwner.id });
    const projectOwner = await createSubscribedUser();
    const project = await createProject({
      ownerId: projectOwner.id,
      workspaceId: workspace.id,
    });
    const video = await createVideo({ projectId: project.id });
    await createVersion({
      videoParentId: video.id,
      providerId: 'r2',
      sizeBytes: BigInt(5000),
    });
    await createVersion({
      videoParentId: video.id,
      versionNumber: 2,
      providerId: 'youtube',
      sizeBytes: BigInt(9999),
    });

    expect(await getUserTotalStorageBytes(workspaceOwner.id)).toBe(BigInt(5000));
    expect(await getUserTotalStorageBytes(projectOwner.id)).toBe(BigInt(0));
  });

  it('counts active reservations and ignores expired ones', async () => {
    const user = await createSubscribedUser();
    await createUploadReservation({ billedUserId: user.id, sizeBytes: BigInt(1000) });
    await createUploadReservation({
      billedUserId: user.id,
      sizeBytes: BigInt(500_000),
      expiresInMs: -60_000,
    });

    expect(await getUserTotalStorageBytes(user.id)).toBe(BigInt(1000));
  });

  it('adds the Bunny Stream bytes reported for the user', async () => {
    const user = await createSubscribedUser();
    bunnyStorage({ [user.id]: 12_345 });

    expect(await getUserTotalStorageBytes(user.id)).toBe(BigInt(12_345));
  });
});

describe('getUserStorageInfo', () => {
  it('reports the percentage to two decimal places', async () => {
    const user = await createSubscribedUser();
    await createUploadReservation({
      billedUserId: user.id,
      sizeBytes: BigInt(50) * GIB,
    });

    const info = await getUserStorageInfo(user.id);

    expect(info.limitBytes).toBe(PLAN_STORAGE_LIMIT_BYTES);
    expect(info.usedBytes).toBe(BigInt(50) * GIB);
    expect(info.percentage).toBe(25);
  });

  it('clamps the percentage at 100 when usage exceeds the limit', async () => {
    const user = await createSubscribedUser();
    await createUploadReservation({
      billedUserId: user.id,
      sizeBytes: PLAN_STORAGE_LIMIT_BYTES * BigInt(3),
    });

    expect((await getUserStorageInfo(user.id)).percentage).toBe(100);
  });
});

describe('enforceStorageQuota', () => {
  it('allows an upload that stays under the limit', async () => {
    const user = await createSubscribedUser();

    expect(await enforceStorageQuota(user.id, BigInt(1024))).toBeNull();
  });

  // The route uses `>=`, so a user sitting exactly on the limit is blocked
  // rather than allowed one more byte.
  it('rejects an upload that lands exactly on the limit', async () => {
    const user = await createSubscribedUser();
    await createUploadReservation({
      billedUserId: user.id,
      sizeBytes: PLAN_STORAGE_LIMIT_BYTES - BigInt(1024),
    });

    const response = await enforceStorageQuota(user.id, BigInt(1024));

    expect(response?.status).toBe(507);
  });

  it('allows an upload one byte short of the limit', async () => {
    const user = await createSubscribedUser();
    await createUploadReservation({
      billedUserId: user.id,
      sizeBytes: PLAN_STORAGE_LIMIT_BYTES - BigInt(1024),
    });

    expect(await enforceStorageQuota(user.id, BigInt(1023))).toBeNull();
  });

  it('skips the check entirely when Stripe is disabled', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');
    const user = await createSubscribedUser();
    await createUploadReservation({
      billedUserId: user.id,
      sizeBytes: PLAN_STORAGE_LIMIT_BYTES,
    });

    expect(await enforceStorageQuota(user.id, PLAN_STORAGE_LIMIT_BYTES)).toBeNull();
  });
});

describe('reserveStorageQuota', () => {
  it('writes a reservation row billed to the user with the requested size', async () => {
    const user = await createSubscribedUser();

    const result = await reserveStorageQuota(user.id, BigInt(4096));

    expect('reservationId' in result).toBe(true);
    const reservation = await db.uploadReservation.findFirstOrThrow();
    expect('reservationId' in result && result.reservationId).toBe(reservation.id);
    expect(reservation.billedUserId).toBe(user.id);
    expect(reservation.sizeBytes).toBe(BigInt(4096));
    expect(reservation.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns a null reservation id and writes nothing when Stripe is disabled', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');
    const user = await createSubscribedUser();

    const result = await reserveStorageQuota(user.id, BigInt(4096));

    expect(result).toEqual({ reservationId: null });
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('refuses a reservation that would cross the limit and writes no row', async () => {
    const user = await createSubscribedUser();
    await createUploadReservation({
      billedUserId: user.id,
      sizeBytes: PLAN_STORAGE_LIMIT_BYTES - BigInt(1024),
    });

    const result = await reserveStorageQuota(user.id, BigInt(2048));

    expect('error' in result).toBe(true);
    expect('error' in result && result.error.status).toBe(507);
    expect(await db.uploadReservation.count()).toBe(1);
  });

  it('counts committed R2 assets against the reservation', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      provider: 'R2_VIDEO',
      sizeBytes: PLAN_STORAGE_LIMIT_BYTES - BigInt(100),
    });

    const result = await reserveStorageQuota(scenario.owner.id, BigInt(200));

    expect('error' in result).toBe(true);
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('counts Bunny Stream bytes against the reservation', async () => {
    const user = await createSubscribedUser();
    bunnyStorage({ [user.id]: Number(PLAN_STORAGE_LIMIT_BYTES - BigInt(1024)) });

    const result = await reserveStorageQuota(user.id, BigInt(2048));

    expect('error' in result).toBe(true);
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('ignores an expired reservation when computing headroom', async () => {
    const user = await createSubscribedUser();
    await createUploadReservation({
      billedUserId: user.id,
      sizeBytes: PLAN_STORAGE_LIMIT_BYTES - BigInt(1024),
      expiresInMs: -60_000,
    });

    const result = await reserveStorageQuota(user.id, BigInt(2048));

    expect('reservationId' in result).toBe(true);
  });

  it('does not let one user reservations reduce another user headroom', async () => {
    const heavy = await createSubscribedUser();
    const light = await createSubscribedUser();
    await createUploadReservation({
      billedUserId: heavy.id,
      sizeBytes: PLAN_STORAGE_LIMIT_BYTES - BigInt(1024),
    });

    const result = await reserveStorageQuota(light.id, BigInt(10) * GIB);

    expect('reservationId' in result).toBe(true);
  });

  // The reason lib/storage-quota.ts holds an advisory lock at all. Both calls
  // start before either commits, so without serialisation both read the same
  // "used" figure, both see enough headroom, and the user ends up over quota.
  it('serialises two concurrent reservations so only one fits the remaining headroom', async () => {
    const user = await createSubscribedUser();
    const used = PLAN_STORAGE_LIMIT_BYTES - BigInt(30) * GIB;
    await createUploadReservation({ billedUserId: user.id, sizeBytes: used });
    // 30 GiB of headroom, and each request wants 20 GiB.
    const request = BigInt(20) * GIB;
    expect(headroom(used)).toBe(BigInt(30) * GIB);

    const [first, second] = await Promise.all([
      reserveStorageQuota(user.id, request),
      reserveStorageQuota(user.id, request),
    ]);

    const granted = [first, second].filter((result) => 'reservationId' in result);
    const refused = [first, second].filter((result) => 'error' in result);

    expect(granted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as { error: Response }).error.status).toBe(507);

    // The decisive assertion: total reserved bytes never exceed the plan limit.
    const total = await db.uploadReservation.aggregate({
      where: { billedUserId: user.id },
      _sum: { sizeBytes: true },
    });
    expect(total._sum.sizeBytes).toBe(used + request);
    expect(total._sum.sizeBytes! < PLAN_STORAGE_LIMIT_BYTES).toBe(true);
    expect(await db.uploadReservation.count()).toBe(2);
  });

  it('grants both concurrent reservations when there is room for both', async () => {
    const user = await createSubscribedUser();
    const request = BigInt(20) * GIB;

    const results = await Promise.all([
      reserveStorageQuota(user.id, request),
      reserveStorageQuota(user.id, request),
    ]);

    expect(results.every((result) => 'reservationId' in result)).toBe(true);
    const total = await db.uploadReservation.aggregate({ _sum: { sizeBytes: true } });
    expect(total._sum.sizeBytes).toBe(request * BigInt(2));
  });

  it('serialises five concurrent reservations, granting exactly the number that fit', async () => {
    const user = await createSubscribedUser();
    const used = PLAN_STORAGE_LIMIT_BYTES - BigInt(50) * GIB;
    await createUploadReservation({ billedUserId: user.id, sizeBytes: used });
    const request = BigInt(20) * GIB;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserveStorageQuota(user.id, request))
    );

    const granted = results.filter((result) => 'reservationId' in result);
    // 50 GiB of headroom, 20 GiB each, and the check is >= so the third would
    // land exactly on the limit and is refused.
    expect(granted).toHaveLength(2);

    const total = await db.uploadReservation.aggregate({ _sum: { sizeBytes: true } });
    expect(total._sum.sizeBytes).toBe(used + request * BigInt(2));
    expect(total._sum.sizeBytes! < PLAN_STORAGE_LIMIT_BYTES).toBe(true);
  });

  // Different users hash to different advisory lock keys, so they must not
  // block each other.
  it('does not serialise reservations for different users', async () => {
    const first = await createSubscribedUser();
    const second = await createSubscribedUser();
    const request = BigInt(150) * GIB;

    const results = await Promise.all([
      reserveStorageQuota(first.id, request),
      reserveStorageQuota(second.id, request),
    ]);

    expect(results.every((result) => 'reservationId' in result)).toBe(true);
    expect(await db.uploadReservation.count()).toBe(2);
  });
});

describe('releaseStorageReservation', () => {
  it('deletes the reservation and frees the headroom', async () => {
    const user = await createSubscribedUser();
    const result = await reserveStorageQuota(user.id, BigInt(10) * GIB);
    const reservationId = 'reservationId' in result ? result.reservationId : null;
    expect(reservationId).toBeTruthy();
    expect(await getUserTotalStorageBytes(user.id)).toBe(BigInt(10) * GIB);

    await releaseStorageReservation(reservationId);

    expect(await db.uploadReservation.count()).toBe(0);
    expect(await getUserTotalStorageBytes(user.id)).toBe(BigInt(0));
  });

  it('is a no-op for a null id', async () => {
    const user = await createSubscribedUser();
    await createUploadReservation({ billedUserId: user.id, sizeBytes: BigInt(1) });

    await releaseStorageReservation(null);

    expect(await db.uploadReservation.count()).toBe(1);
  });

  // The billedUserId argument scopes the delete, so a caller cannot release
  // another user's reservation by guessing its id.
  it('refuses to delete a reservation belonging to a different billed user', async () => {
    const owner = await createSubscribedUser();
    const attacker = await createSubscribedUser();
    const reservation = await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(4096),
    });

    await releaseStorageReservation(reservation.id, attacker.id);

    expect(await db.uploadReservation.count()).toBe(1);
  });
});

describe('GET /api/settings/storage', () => {
  it('returns 401 without a session', async () => {
    signedOut();

    const response = await callRoute(getStorageSettings, apiRequest('/api/settings/storage'));

    expect(response.status).toBe(401);
  });

  it('returns 403 for a user whose billing access has lapsed', async () => {
    const expired = await createExpiredUser();
    signedInAs(expired);

    const response = await callRoute(getStorageSettings, apiRequest('/api/settings/storage'));

    expect(response.status).toBe(403);
  });

  it('serialises the byte counts as strings so BigInt survives JSON', async () => {
    const user = await createSubscribedUser();
    await createUploadReservation({
      billedUserId: user.id,
      sizeBytes: BigInt(20) * GIB,
    });
    signedInAs(user);

    const payload = await readData<{
      usedBytes: string;
      limitBytes: string;
      percentage: number;
    }>(await callRoute(getStorageSettings, apiRequest('/api/settings/storage')));

    expect(payload.usedBytes).toBe((BigInt(20) * GIB).toString());
    expect(payload.limitBytes).toBe(PLAN_STORAGE_LIMIT_BYTES.toString());
    expect(typeof payload.usedBytes).toBe('string');
    expect(payload.percentage).toBe(10);
  });
});
