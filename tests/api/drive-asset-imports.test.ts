// Google Drive imports into a video's assets: images and audio copied within
// the request, and video attachments that go through the regular Drive import
// and are finalized into an asset instead of a video.
//
// Google and Bunny are fetch stubs routed by url, as in drive-imports.test.ts.
// Access checks, quota and transactions are the real ones.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { POST } from '@/app/api/videos/[videoId]/assets/drive-import/route';
import { GET as LIST } from '@/app/api/projects/[projectId]/drive-imports/route';
import { finalizeDriveImport } from '@/lib/drive-import';
import { UPLOAD_RESERVATION_PURPOSES } from '@/lib/storage-quota';
import * as r2 from '@/lib/r2';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createSubscribedUser,
  createUploadReservation,
  createUser,
  createVideo,
  seedProject,
  seedVersion,
} from '../factories';

const CLIENT_ID = 'drive-test-client.apps.googleusercontent.com';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWx';
const OTHER_FILE_ID = '2ZyXwVuTsRqPoNmLkJiHgFeDc';
const TOKEN = 'ya29.good-drive-token';
const BUNNY_GUID = 'bunny-guid-0002-asset';
const MIB = 1024 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

type FetchCall = { url: string; method: string };

let calls: FetchCall[];
let metadata: (fileId: string) => Response;
let download: (fileId: string) => Response;
let bunnyStatus: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pngBytes(size = 4096): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 8; i < size; i += 1) bytes[i] = i % 251;
  return bytes;
}

function mp3Bytes(size = 4096): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00], 0);
  return bytes;
}

function m4aBytes(size = 4096): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20], 0);
  return bytes;
}

/** Reads a streamed body to the end, as storage would, and returns what it held. */
async function drain(body: AsyncIterable<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of body) total += chunk.byteLength;
  return total;
}

function stored() {
  return vi.mocked(r2.putAttachmentObjectStream);
}

function file(name: string, mimeType: string, size: number) {
  return (fileId: string) => json({ id: fileId, name, mimeType, size: String(size) });
}

beforeEach(() => {
  calls = [];
  bunnyStatus = 0;
  metadata = file('frame.png', 'image/png', 4096);
  download = () => new Response(Buffer.from(pngBytes()));
  vi.stubEnv('GOOGLE_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('GOOGLE_PICKER_API_KEY', 'test-picker-key');
  vi.stubEnv('GOOGLE_CLOUD_PROJECT_NUMBER', '123456789012');
  vi.stubEnv('OPENFRAME_ENABLE_DRIVE_IMPORT', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'false');
  vi.stubEnv('BUNNY_STREAM_API_KEY', 'test-bunny-key');
  vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '424242');
  vi.stubEnv('BUNNY_CDN_URL', 'https://vz-test.b-cdn.net');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'test-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test-secret');
  vi.stubEnv('R2_BUCKET_NAME', 'test-bucket');
  vi.stubEnv('R2_ENDPOINT', 'http://minio-test:9000');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url
      );
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url: url.toString(), method });
      if (url.origin === 'https://oauth2.googleapis.com') {
        return json({ aud: CLIENT_ID, scope: `openid ${DRIVE_FILE_SCOPE}`, expires_in: '3500' });
      }
      if (url.origin === 'https://www.googleapis.com') {
        const fileId = url.pathname.slice('/drive/v3/files/'.length);
        return url.searchParams.get('alt') === 'media' ? download(fileId) : metadata(fileId);
      }
      if (url.origin === 'https://video.bunnycdn.com') {
        if (method === 'POST') return json({ success: true, id: BUNNY_GUID });
        if (method === 'GET') return json({ guid: BUNNY_GUID, status: bunnyStatus });
        return json({ success: true });
      }
      return json({}, 404);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(r2.putAttachmentObjectStream).mockClear();
  vi.mocked(r2.deleteR2Object).mockClear();
});

function importRequest(videoId: string, body: Record<string, unknown>) {
  return callRoute(POST, apiRequest(`/api/videos/${videoId}/assets/drive-import`, { body }), {
    videoId,
  });
}

