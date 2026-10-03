// The Bunny init routes used to ask the quota about zero bytes, which meant two
// things at once: an upload that could never fit was only discovered after it had
// been sent, and nothing an upload was about to consume was visible to the next
// request. Bunny reports its own storage on a delay and the figure is cached for
// two minutes on top, so every init inside that window read the same stale total
// and every one of them passed.
//
// These tests pin the two halves of the fix: the declared size is checked before
// a byte moves, and it is held as a reservation the next init has to see.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  DELETE as cancelProjectBunnyUpload,
  POST as initProjectBunnyUpload,
} from '@/app/api/projects/[projectId]/videos/bunny-init/route';
import { POST as createAsset } from '@/app/api/videos/[videoId]/assets/route';
import { UPLOAD_RESERVATION_PURPOSES } from '@/lib/storage-quota';
import { PLAN_STORAGE_LIMIT_BYTES } from '@/lib/storage-quota';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs } from '../helpers/session';
import {
  createSubscribedUser,
  createUploadReservation,
  createVideo,
  seedProject,
} from '../factories';

const GIB = BigInt(1024) * BigInt(1024) * BigInt(1024);

/**
 * Bunny answers every call the same way, with a fresh video id each time so two
 * inits in one test are distinguishable. The cancel path talks to Bunny too, so
 * the stub has to cover it rather than just the creation call.
 */
function stubBunnyApi(): void {
  let created = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      created += 1;
      return new Response(JSON.stringify({ guid: `bunnyvideo-${created}-abcdefgh` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    })
  );
}

beforeEach(() => {
  vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'false');
  vi.stubEnv('BUNNY_STREAM_API_KEY', 'test-bunny-key');
  vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '999999');
  vi.stubEnv('BUNNY_UPLOAD_TOKEN_SECRET', 'test-bunny-upload-token-secret');
  stubBunnyApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function initRequest(projectId: string, body: Record<string, unknown>) {
  return apiRequest(`/api/projects/${projectId}/videos/bunny-init`, { body });
}

async function initUpload(projectId: string, sizeBytes: bigint) {
  return callRoute(
    initProjectBunnyUpload,
    initRequest(projectId, { title: 'A clip', sizeBytes: sizeBytes.toString() }),
    { projectId }
  );
}

describe('POST /api/projects/[projectId]/videos/bunny-init', () => {
  it('refuses an init that does not say how big the upload is', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      initProjectBunnyUpload,
      initRequest(scenario.project.id, { title: 'A clip' }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('sizeBytes');
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('refuses a size beyond the host per-file ceiling', async () => {
    vi.stubEnv('OPENFRAME_MAX_VIDEO_UPLOAD_BYTES', '1024');
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await initUpload(scenario.project.id, BigInt(2048));

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('maximum allowed upload size');
  });

  // One file may take 80% of the account's ceiling, not all of it: what the
  // provider transcodes the upload into is billed to the same account, so a file
  // that filled the quota would be over it by the time it finished processing.
  // 2.5 GiB fits inside a trial's 3 GiB and is still refused.
  it('refuses a size beyond the share of the quota one file may take', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await initUpload(scenario.project.id, (BigInt(5) * GIB) / BigInt(2));

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('2.4 GB');
    expect(await db.uploadReservation.count()).toBe(0);
  });

  // And the same rule read against the paid ceiling, where 80% of 200 GiB is a
  // number no fixed per-file limit would have allowed.
  it('lets a paying account send a file far past what a trial could', async () => {
    const scenario = await seedProject({ ownerUser: await createSubscribedUser() });
    signedInAs(scenario.owner);

    const overCeiling = await initUpload(scenario.project.id, BigInt(161) * GIB);
    const underCeiling = await initUpload(scenario.project.id, BigInt(150) * GIB);

    expect(overCeiling.status).toBe(400);
    expect(await readError(overCeiling)).toContain('160 GB');
    expect(underCeiling.status).toBe(200);
  });

  // The trial ceiling is 3 GiB, so this is refused on the way in rather than
  // after the bytes have been pushed to Bunny. The declared size is inside the
  // per-file ceiling, so it is the quota refusing it and not the size check.
  it('refuses an upload the remaining quota cannot hold', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);
    await createUploadReservation({
      billedUserId: scenario.owner.id,
      sizeBytes: BigInt(2) * GIB,
    });

    const response = await initUpload(scenario.project.id, BigInt(2) * GIB);

    expect(response.status).toBe(507);
    expect(await db.uploadReservation.count()).toBe(1);
  });

  it('holds the declared size as a reservation for the workspace owner', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await initUpload(scenario.project.id, BigInt(2) * GIB);

    expect(response.status).toBe(200);
    const reservations = await db.uploadReservation.findMany();
    expect(reservations).toHaveLength(1);
    expect(reservations[0].billedUserId).toBe(scenario.owner.id);
    expect(reservations[0].sizeBytes).toBe(BigInt(2) * GIB);
  });

  // The regression this whole change exists for. Both of these used to be
  // granted, because neither could see what the other was about to upload.
  it('refuses a second upload that no longer fits beside the first', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const first = await initUpload(scenario.project.id, BigInt(2) * GIB);
    const second = await initUpload(scenario.project.id, BigInt(2) * GIB);

    expect(first.status).toBe(200);
    expect(second.status).toBe(507);
    expect(await db.uploadReservation.count()).toBe(1);
  });
});

