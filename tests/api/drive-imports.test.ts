// Google Drive imports: the route that starts them, the reconcile that finishes
// them, and the S3 copier that self-hosted instances use.
//
// Every outside party is a fetch stub routed by url (Google's tokeninfo, the
// Drive API, Bunny Stream), so each test can say exactly what Google and Bunny
// answer and then assert what landed in the database. The access checks, the
// quota and the transactions are the real ones.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveImport, Prisma, User } from '@prisma/client';
import { db } from '@/lib/db';
import { GET, POST } from '@/app/api/projects/[projectId]/drive-imports/route';
import { copyDriveFileToS3, finalizeDriveImport } from '@/lib/drive-import';
import { UPLOAD_RESERVATION_PURPOSES } from '@/lib/storage-quota';
import * as r2 from '@/lib/r2';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createSubscribedUser,
  createUploadReservation,
  createUser,
  createVersion,
  createVideo,
  seedProject,
} from '../factories';

const CLIENT_ID = 'drive-test-client.apps.googleusercontent.com';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWx';
const TOKEN = 'ya29.good-drive-token';
const BUNNY_GUID = 'bunny-guid-0001-drive';
const MIB = 1024 * 1024;

type FetchCall = { url: string; method: string; body: string | null };

type Stubs = {
  tokeninfo: () => Response;
  driveMetadata: (fileId: string) => Response;
  bunnyFetch: () => Response;
  bunnySearch: () => Response;
  bunnyVideo: () => Response;
  driveDownload: () => Response;
};

let calls: FetchCall[];
let stubs: Stubs;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function defaultStubs(): Stubs {
  return {
    tokeninfo: () =>
      json({
        aud: CLIENT_ID,
        azp: CLIENT_ID,
        scope: `openid ${DRIVE_FILE_SCOPE}`,
        expires_in: '3500',
      }),
    driveMetadata: (fileId) =>
      json({ id: fileId, name: 'Cut 3.mp4', mimeType: 'video/mp4', size: String(MIB) }),
    bunnyFetch: () => json({ success: true, message: 'OK', statusCode: 200, id: BUNNY_GUID }),
    bunnySearch: () => json({ items: [] }),
    bunnyVideo: () => json({ guid: BUNNY_GUID, status: 0 }),
    driveDownload: () => streamOf(videoBytes(MIB)),
  };
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url
      );
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({
        url: url.toString(),
        method,
        body: typeof init?.body === 'string' ? init.body : null,
      });

      if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/tokeninfo') {
        return stubs.tokeninfo();
      }
      if (
        url.origin === 'https://www.googleapis.com' &&
        url.pathname.startsWith('/drive/v3/files/')
      ) {
        const fileId = url.pathname.slice('/drive/v3/files/'.length);
        return url.searchParams.get('alt') === 'media'
          ? stubs.driveDownload()
          : stubs.driveMetadata(fileId);
      }
      if (url.origin === 'https://video.bunnycdn.com') {
        if (method === 'POST' && url.pathname.endsWith('/videos/fetch')) return stubs.bunnyFetch();
        if (method === 'GET' && url.pathname.endsWith('/videos')) return stubs.bunnySearch();
        if (method === 'GET') return stubs.bunnyVideo();
        if (method === 'DELETE') return json({ success: true });
      }
      return json({}, 404);
    })
  );
}

/** Bytes that open like an MP4 (`ftyp` at offset 4), then filler. */
function videoBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
  for (let i = 12; i < size; i += 1) bytes[i] = i % 251;
  return bytes;
}

/** A download that arrives in reads of an awkward size, as a network would deliver it. */
function streamOf(bytes: Uint8Array, readSize = 777_777): Response {
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + readSize));
      offset += readSize;
    },
  });
  return new Response(body);
}

function bunnyFetchCalls(): FetchCall[] {
  return calls.filter((call) => call.method === 'POST' && call.url.endsWith('/videos/fetch'));
}

function googleCalls(): FetchCall[] {
  return calls.filter((call) => call.url.includes('google'));
}

beforeEach(() => {
  calls = [];
  stubs = defaultStubs();
  vi.stubEnv('GOOGLE_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('GOOGLE_PICKER_API_KEY', 'test-picker-key');
  vi.stubEnv('GOOGLE_CLOUD_PROJECT_NUMBER', '123456789012');
  vi.stubEnv('OPENFRAME_ENABLE_DRIVE_IMPORT', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'false');
  vi.stubEnv('BUNNY_STREAM_API_KEY', 'test-bunny-key');
  vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '424242');
  vi.stubEnv('BUNNY_CDN_URL', 'https://vz-test.b-cdn.net');
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(r2.uploadVideoPart).mockClear();
  vi.mocked(r2.abortMultipartVideoUpload).mockClear();
  vi.mocked(r2.completeMultipartVideoUpload).mockClear();
  vi.mocked(r2.deleteVideoObject).mockClear();
  vi.mocked(r2.deleteR2Object).mockClear();
  vi.mocked(r2.putImageObject).mockClear();
});