function googleCalls(): FetchCall[] {
  return calls.filter((call) => call.url.includes('google'));
}

function downloads(): FetchCall[] {
  return calls.filter((call) => call.url.includes('alt=media'));
}

describe('POST /api/videos/[videoId]/assets/drive-import: who may attach', () => {
  it('refuses an anonymous caller without asking Google anything', async () => {
    const { video } = await seedVersion();
    signedOut();

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(await db.videoAsset.count()).toBe(0);
  });

  it('refuses a signed-in stranger before the token is checked', async () => {
    const { video } = await seedVersion();
    signedInAs(await createUser());

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(403);
    expect(googleCalls()).toHaveLength(0);
    expect(await db.videoAsset.count()).toBe(0);
  });

  it('lets a commentator attach, billing the workspace owner', async () => {
    const { owner, project, video } = await seedVersion();
    const commentator = await createUser();
    await addProjectMember({ projectId: project.id, userId: commentator.id, role: 'COMMENTATOR' });
    signedInAs(commentator);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    const asset = await db.videoAsset.findFirstOrThrow();
    expect(asset).toMatchObject({
      videoId: video.id,
      uploadedByUserId: commentator.id,
      billedUserId: owner.id,
    });
  });

  it('refuses a file that is not a video, image or audio, holding no quota', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    metadata = file('brief.pdf', 'application/pdf', 4096);
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const video = await createVideo({ projectId: project.id });
    signedInAs(owner);

    const response = await importRequest(video.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('Only video, image or audio files');
    expect(downloads()).toHaveLength(0);
    expect(await db.uploadReservation.count()).toBe(0);
    expect(await db.driveImport.count()).toBe(0);
  });

  it('refuses image and audio attachments when object storage is not configured', async () => {
    vi.stubEnv('R2_BUCKET_NAME', '');
    const { owner, video } = await seedVersion();
    signedInAs(owner);

    const response = await importRequest(video.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('object storage');
    expect(downloads()).toHaveLength(0);
  });

  it('refuses when this host has not configured Google Drive', async () => {
    vi.stubEnv('GOOGLE_PICKER_API_KEY', '');
    const { owner, video } = await seedVersion();
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('not available');
    expect(await db.videoAsset.count()).toBe(0);
  });
});

describe('POST /api/videos/[videoId]/assets/drive-import: images', () => {
  it('stores the image and creates the asset, handing the quota hold over to it', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const video = await createVideo({ projectId: project.id });
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    const data = await readData<{ assetIds: string[]; imports: unknown[] }>(response);
    const asset = await db.videoAsset.findFirstOrThrow();
    expect(data.assetIds).toEqual([asset.id]);
    expect(data.imports).toEqual([]);
    expect(asset).toMatchObject({
      provider: 'R2_IMAGE',
      displayName: 'frame.png',
      sizeBytes: BigInt(4096),
    });
    expect(asset.sourceUrl).toMatch(new RegExp(`^/api/upload/image/${UUID}\\.png$`));
    expect(asset.thumbnailUrl).toBe(asset.sourceUrl);
    expect(r2.putAttachmentObjectStream).toHaveBeenCalledWith(
      `images/${asset.sourceUrl.split('/').pop()}`,
      'image/png',
      expect.anything(),
      expect.any(Number),
      expect.any(AbortSignal)
    );
    expect(await db.uploadReservation.count()).toBe(0);
    expect(await db.driveImport.count()).toBe(0);
  });

  it('refuses a file whose bytes are not an image, whatever Drive calls it', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    download = () => new Response('<!doctype html><script>alert(1)</script>');
    metadata = file('frame.png', 'image/png', 41);
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const video = await createVideo({ projectId: project.id });
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('not a supported image');
    expect(r2.putAttachmentObjectStream).not.toHaveBeenCalled();
    expect(await db.videoAsset.count()).toBe(0);
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('refuses an image over 50 MB on the size Drive reports, without downloading it', async () => {
    metadata = file('huge.png', 'image/png', 50 * MIB + 1);
    const { owner, video } = await seedVersion();
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('larger than 50 MB');
    expect(downloads()).toHaveLength(0);
  });

  it('refuses a download that runs past the size Drive reported', async () => {
    metadata = file('frame.png', 'image/png', 1024);
    download = () => new Response(Buffer.from(pngBytes(4096)));
    const { owner, video } = await seedVersion();
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('reported size');
    // Streaming had begun, so the partial object has to go.
    expect(r2.deleteR2Object).toHaveBeenCalledWith(stored().mock.calls[0]![0]);
    expect(await db.videoAsset.count()).toBe(0);
  });

  it('refuses when the account has no storage left, and stores nothing', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    const owner = await createUser();
    const { project } = await seedProject({ ownerUser: owner });
    const video = await createVideo({ projectId: project.id });
    await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(3) * BigInt(1024) * BigInt(MIB) - BigInt(1024),
    });
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(507);
    expect(downloads()).toHaveLength(0);
    expect(await db.videoAsset.count()).toBe(0);
  });

  it('attaches the files it can and reports the ones it cannot', async () => {
    metadata = (fileId) =>
      fileId === OTHER_FILE_ID
        ? json({ id: fileId, name: 'brief.pdf', mimeType: 'application/pdf', size: '10' })
        : json({ id: fileId, name: 'frame.png', mimeType: 'image/png', size: '4096' });
    const { owner, video } = await seedVersion();
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID, OTHER_FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    const data = await readData<{
      assetIds: string[];
      errors: Array<{ driveFileId: string }>;
    }>(response);
    expect(data.assetIds).toHaveLength(1);
    expect(data.errors.map((error) => error.driveFileId)).toEqual([OTHER_FILE_ID]);
    expect(await db.videoAsset.count()).toBe(1);
  });
});