describe('DELETE /api/projects/[projectId]/videos/bunny-init', () => {
  it('gives the quota back when a pending upload is cancelled', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const init = await initUpload(scenario.project.id, BigInt(2) * GIB);
    const { videoId, uploadToken } = await readData(init);

    const response = await callRoute(
      cancelProjectBunnyUpload,
      initRequest(scenario.project.id, { videoId, uploadToken }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);
    expect(await db.uploadReservation.count()).toBe(0);
  });

  // Why the reservation id travels inside the signed token instead of being
  // handed to the client as a field of its own: a caller who could name a
  // reservation could start two uploads, cancel the cheap one while quoting the
  // expensive one's reservation, and keep uploading against quota it no longer
  // holds.
  it('will not let one upload cancel release another upload reservation', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const first = await initUpload(scenario.project.id, BigInt(1) * GIB);
    const second = await initUpload(scenario.project.id, BigInt(1) * GIB);
    const firstData = await readData(first);
    const secondData = await readData(second);

    const response = await callRoute(
      cancelProjectBunnyUpload,
      initRequest(scenario.project.id, {
        videoId: secondData.videoId,
        uploadToken: firstData.uploadToken,
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.uploadReservation.count()).toBe(2);
  });
});

// The reservation id is not a secret and was never going to be one. The upload
// token is `base64url(payload).signature`, so the client can read every claim in
// it, and the two R2 upload routes hand their reservation ids to the client
// outright. What keeps a hold from being dropped by whoever can name it is that
// a reservation records what it was opened for, and every finalize route matches
// on that as well as on the id.
describe('a Bunny hold cannot be consumed by another flow', () => {
  /** The claims the client can read out of an upload token without our help. */
  function claimsOf(uploadToken: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(uploadToken.split('.')[0], 'base64url').toString('utf8'));
  }

  it('puts the reservation id somewhere the client can read it', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const init = await initUpload(scenario.project.id, BigInt(1) * GIB);
    const { uploadToken } = await readData(init);

    const reservation = (await db.uploadReservation.findMany())[0];
    expect(claimsOf(uploadToken).rid).toBe(reservation.id);
    expect(reservation.purpose).toBe(UPLOAD_RESERVATION_PURPOSES.BUNNY);
  });

  // The attack the purpose column closes. Creating a YouTube asset costs nothing
  // and consumes no storage, so quoting a Bunny reservation on one was a way to
  // hand back the quota of an upload that was still running and then start
  // another. Repeat and a trial worth three gigabytes uploads as much as it
  // likes for as long as Bunny takes to report.
  it('ignores a Bunny reservation id quoted on a YouTube asset create', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    signedInAs(scenario.owner);

    const init = await initUpload(scenario.project.id, BigInt(2) * GIB);
    const { uploadToken } = await readData(init);
    const reservationId = claimsOf(uploadToken).rid as string;

    const response = await callRoute(
      createAsset,
      apiRequest(`/api/videos/${video.id}/assets`, {
        body: {
          provider: 'YOUTUBE',
          sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          reservationId,
        },
      }),
      { videoId: video.id }
    );

    expect(response.status).toBe(201);
    const reservations = await db.uploadReservation.findMany();
    expect(reservations).toHaveLength(1);
    expect(reservations[0].id).toBe(reservationId);
  });

  // And with the hold still standing, the next init has to see it.
  it('still refuses the next upload after the quoted release attempt', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    signedInAs(scenario.owner);

    const init = await initUpload(scenario.project.id, BigInt(2) * GIB);
    const { uploadToken } = await readData(init);

    await callRoute(
      createAsset,
      apiRequest(`/api/videos/${video.id}/assets`, {
        body: {
          provider: 'YOUTUBE',
          sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          reservationId: claimsOf(uploadToken).rid,
        },
      }),
      { videoId: video.id }
    );

    const second = await initUpload(scenario.project.id, BigInt(2) * GIB);
    expect(second.status).toBe(507);
  });
});

// What a refusal says, and to whom.
//
// A trial account is out of room because it has not subscribed, so "delete some
// files" is advice that does not apply and the upgrade is the only way through.
// The two cases carry different codes because the client offers a link on one of
// them and must not on the other.
describe('what the storage refusal says', () => {
  it('names the trial ceiling and its own code for an unpaid account', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);
    await createUploadReservation({
      billedUserId: scenario.owner.id,
      sizeBytes: BigInt(2) * GIB,
    });

    const response = await initUpload(scenario.project.id, BigInt(2) * GIB);

    expect(response.status).toBe(507);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe('TRIAL_STORAGE_LIMIT_EXCEEDED');
    expect(body.error).toContain('3 GB');
    expect(body.error).toContain('Upgrade');
  });

  it('tells a paying account to free up space instead', async () => {
    const scenario = await seedProject({ ownerUser: await createSubscribedUser() });
    signedInAs(scenario.owner);

    // Full at the paid ceiling rather than the trial one.
    await createUploadReservation({
      billedUserId: scenario.owner.id,
      sizeBytes: PLAN_STORAGE_LIMIT_BYTES - BigInt(1024),
    });

    const response = await initUpload(scenario.project.id, BigInt(1) * GIB);

    expect(response.status).toBe(507);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe('STORAGE_LIMIT_EXCEEDED');
    expect(body.error).toContain('Delete files you no longer need');
  });
});

// Asked directly: five one-gigabyte uploads started at once against a three
// gigabyte trial. Whether they go up in one piece or in parts makes no
// difference, because r2-init takes the reservation before it decides on
// multipart, and bunny-init holds one for the size the client declared.
describe('several uploads started at once', () => {
  it('grants only the ones that fit and refuses the rest', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => initUpload(scenario.project.id, BigInt(1) * GIB))
    );

    const granted = results.filter((response) => response.status === 200);
    const refused = results.filter((response) => response.status === 507);

    // Two fit: the check is >=, so the third would land exactly on 3 GiB.
    expect(granted).toHaveLength(2);
    expect(refused).toHaveLength(3);
    expect(await db.uploadReservation.count()).toBe(2);
  });
});