function startRequest(projectId: string, body: Record<string, unknown>) {
  return callRoute(POST, apiRequest(`/api/projects/${projectId}/drive-imports`, { body }), {
    projectId,
  });
}

function listRequest(projectId: string) {
  return callRoute(GET, apiRequest(`/api/projects/${projectId}/drive-imports`, { method: 'GET' }), {
    projectId,
  });
}

async function createImportRow(
  owner: User,
  projectId: string,
  data: Partial<Prisma.DriveImportUncheckedCreateInput> = {}
): Promise<DriveImport> {
  return db.driveImport.create({
    data: {
      userId: owner.id,
      projectId,
      driveFileId: FILE_ID,
      fileName: 'Cut 3.mp4',
      title: 'Cut 3',
      mimeType: 'video/mp4',
      sizeBytes: BigInt(MIB),
      billedUserId: owner.id,
      backend: 'BUNNY',
      bunnyVideoId: BUNNY_GUID,
      ...data,
    },
  });
}

describe('POST /api/projects/[projectId]/drive-imports: who may start one', () => {
  it('refuses an anonymous caller without asking Google anything', async () => {
    const { project } = await seedProject();
    signedOut();

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(401);
    expect(await db.driveImport.count()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses a signed-in stranger before the token is even checked', async () => {
    const { project } = await seedProject();
    signedInAs(await createUser());

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(403);
    expect(await db.driveImport.count()).toBe(0);
    expect(googleCalls()).toHaveLength(0);
  });

  it('refuses a commentator, who can watch but not add videos', async () => {
    const { project } = await seedProject();
    const commentator = await createUser();
    await addProjectMember({ projectId: project.id, userId: commentator.id, role: 'COMMENTATOR' });
    signedInAs(commentator);

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(403);
    expect(await db.driveImport.count()).toBe(0);
    expect(bunnyFetchCalls()).toHaveLength(0);
  });

  it('refuses when this host has not configured Google Drive', async () => {
    vi.stubEnv('GOOGLE_PICKER_API_KEY', '');
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('not available');
    expect(await db.driveImport.count()).toBe(0);
  });
});

describe('POST /api/projects/[projectId]/drive-imports: the Google token', () => {
  it('refuses a token Google issued to some other application', async () => {
    stubs.tokeninfo = () =>
      json({
        aud: 'someone-else.apps.googleusercontent.com',
        scope: DRIVE_FILE_SCOPE,
        expires_in: '3500',
      });
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(403);
    expect(await db.driveImport.count()).toBe(0);
    expect(bunnyFetchCalls()).toHaveLength(0);
  });

  it('refuses a token of ours that lacks the drive.file scope', async () => {
    stubs.tokeninfo = () => json({ aud: CLIENT_ID, scope: 'openid email', expires_in: '3500' });
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(403);
    expect(await db.driveImport.count()).toBe(0);
  });

  it('refuses a token about to expire, since Bunny may queue the fetch', async () => {
    stubs.tokeninfo = () => json({ aud: CLIENT_ID, scope: DRIVE_FILE_SCOPE, expires_in: '120' });
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(403);
    expect(await db.driveImport.count()).toBe(0);
  });
});

describe('POST /api/projects/[projectId]/drive-imports: what is fetched', () => {
  it('never lets a caller steer the server at a url of its choosing', async () => {
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await startRequest(project.id, {
      fileIds: ['../../../../evil.example/x?'],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(await db.driveImport.count()).toBe(0);
  });

  it('refuses a Drive file that is not a video, and holds no quota for it', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    stubs.driveMetadata = (fileId) =>
      json({ id: fileId, name: 'notes.pdf', mimeType: 'application/pdf', size: '2048' });
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    signedInAs(owner);

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('Only video or image files');
    expect(await db.driveImport.count()).toBe(0);
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('refuses a file larger than one upload may be, on the size Drive reports', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    vi.stubEnv('OPENFRAME_MAX_VIDEO_UPLOAD_BYTES', String(512 * 1024));
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    signedInAs(owner);

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('maximum allowed upload size');
    expect(await db.driveImport.count()).toBe(0);
    expect(await db.uploadReservation.count()).toBe(0);
    expect(bunnyFetchCalls()).toHaveLength(0);
  });
});

describe('POST /api/projects/[projectId]/drive-imports: starting a Bunny import', () => {
  it('hands Bunny the Drive download url and the token, and writes no video yet', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    signedInAs(owner);

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(201);
    const data = await readData<{ imports: Array<{ id: string; status: string }> }>(response);
    expect(data.imports).toHaveLength(1);

    const row = await db.driveImport.findUniqueOrThrow({ where: { id: data.imports[0]!.id } });
    expect(row).toMatchObject({
      userId: owner.id,
      projectId: project.id,
      backend: 'BUNNY',
      status: 'TRANSFERRING',
      bunnyVideoId: BUNNY_GUID,
      title: 'Cut 3',
      driveFileId: FILE_ID,
    });
    expect(row.sizeBytes).toBe(BigInt(MIB));

    const reservation = await db.uploadReservation.findUniqueOrThrow({
      where: { id: row.reservationId! },
    });
    expect(reservation.purpose).toBe(UPLOAD_RESERVATION_PURPOSES.DRIVE_IMPORT);
    expect(reservation.sizeBytes).toBe(BigInt(MIB));

    const [fetchCall] = bunnyFetchCalls();
    const sent = JSON.parse(fetchCall!.body!) as { url: string; headers: Record<string, string> };
    expect(sent.url).toBe(
      `https://www.googleapis.com/drive/v3/files/${FILE_ID}?alt=media&supportsAllDrives=true`
    );
    expect(sent.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });

    expect(await db.video.count()).toBe(0);
  });

  it('finds the new Bunny video by its title marker when Bunny answers without an id', async () => {
    stubs.bunnyFetch = () => json({ success: true, message: 'OK', statusCode: 200 });
    stubs.bunnySearch = () => {
      const marker = JSON.parse(bunnyFetchCalls()[0]!.body!).title.match(/\[(.+)\]/)[1];
      return json({
        items: [
          { guid: 'unrelated-bunny-video', title: 'Someone else' },
          { guid: 'found-by-marker-guid', title: `Cut 3 [${marker}]` },
        ],
      });
    };
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(201);
    const row = await db.driveImport.findFirstOrThrow();
    expect(row.bunnyVideoId).toBe('found-by-marker-guid');
  });

  it('gives the quota back when Bunny will not take the fetch', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    stubs.bunnyFetch = () => json({ success: false }, 500);
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    signedInAs(owner);

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(400);
    const row = await db.driveImport.findFirstOrThrow();
    expect(row.status).toBe('FAILED');
    expect(await db.uploadReservation.count()).toBe(0);
    expect(await db.video.count()).toBe(0);
  });

  it('takes exactly one file for a new version', async () => {
    const { owner, project } = await seedProject();
    const video = await createVideo({ projectId: project.id });
    signedInAs(owner);

    const response = await startRequest(project.id, {
      fileIds: [FILE_ID, '2ZyXwVuTsRqPoNmLkJiHgFeDc'],
      accessToken: TOKEN,
      targetVideoId: video.id,
    });

    expect(response.status).toBe(400);
    expect(await db.driveImport.count()).toBe(0);
  });
});