describe('POST /api/videos/[videoId]/assets/drive-import: audio', () => {
  it('stores an mp3 under voice/ and creates an audio asset', async () => {
    metadata = file('take 2.mp3', 'audio/mpeg', 4096);
    download = () => new Response(Buffer.from(mp3Bytes()));
    const { owner, video } = await seedVersion();
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    const asset = await db.videoAsset.findFirstOrThrow();
    expect(asset).toMatchObject({
      provider: 'R2_AUDIO',
      displayName: 'take 2.mp3',
      thumbnailUrl: null,
    });
    expect(asset.sourceUrl).toMatch(new RegExp(`^/api/upload/audio/${UUID}\\.mp3$`));
    expect(r2.putAttachmentObjectStream).toHaveBeenCalledWith(
      `voice/${asset.sourceUrl.split('/').pop()}`,
      'audio/mpeg',
      expect.anything(),
      expect.any(Number),
      expect.any(AbortSignal)
    );
  });

  it("accepts Drive's audio/x-m4a as an m4a file", async () => {
    metadata = file('memo.m4a', 'audio/x-m4a', 4096);
    download = () => new Response(Buffer.from(m4aBytes()));
    const { owner, video } = await seedVersion();
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    const asset = await db.videoAsset.findFirstOrThrow();
    expect(asset.sourceUrl).toMatch(/\.m4a$/);
    expect(r2.putAttachmentObjectStream).toHaveBeenCalledWith(
      expect.stringMatching(/^voice\/.+\.m4a$/),
      'audio/mp4',
      expect.anything(),
      expect.any(Number),
      expect.any(AbortSignal)
    );
  });

  it('refuses audio whose bytes do not match its format', async () => {
    metadata = file('take.mp3', 'audio/mpeg', 4096);
    download = () => new Response(Buffer.from(pngBytes()));
    const { owner, video } = await seedVersion();
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(400);
    expect(r2.putAttachmentObjectStream).not.toHaveBeenCalled();
    expect(await db.videoAsset.count()).toBe(0);
  });
});

describe('POST /api/videos/[videoId]/assets/drive-import: video attachments', () => {
  it('starts an import aimed at the video, and a poll turns it into a Bunny asset', async () => {
    metadata = file('Alt take.mp4', 'video/mp4', MIB);
    const { owner, project, video } = await seedVersion();
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    const row = await db.driveImport.findFirstOrThrow();
    expect(row).toMatchObject({
      assetVideoId: video.id,
      targetVideoId: null,
      folderId: null,
      projectId: project.id,
      bunnyVideoId: BUNNY_GUID,
    });
    expect(await db.videoAsset.count()).toBe(0);

    bunnyStatus = 3;
    const poll = await callRoute(
      LIST,
      apiRequest(`/api/projects/${project.id}/drive-imports`, { method: 'GET' }),
      { projectId: project.id }
    );
    expect((await readData<{ landed: string[] }>(poll)).landed).toEqual([row.id]);

    const asset = await db.videoAsset.findFirstOrThrow();
    expect(asset).toMatchObject({
      videoId: video.id,
      provider: 'BUNNY',
      providerVideoId: BUNNY_GUID,
      sourceUrl: `https://iframe.mediadelivery.net/embed/424242/${BUNNY_GUID}`,
      thumbnailUrl: `https://vz-test.b-cdn.net/${BUNNY_GUID}/thumbnail.jpg`,
      displayName: 'Alt take.mp4',
      sizeBytes: BigInt(MIB),
      uploadedByUserId: owner.id,
    });
    // An attachment, not a new version or a new video.
    expect(await db.videoVersion.count({ where: { videoParentId: video.id } })).toBe(1);
    expect(await db.video.count()).toBe(1);
    expect(await db.driveImport.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'DONE',
      createdAssetId: asset.id,
      createdVersionId: null,
    });
  });

  it('finalizes a self-hosted copy into an R2 video asset', async () => {
    const { owner, project, video } = await seedVersion();
    const reservation = await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(MIB),
      purpose: UPLOAD_RESERVATION_PURPOSES.DRIVE_IMPORT,
    });
    const row = await db.driveImport.create({
      data: {
        userId: owner.id,
        projectId: project.id,
        assetVideoId: video.id,
        driveFileId: FILE_ID,
        fileName: 'Alt take.mp4',
        title: 'Alt take',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(MIB),
        billedUserId: owner.id,
        reservationId: reservation.id,
        backend: 'S3',
        objectKey: 'videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4',
        transferredAt: new Date(),
      },
    });

    await finalizeDriveImport(row.id);

    const asset = await db.videoAsset.findFirstOrThrow();
    expect(asset).toMatchObject({
      videoId: video.id,
      provider: 'R2_VIDEO',
      providerVideoId: null,
      sourceUrl: '/api/upload/video/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4',
      thumbnailUrl: null,
    });
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('fails the import and attaches nothing when the uploader lost access meanwhile', async () => {
    const { owner, project, video } = await seedVersion();
    const member = await createUser();
    const membership = await addProjectMember({
      projectId: project.id,
      userId: member.id,
      role: 'COMMENTATOR',
    });
    const reservation = await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(MIB),
      purpose: UPLOAD_RESERVATION_PURPOSES.DRIVE_IMPORT,
    });
    const row = await db.driveImport.create({
      data: {
        userId: member.id,
        projectId: project.id,
        assetVideoId: video.id,
        driveFileId: FILE_ID,
        fileName: 'Alt take.mp4',
        title: 'Alt take',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(MIB),
        billedUserId: owner.id,
        reservationId: reservation.id,
        backend: 'BUNNY',
        bunnyVideoId: BUNNY_GUID,
      },
    });
    await db.projectMember.delete({ where: { id: membership.id } });

    await finalizeDriveImport(row.id);

    expect(await db.videoAsset.count()).toBe(0);
    expect(await db.driveImport.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'FAILED',
    });
    expect(await db.uploadReservation.count()).toBe(0);
  });
});