describe('POST /api/projects/[projectId]/drive-imports: batches, billing and destinations', () => {
  it('bills the workspace owner, not the member who started the import', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const admin = await createUser();
    await addProjectMember({ projectId: project.id, userId: admin.id, role: 'ADMIN' });
    signedInAs(admin);

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(201);
    const row = await db.driveImport.findFirstOrThrow();
    expect(row.userId).toBe(admin.id);
    expect(row.billedUserId).toBe(owner.id);
    const reservation = await db.uploadReservation.findFirstOrThrow();
    expect(reservation.billedUserId).toBe(owner.id);
  });

  it('answers a full account with the storage refusal, code included', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    const owner = await createUser();
    const { project } = await seedProject({ ownerUser: owner });
    await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(3) * BigInt(1024) * BigInt(MIB) - BigInt(MIB / 2),
    });
    signedInAs(owner);

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(507);
    expect((await response.json()).code).toBe('TRIAL_STORAGE_LIMIT_EXCEEDED');
    expect(await db.driveImport.count()).toBe(0);
    expect(bunnyFetchCalls()).toHaveLength(0);
  });

  it('imports the files it can and reports the ones it cannot', async () => {
    const OTHER = '2ZyXwVuTsRqPoNmLkJiHgFeDc';
    stubs.driveMetadata = (fileId) =>
      fileId === OTHER
        ? json({ id: fileId, name: 'brief.pdf', mimeType: 'application/pdf', size: '10' })
        : json({ id: fileId, name: 'Cut 3.mp4', mimeType: 'video/mp4', size: String(MIB) });
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await startRequest(project.id, {
      fileIds: [FILE_ID, OTHER],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    const data = await readData<{
      imports: Array<{ driveFileId: string }>;
      errors: Array<{ driveFileId: string; error: string }>;
    }>(response);
    expect(data.imports.map((i) => i.driveFileId)).toEqual([FILE_ID]);
    expect(data.errors).toEqual([
      { driveFileId: OTHER, error: expect.stringContaining('Only video') },
    ]);
    expect(await db.driveImport.count()).toBe(1);
  });

  it('keeps the files already started when a later one throws', async () => {
    const OTHER = '2ZyXwVuTsRqPoNmLkJiHgFeDc';
    stubs.driveMetadata = (fileId) => {
      if (fileId === OTHER) throw new TypeError('network down');
      return json({ id: fileId, name: 'Cut 3.mp4', mimeType: 'video/mp4', size: String(MIB) });
    };
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await startRequest(project.id, {
      fileIds: [FILE_ID, OTHER],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    const data = await readData<{ errors: Array<{ driveFileId: string }> }>(response);
    expect(data.errors.map((e) => e.driveFileId)).toEqual([OTHER]);
    expect(await db.driveImport.count()).toBe(1);
  });

  it('imports a file picked twice only once', async () => {
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await startRequest(project.id, {
      fileIds: [FILE_ID, FILE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    expect(await db.driveImport.count()).toBe(1);
    expect(bunnyFetchCalls()).toHaveLength(1);
  });

  it('refuses more files than one request may carry', async () => {
    const { owner, project } = await seedProject();
    signedInAs(owner);
    const fileIds = Array.from(
      { length: 11 },
      (_, i) => `${FILE_ID.slice(0, 20)}x${String(i).padStart(4, '0')}`
    );

    const response = await startRequest(project.id, { fileIds, accessToken: TOKEN });

    expect(response.status).toBe(400);
    expect(await db.driveImport.count()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('is off when the host turns it off', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_DRIVE_IMPORT', 'false');
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(400);
    expect(await db.driveImport.count()).toBe(0);
  });

  it('refuses a new version for an image review', async () => {
    const { owner, project } = await seedProject();
    const image = await db.video.create({
      data: { projectId: project.id, title: 'Poster', mediaType: 'IMAGE' },
    });
    signedInAs(owner);

    const response = await startRequest(project.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
      targetVideoId: image.id,
    });

    expect(response.status).toBe(400);
    expect(await db.driveImport.count()).toBe(0);
  });

  // A folder editor who is not a project member: POST lets them in, and their
  // polls have to be able to finish what they started.
  it('lets a folder-only editor import into the folder and see it land there', async () => {
    stubs.bunnyVideo = () => json({ guid: BUNNY_GUID, status: 3 });
    const { project } = await seedProject();
    const folder = await db.projectFolder.create({
      data: { projectId: project.id, name: 'Client A' },
    });
    const editor = await createUser();
    await db.projectFolderMember.create({
      data: { folderId: folder.id, userId: editor.id, role: 'ADMIN' },
    });
    signedInAs(editor);

    const started = await startRequest(project.id, {
      fileIds: [FILE_ID],
      accessToken: TOKEN,
      folderId: folder.id,
    });
    expect(started.status).toBe(201);

    const polled = await listRequest(project.id);

    expect(polled.status).toBe(200);
    const video = await db.video.findFirstOrThrow();
    expect(video.folderId).toBe(folder.id);
  });

  it('refuses, on a self-hosted server, a format it could not serve', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'true');
    vi.stubEnv('R2_ACCESS_KEY_ID', 'k');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 's');
    vi.stubEnv('R2_BUCKET_NAME', 'b');
    vi.stubEnv('R2_ENDPOINT', 'http://127.0.0.1:9000');
    stubs.driveMetadata = (fileId) =>
      json({ id: fileId, name: 'old.flv', mimeType: 'video/x-flv', size: String(MIB) });
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await startRequest(project.id, { fileIds: [FILE_ID], accessToken: TOKEN });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('cannot be stored');
    expect(await db.driveImport.count()).toBe(0);
    expect(bunnyFetchCalls()).toHaveLength(0);
  });
});

describe('GET /api/projects/[projectId]/drive-imports: finishing a Bunny import', () => {
  it('turns a fetched video into a video in the project and hands the quota over', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    stubs.bunnyVideo = () => json({ guid: BUNNY_GUID, status: 3 });
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const reservation = await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(MIB),
      purpose: UPLOAD_RESERVATION_PURPOSES.DRIVE_IMPORT,
    });
    const row = await createImportRow(owner, project.id, { reservationId: reservation.id });
    signedInAs(owner);

    const response = await listRequest(project.id);

    expect(response.status).toBe(200);
    const data = await readData<{ imports: Array<{ status: string }>; landed: string[] }>(response);
    expect(data.landed).toEqual([row.id]);
    expect(data.imports[0]!.status).toBe('DONE');

    const video = await db.video.findFirstOrThrow({ include: { versions: true } });
    expect(video).toMatchObject({ projectId: project.id, folderId: null, title: 'Cut 3' });
    expect(video.versions).toHaveLength(1);
    expect(video.versions[0]).toMatchObject({
      providerId: 'bunny',
      videoId: BUNNY_GUID,
      originalUrl: `https://iframe.mediadelivery.net/embed/424242/${BUNNY_GUID}`,
      thumbnailUrl: `https://vz-test.b-cdn.net/${BUNNY_GUID}/thumbnail.jpg`,
      isActive: true,
    });
    expect(video.versions[0]!.sizeBytes).toBe(BigInt(MIB));

    const after = await db.driveImport.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: 'DONE', createdVideoId: video.id });
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('leaves an import Bunny has not started alone while there is still time', async () => {
    const { owner, project } = await seedProject();
    const row = await createImportRow(owner, project.id);
    signedInAs(owner);

    await listRequest(project.id);

    expect((await db.driveImport.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'TRANSFERRING'
    );
    expect(await db.video.count()).toBe(0);
  });

  it('fails an import Bunny never received once the token has long expired', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const reservation = await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(MIB),
      purpose: UPLOAD_RESERVATION_PURPOSES.DRIVE_IMPORT,
    });
    const row = await createImportRow(owner, project.id, {
      reservationId: reservation.id,
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    signedInAs(owner);

    await listRequest(project.id);

    const after = await db.driveImport.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('FAILED');
    expect(after.error).toContain('in time');
    expect(await db.uploadReservation.count()).toBe(0);
    expect(await db.video.count()).toBe(0);
    expect(
      calls.some((call) => call.method === 'DELETE' && call.url.endsWith(`/videos/${BUNNY_GUID}`))
    ).toBe(true);
  });

  it('fails an import Bunny could not process', async () => {
    stubs.bunnyVideo = () => json({ guid: BUNNY_GUID, status: 5 });
    const { owner, project } = await seedProject();
    const row = await createImportRow(owner, project.id);
    signedInAs(owner);

    await listRequest(project.id);

    expect((await db.driveImport.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'FAILED'
    );
    expect(await db.video.count()).toBe(0);
  });

  it('writes one video when two polls reach the same finished import at once', async () => {
    stubs.bunnyVideo = () => json({ guid: BUNNY_GUID, status: 4 });
    const { owner, project } = await seedProject();
    await createImportRow(owner, project.id);
    signedInAs(owner);

    const [first, second] = await Promise.all([listRequest(project.id), listRequest(project.id)]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await db.video.count()).toBe(1);
    expect(await db.videoVersion.count()).toBe(1);
    expect((await db.driveImport.findFirstOrThrow()).status).toBe('DONE');
  });

  it('adds a new active version when the import targets an existing video', async () => {
    stubs.bunnyVideo = () => json({ guid: BUNNY_GUID, status: 3 });
    const { owner, project } = await seedProject();
    const video = await createVideo({ projectId: project.id });
    const first = await createVersion({ videoParentId: video.id });
    await createImportRow(owner, project.id, { targetVideoId: video.id });
    signedInAs(owner);

    await listRequest(project.id);

    const versions = await db.videoVersion.findMany({
      where: { videoParentId: video.id },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions.map((v) => [v.versionNumber, v.isActive, v.videoId])).toEqual([
      [first.versionNumber, false, first.videoId],
      [first.versionNumber + 1, true, BUNNY_GUID],
    ]);
    expect(await db.video.count()).toBe(1);
  });

  it('credits a new video to the member who imported it and its event to the owner', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
    stubs.bunnyVideo = () => json({ guid: BUNNY_GUID, status: 3 });
    const { owner, project } = await seedProject();
    const admin = await createUser();
    await addProjectMember({ projectId: project.id, userId: admin.id, role: 'ADMIN' });
    await createImportRow(admin, project.id, { billedUserId: owner.id });
    signedInAs(admin);

    await listRequest(project.id);

    const version = await db.videoVersion.findFirstOrThrow();
    expect(version.uploadedById).toBe(admin.id);
    // The event is recorded after the poll answers, so wait for it.
    const event = await vi.waitFor(() =>
      db.analyticsEvent.findFirstOrThrow({ where: { name: 'VIDEO_ADDED' } })
    );
    expect(event).toMatchObject({ userId: owner.id, actorId: admin.id });
  });

  it('credits a new version to the member who imported it and its activity to the owner', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
    stubs.bunnyVideo = () => json({ guid: BUNNY_GUID, status: 3 });
    const { owner, project } = await seedProject();
    const admin = await createUser();
    await addProjectMember({ projectId: project.id, userId: admin.id, role: 'ADMIN' });
    const video = await createVideo({ projectId: project.id });
    await createVersion({ videoParentId: video.id });
    await createImportRow(admin, project.id, { targetVideoId: video.id, billedUserId: owner.id });
    signedInAs(admin);

    await listRequest(project.id);

    const version = await db.videoVersion.findFirstOrThrow({ where: { videoId: BUNNY_GUID } });
    expect(version.uploadedById).toBe(admin.id);
    const event = await vi.waitFor(() =>
      db.analyticsEvent.findFirstOrThrow({ where: { name: 'VERSION_ADDED' } })
    );
    expect(event).toMatchObject({ userId: owner.id, actorId: admin.id });
    expect(await db.analyticsEvent.count({ where: { name: 'VIDEO_ADDED' } })).toBe(0);
  });

  it('shows a caller only their own imports', async () => {
    const { owner, project } = await seedProject();
    const colleague = await createUser();
    await addProjectMember({ projectId: project.id, userId: colleague.id, role: 'ADMIN' });
    await createImportRow(owner, project.id);
    signedInAs(colleague);

    const response = await listRequest(project.id);

    expect(response.status).toBe(200);
    expect((await readData<{ imports: unknown[] }>(response)).imports).toEqual([]);
    expect(calls.filter((call) => call.url.includes('bunnycdn'))).toHaveLength(0);
  });

  it('shows a caller with no access to the project nothing, and finishes nothing', async () => {
    stubs.bunnyVideo = () => json({ guid: BUNNY_GUID, status: 3 });
    const { owner, project } = await seedProject();
    const row = await createImportRow(owner, project.id);
    signedInAs(await createUser());

    const response = await listRequest(project.id);

    expect(response.status).toBe(200);
    expect((await readData<{ imports: unknown[] }>(response)).imports).toEqual([]);
    expect((await db.driveImport.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'TRANSFERRING'
    );
    expect(await db.video.count()).toBe(0);
  });

  it('reports nothing landed when a poll finishes nothing', async () => {
    const { owner, project } = await seedProject();
    await createImportRow(owner, project.id);
    signedInAs(owner);

    const response = await listRequest(project.id);

    expect((await readData<{ landed: string[] }>(response)).landed).toEqual([]);
  });

  it('fails an import whose Bunny upload failed', async () => {
    stubs.bunnyVideo = () => json({ guid: BUNNY_GUID, status: 6 });
    const { owner, project } = await seedProject();
    const row = await createImportRow(owner, project.id);
    signedInAs(owner);

    await listRequest(project.id);

    expect((await db.driveImport.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'FAILED'
    );
    expect(await db.video.count()).toBe(0);
  });

  it('fails an import whose Bunny video is gone', async () => {
    stubs.bunnyVideo = () => json({ message: 'not found' }, 404);
    const { owner, project } = await seedProject();
    const row = await createImportRow(owner, project.id);
    signedInAs(owner);

    await listRequest(project.id);

    const after = await db.driveImport.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('FAILED');
    expect(after.error).toContain('no longer in video storage');
  });

  it('keeps waiting on Bunny well inside the fetch deadline', async () => {
    const { owner, project } = await seedProject();
    const row = await createImportRow(owner, project.id, {
      createdAt: new Date(Date.now() - 90 * 60 * 1000),
    });
    signedInAs(owner);

    await listRequest(project.id);

    expect((await db.driveImport.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'TRANSFERRING'
    );
  });

  it('fails an import Bunny never gave an id for, once the start deadline passed', async () => {
    const { owner, project } = await seedProject();
    const row = await createImportRow(owner, project.id, {
      bunnyVideoId: null,
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    signedInAs(owner);

    await listRequest(project.id);

    expect((await db.driveImport.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'FAILED'
    );
  });

  // The quota hold outlives this age, and nothing after it is attached: an
  // import nobody polled for a day must not become a video its account never
  // had to have room for.
  it('fails rather than attaches an import older than a day, even though Bunny finished it', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    stubs.bunnyVideo = () => json({ guid: BUNNY_GUID, status: 4 });
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const reservation = await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(MIB),
      purpose: UPLOAD_RESERVATION_PURPOSES.DRIVE_IMPORT,
    });
    const row = await createImportRow(owner, project.id, {
      reservationId: reservation.id,
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    signedInAs(owner);

    await listRequest(project.id);

    const after = await db.driveImport.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('FAILED');
    expect(await db.video.count()).toBe(0);
    expect(await db.uploadReservation.count()).toBe(0);
    expect(
      calls.some((call) => call.method === 'DELETE' && call.url.endsWith(`/videos/${BUNNY_GUID}`))
    ).toBe(true);
  });

  it('hands a finalize that crashed long ago back for another attempt', async () => {
    const { owner, project } = await seedProject();
    const row = await createImportRow(owner, project.id, { status: 'FINALIZING' });
    await db.$executeRaw`UPDATE drive_imports SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${row.id}`;
    signedInAs(owner);

    await listRequest(project.id);

    expect((await db.driveImport.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'TRANSFERRING'
    );
  });

  it('leaves a finalize that is still running alone', async () => {
    const { owner, project } = await seedProject();
    const row = await createImportRow(owner, project.id, { status: 'FINALIZING' });
    signedInAs(owner);

    await listRequest(project.id);

    expect((await db.driveImport.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'FINALIZING'
    );
  });
});

describe('finalizeDriveImport', () => {
  // The concurrent case above is also covered by the serializable transaction;
  // this one is not. A late reconcile or a retried copier reaching an import
  // that already finished must not write a second video.
  it('writes nothing more for an import that is already done', async () => {
    const { owner, project } = await seedProject();
    const row = await createImportRow(owner, project.id);

    await finalizeDriveImport(row.id);
    await finalizeDriveImport(row.id);

    expect(await db.video.count()).toBe(1);
    expect((await db.driveImport.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('DONE');
  });

  it('writes nothing when the uploader lost access while the bytes were moving', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const editor = await createUser();
    const membership = await addProjectMember({
      projectId: project.id,
      userId: editor.id,
      role: 'ADMIN',
    });
    const reservation = await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(MIB),
      purpose: UPLOAD_RESERVATION_PURPOSES.DRIVE_IMPORT,
    });
    const row = await createImportRow(editor, project.id, {
      billedUserId: owner.id,
      reservationId: reservation.id,
    });
    await db.projectMember.delete({ where: { id: membership.id } });

    await finalizeDriveImport(row.id);

    const after = await db.driveImport.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('FAILED');
    expect(after.error).toContain('no longer have access');
    expect(await db.video.count()).toBe(0);
    expect(await db.uploadReservation.count()).toBe(0);
  });
});

describe('finalizeDriveImport, new versions', () => {
  it('writes no version when the uploader lost access to the target video', async () => {
    const { owner, project } = await seedProject();
    const video = await createVideo({ projectId: project.id });
    await createVersion({ videoParentId: video.id });
    const editor = await createUser();
    const membership = await addProjectMember({
      projectId: project.id,
      userId: editor.id,
      role: 'ADMIN',
    });
    const row = await createImportRow(editor, project.id, {
      billedUserId: owner.id,
      targetVideoId: video.id,
    });
    await db.projectMember.delete({ where: { id: membership.id } });

    await finalizeDriveImport(row.id);

    expect((await db.driveImport.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'FAILED'
    );
    expect(await db.videoVersion.count({ where: { videoParentId: video.id } })).toBe(1);
  });
});

describe('copyDriveFileToS3', () => {
  beforeEach(() => {
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'true');
    vi.stubEnv('OPENFRAME_R2_MULTIPART_PART_SIZE_BYTES', String(5 * MIB));
  });

  async function s3Row(
    sizeBytes: number,
    data: Partial<Prisma.DriveImportUncheckedCreateInput> = {}
  ) {
    const { owner, project } = await seedProject();
    const row = await createImportRow(owner, project.id, {
      backend: 'S3',
      bunnyVideoId: null,
      sizeBytes: BigInt(sizeBytes),
      ...data,
    });
    return { owner, project, row };
  }

  it('copies the file in equal parts and turns it into a video served from our storage', async () => {
    const size = 11 * MIB + 123;
    stubs.driveDownload = () => streamOf(videoBytes(size));
    const { project, row } = await s3Row(size);

    await copyDriveFileToS3(row.id, TOKEN, null);

    // R2 wants every part but the last to be the same size.
    const partSizes = vi
      .mocked(r2.uploadVideoPart)
      .mock.calls.map(([, , partNumber, body]) => [partNumber, body.byteLength]);
    expect(partSizes).toEqual([
      [1, 5 * MIB],
      [2, 5 * MIB],
      [3, MIB + 123],
    ]);
    expect(r2.completeMultipartVideoUpload).toHaveBeenCalledTimes(1);

    const after = await db.driveImport.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('DONE');
    const video = await db.video.findFirstOrThrow({ include: { versions: true } });
    expect(video.projectId).toBe(project.id);
    expect(video.versions[0]!.providerId).toBe('r2');
    expect(video.versions[0]!.videoId).toBe(after.objectKey);
    expect(video.versions[0]!.videoId).toMatch(/^videos\/[0-9a-f-]{36}\.mp4$/);
    expect(video.versions[0]!.originalUrl).toBe(
      `/api/upload/video/${after.objectKey!.slice('videos/'.length)}`
    );
    expect(video.versions[0]!.sizeBytes).toBe(BigInt(size));

    const download = calls.find((call) => call.url.includes('alt=media'));
    expect(download?.url).toContain(FILE_ID);
  });

  it('stops and cleans up when Drive sends more than it said the file holds', async () => {
    stubs.driveDownload = () => streamOf(videoBytes(2 * MIB));
    const { row } = await s3Row(MIB);

    await copyDriveFileToS3(row.id, TOKEN, null);

    const after = await db.driveImport.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('FAILED');
    expect(after.error).toContain('larger than Drive reported');
    expect(r2.abortMultipartVideoUpload).toHaveBeenCalled();
    expect(r2.completeMultipartVideoUpload).not.toHaveBeenCalled();
    expect(await db.video.count()).toBe(0);
  });

  it('refuses bytes that are not a video, whatever Drive called the file', async () => {
    stubs.driveDownload = () => streamOf(new Uint8Array(MIB).fill(0x41));
    const { row } = await s3Row(MIB);

    await copyDriveFileToS3(row.id, TOKEN, null);

    const after = await db.driveImport.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('FAILED');
    expect(after.error).toContain('not a video');
    expect(r2.uploadVideoPart).not.toHaveBeenCalled();
    expect(await db.video.count()).toBe(0);
  });

  it('fails a copy whose process stopped reporting, and gives back what it held', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const reservation = await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(MIB),
      purpose: UPLOAD_RESERVATION_PURPOSES.DRIVE_IMPORT,
    });
    const row = await createImportRow(owner, project.id, {
      backend: 'S3',
      bunnyVideoId: null,
      reservationId: reservation.id,
      objectKey: 'videos/11111111-2222-3333-4444-555555555555.mp4',
      multipartUploadId: 'upload-in-progress',
      thumbnailObjectKey: 'images/11111111-2222-3333-4444-555555555555.jpg',
      heartbeatAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    signedInAs(owner);

    await listRequest(project.id);

    const after = await db.driveImport.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('FAILED');
    expect(after.error).toContain('stopped');
    expect(await db.uploadReservation.count()).toBe(0);
    expect(r2.abortMultipartVideoUpload).toHaveBeenCalledWith(
      'videos/11111111-2222-3333-4444-555555555555.mp4',
      'upload-in-progress'
    );
    expect(r2.deleteR2Object).toHaveBeenCalledWith(
      'images/11111111-2222-3333-4444-555555555555.jpg'
    );
  });

  it('finalizes a copy that finished but was never attached', async () => {
    const { owner, project, row } = await s3Row(MIB, {
      objectKey: 'videos/11111111-2222-3333-4444-555555555555.mp4',
      transferredAt: new Date(),
    });
    signedInAs(owner);

    await listRequest(project.id);

    expect((await db.driveImport.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('DONE');
    expect((await db.videoVersion.findFirstOrThrow()).providerId).toBe('r2');
  });

  it('refuses a download that ends before the size Drive reported', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    stubs.driveDownload = () => streamOf(videoBytes(MIB / 2));
    const owner = await createSubscribedUser();
    const { project } = await seedProject({ ownerUser: owner });
    const reservation = await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(MIB),
      purpose: UPLOAD_RESERVATION_PURPOSES.DRIVE_IMPORT,
    });
    const row = await createImportRow(owner, project.id, {
      backend: 'S3',
      bunnyVideoId: null,
      reservationId: reservation.id,
    });

    await copyDriveFileToS3(row.id, TOKEN, null);

    const after = await db.driveImport.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('FAILED');
    expect(after.error).toContain('ended early');
    expect(r2.completeMultipartVideoUpload).not.toHaveBeenCalled();
    expect(r2.abortMultipartVideoUpload).toHaveBeenCalled();
    expect(await db.uploadReservation.count()).toBe(0);
    expect(await db.video.count()).toBe(0);
  });

  it('deletes its finished object when the import was failed while it copied', async () => {
    const { row } = await s3Row(MIB);
    let sent = false;
    stubs.driveDownload = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (sent) {
              // The reconciler gave up on this copy while its last bytes were in flight.
              await db.driveImport.update({ where: { id: row.id }, data: { status: 'FAILED' } });
              controller.close();
              return;
            }
            sent = true;
            controller.enqueue(videoBytes(MIB));
          },
        })
      );

    await copyDriveFileToS3(row.id, TOKEN, null);

    const after = await db.driveImport.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('FAILED');
    expect(r2.deleteVideoObject).toHaveBeenCalledWith(after.objectKey);
    expect(await db.video.count()).toBe(0);
  });

  it('stores the Drive thumbnail with the video', async () => {
    const thumbnail = 'https://lh3.googleusercontent.com/drive-storage/thumb=s220';
    const { row } = await s3Row(MIB);
    const fetchMock = vi.mocked(fetch);
    const route = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === thumbnail) {
        calls.push({ url: thumbnail, method: 'GET', body: null });
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer, {
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      return route(input, init);
    });

    await copyDriveFileToS3(row.id, TOKEN, thumbnail);

    const [key, contentType] = vi.mocked(r2.putImageObject).mock.calls[0]!;
    expect(key).toMatch(/^images\/[0-9a-f-]{36}\.jpg$/);
    expect(contentType).toBe('image/jpeg');
    const version = await db.videoVersion.findFirstOrThrow();
    expect(version.thumbnailUrl).toBe(`/api/upload/image/${key.slice('images/'.length)}`);
  });

  it('never sends the Google token to a thumbnail host that is not Google', async () => {
    const { row } = await s3Row(MIB);

    await copyDriveFileToS3(row.id, TOKEN, 'https://evil.example/thumb.jpg');

    expect(calls.some((call) => call.url.includes('evil.example'))).toBe(false);
    expect(r2.putImageObject).not.toHaveBeenCalled();
    expect((await db.videoVersion.findFirstOrThrow()).thumbnailUrl).toBe(
      '/placeholder-video-thumbnail.png'
    );
  });
});