describe('POST /api/videos/[videoId]/assets/drive-import: failures after the copy', () => {
  it('deletes the stored image and frees the hold when access is lost mid-copy', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const video = await createVideo({ projectId: project.id });
    const commentator = await createUser();
    const membership = await addProjectMember({
      projectId: project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    // Removed while the image is being stored, after the route's own check.
    stored().mockImplementationOnce(async (_key, _type, body) => {
      await drain(body);
      await db.projectMember.deleteMany({ where: { id: membership.id } });
    });
    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('Access changed');
    expect(await db.videoAsset.count()).toBe(0);
    const storedKey = stored().mock.calls[0]![0];
    expect(r2.deleteR2Object).toHaveBeenCalledWith(storedKey);
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('refuses to attach once the quota hold has expired, and deletes the object', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const video = await createVideo({ projectId: project.id });
    stored().mockImplementationOnce(async (_key, _type, body) => {
      await drain(body);
      await db.uploadReservation.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    });
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('took too long');
    expect(await db.videoAsset.count()).toBe(0);
    expect(r2.deleteR2Object).toHaveBeenCalledWith(stored().mock.calls[0]![0]);
  });

  it('reports a storage failure mid-copy as a failed import, not a bad Drive file', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    const size = 4 * MIB;
    metadata = file('still.png', 'image/png', size);
    download = () => new Response(Buffer.from(pngBytes(size)));
    stored().mockImplementationOnce(async (_key, _type, body) => {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        void chunk;
        throw new Error('storage connection reset');
      }
    });
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const video = await createVideo({ projectId: project.id });
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(400);
    const message = await readError(response);
    expect(message).toContain('could not be imported');
    expect(message).not.toContain('reported size');
    expect(await db.videoAsset.count()).toBe(0);
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('frees the hold when Drive refuses the download', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    download = () => json({ error: 'rateLimitExceeded' }, 429);
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const video = await createVideo({ projectId: project.id });
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('(429)');
    expect(r2.putAttachmentObjectStream).not.toHaveBeenCalled();
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('frees the audio hold when the bytes do not match the format', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    metadata = file('take.mp3', 'audio/mpeg', 4096);
    download = () => new Response(Buffer.from(pngBytes()));
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const video = await createVideo({ projectId: project.id });
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('does not match its audio format');
    expect(await db.uploadReservation.count()).toBe(0);
  });
});

describe('POST /api/videos/[videoId]/assets/drive-import: what is stored', () => {
  it('types an image by its bytes, not by what Drive says it is', async () => {
    metadata = file('frame.png', 'image/png', 4);
    download = () => new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const { owner, video } = await seedVersion();
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    const asset = await db.videoAsset.findFirstOrThrow();
    expect(asset.sourceUrl).toMatch(/\.jpg$/);
    expect(r2.putAttachmentObjectStream).toHaveBeenCalledWith(
      expect.stringMatching(/^images\/.+\.jpg$/),
      'image/jpeg',
      expect.anything(),
      expect.any(Number),
      expect.any(AbortSignal)
    );
  });

  it('refuses a download shorter than Drive reported, and deletes what was stored', async () => {
    metadata = file('frame.png', 'image/png', 8192);
    download = () => new Response(Buffer.from(pngBytes(4096)));
    const { owner, video } = await seedVersion();
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('reported size');
    expect(await db.videoAsset.count()).toBe(0);
    expect(r2.deleteR2Object).toHaveBeenCalledWith(stored().mock.calls[0]![0]);
  });

  it('streams a file bigger than the browser upload limit instead of buffering it', async () => {
    const size = 12 * MIB;
    metadata = file('still.png', 'image/png', size);
    download = () => new Response(Buffer.from(pngBytes(size)));
    let streamedBytes = 0;
    stored().mockImplementationOnce(async (_key, _type, body, length) => {
      expect(length).toBe(size);
      streamedBytes = await drain(body);
    });
    const { owner, video } = await seedVersion();
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    expect(streamedBytes).toBe(size);
    expect((await db.videoAsset.findFirstOrThrow()).sizeBytes).toBe(BigInt(size));
  });

  it('imports a file picked twice only once', async () => {
    const { owner, video } = await seedVersion();
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID, FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    expect(await db.videoAsset.count()).toBe(1);
    expect(downloads()).toHaveLength(1);
  });

  it('refuses a token Google issued to another application', async () => {
    const { owner, video } = await seedVersion();
    signedInAs(owner);
    const realFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://oauth2.googleapis.com')) {
        return json({ aud: 'other.apps.googleusercontent.com', scope: DRIVE_FILE_SCOPE });
      }
      return realFetch(input, init);
    });

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(403);
    expect(downloads()).toHaveLength(0);
    expect(await db.videoAsset.count()).toBe(0);
  });

  // The browser asset upload lets anyone who can open a public project's video
  // attach to it, billed to the owner. The Drive import follows the same rule.
  it('lets a signed-in visitor of a public project attach, as the browser upload does', async () => {
    const { owner, video } = await seedVersion({ visibility: 'PUBLIC' });
    const visitor = await createUser();
    signedInAs(visitor);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    expect(await db.videoAsset.findFirstOrThrow()).toMatchObject({
      uploadedByUserId: visitor.id,
      billedUserId: owner.id,
    });
  });
});

describe('POST /api/videos/[videoId]/assets/drive-import: video attachments, refusals', () => {
  it('attaches a mixed pick, each file as the kind Drive says it is', async () => {
    const IMAGE_ID = '3ImAgEiMaGeImAgEiMaGeImAg';
    const AUDIO_ID = '4AuDiOaUdIoAuDiOaUdIoAuDi';
    metadata = (fileId) =>
      fileId === IMAGE_ID
        ? json({ id: fileId, name: 'frame.png', mimeType: 'image/png', size: '4096' })
        : fileId === AUDIO_ID
          ? json({ id: fileId, name: 'vo.mp3', mimeType: 'audio/mpeg', size: '4096' })
          : json({ id: fileId, name: 'b-roll.mp4', mimeType: 'video/mp4', size: String(MIB) });
    download = (fileId) => new Response(Buffer.from(fileId === IMAGE_ID ? pngBytes() : mp3Bytes()));
    const { owner, video } = await seedVersion();
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID, IMAGE_ID, AUDIO_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    const data = await readData<{ assetIds: string[]; imports: unknown[] }>(response);
    expect((data as { errors?: unknown }).errors).toEqual([]);
    expect(data.assetIds).toHaveLength(2);
    expect(data.imports).toHaveLength(1);
    const assets = await db.videoAsset.findMany({ orderBy: { kind: 'asc' } });
    expect(assets.map((asset) => [asset.kind, asset.provider, asset.displayName])).toEqual([
      ['IMAGE', 'R2_IMAGE', 'frame.png'],
      ['AUDIO', 'R2_AUDIO', 'vo.mp3'],
    ]);
    expect(await db.driveImport.findFirstOrThrow()).toMatchObject({
      assetVideoId: video.id,
      fileName: 'b-roll.mp4',
    });
  });

  it('refuses a video attachment the account has no storage for', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    metadata = file('Alt take.mp4', 'video/mp4', MIB);
    const owner = await createUser();
    const { project } = await seedProject({ ownerUser: owner });
    const video = await createVideo({ projectId: project.id });
    await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(3) * BigInt(1024) * BigInt(MIB) - BigInt(MIB / 2),
    });
    signedInAs(owner);

    const response = await importRequest(video.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(507);
    expect(await db.driveImport.count()).toBe(0);
    expect(calls.filter((call) => call.url.includes('bunnycdn'))).toHaveLength(0);
  });

  it("finalizes a commentator's video attachment, since any member may attach", async () => {
    const { project, video } = await seedVersion();
    const commentator = await createUser();
    await addProjectMember({ projectId: project.id, userId: commentator.id, role: 'COMMENTATOR' });
    const row = await db.driveImport.create({
      data: {
        userId: commentator.id,
        projectId: project.id,
        assetVideoId: video.id,
        driveFileId: FILE_ID,
        fileName: 'Alt take.mp4',
        title: 'Alt take',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(MIB),
        billedUserId: project.ownerId,
        backend: 'BUNNY',
        bunnyVideoId: BUNNY_GUID,
      },
    });

    await finalizeDriveImport(row.id);

    expect(await db.driveImport.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'DONE',
    });
    expect(await db.videoAsset.findFirstOrThrow()).toMatchObject({
      uploadedByUserId: commentator.id,
      provider: 'BUNNY',
    });
  });
});
