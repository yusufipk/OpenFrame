// Google Drive images picked on the "Add file" page become image reviews,
// through the same storage code as a browser image upload. Google is a fetch
// stub; storage is a mocked S3 client, as in image-reviews.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { db } from '@/lib/db';
import { POST } from '@/app/api/projects/[projectId]/drive-imports/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs } from '../helpers/session';
import { createUploadReservation, createUser, createVideo, seedProject } from '../factories';

const { r2Send } = vi.hoisted(() => ({ r2Send: vi.fn() }));
vi.mock('@/lib/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/r2')>();
  return { ...actual, r2Client: { send: r2Send } };
});

const CLIENT_ID = 'drive-test-client.apps.googleusercontent.com';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN = 'ya29.good-drive-token';
const IMAGE_ID = '1ImAgEiMaGeImAgEiMaGeImAg';
const OTHER_IMAGE_ID = '2ImAgEiMaGeImAgEiMaGeImAg';
const VIDEO_ID = '3ViDeOvIdEoViDeOvIdEoViDe';
const MIB = 1024 * 1024;

// A real 1x1 PNG, so sharp can decode it and draw a thumbnail.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
);

type DriveFile = { name: string; mimeType: string; size: number; bytes?: Buffer };
let driveFiles: Record<string, DriveFile>;
let downloads: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  downloads = [];
  driveFiles = {
    [IMAGE_ID]: { name: 'Poster final.png', mimeType: 'image/png', size: PNG.length, bytes: PNG },
    [OTHER_IMAGE_ID]: {
      name: 'Poster alt.png',
      mimeType: 'image/png',
      size: PNG.length,
      bytes: PNG,
    },
    [VIDEO_ID]: { name: 'Cut.mp4', mimeType: 'video/mp4', size: MIB },
  };
  vi.stubEnv('GOOGLE_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('GOOGLE_PICKER_API_KEY', 'test-picker-key');
  vi.stubEnv('GOOGLE_CLOUD_PROJECT_NUMBER', '123456789012');
  vi.stubEnv('OPENFRAME_ENABLE_DRIVE_IMPORT', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'false');
  vi.stubEnv('BUNNY_STREAM_API_KEY', 'test-bunny-key');
  vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '424242');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'test-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test-secret');
  vi.stubEnv('R2_BUCKET_NAME', 'test-bucket');
  vi.stubEnv('R2_ENDPOINT', 'http://minio-test:9000');
  r2Send.mockReset();
  r2Send.mockResolvedValue({});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url
      );
      if (url.origin === 'https://oauth2.googleapis.com') {
        return json({ aud: CLIENT_ID, scope: DRIVE_FILE_SCOPE, expires_in: '3500' });
      }
      if (url.origin === 'https://www.googleapis.com') {
        const fileId = url.pathname.slice('/drive/v3/files/'.length);
        const entry = driveFiles[fileId]!;
        if (url.searchParams.get('alt') === 'media') {
          downloads.push(fileId);
          return new Response(new Uint8Array(entry.bytes ?? []));
        }
        return json({
          id: fileId,
          name: entry.name,
          mimeType: entry.mimeType,
          size: String(entry.size),
        });
      }
      if (url.origin === 'https://video.bunnycdn.com' && init?.method === 'POST') {
        return json({ success: true, id: 'bunny-guid-0003-image' });
      }
      return json({}, 404);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function start(projectId: string, body: Record<string, unknown>) {
  return callRoute(POST, apiRequest(`/api/projects/${projectId}/drive-imports`, { body }), {
    projectId,
  });
}

function storedKeys(): string[] {
  return r2Send.mock.calls
    .map(([command]) => command)
    .filter((command): command is PutObjectCommand => command instanceof PutObjectCommand)
    .map((command) => command.input.Key!);
}

describe('POST /api/projects/[projectId]/drive-imports: images become image reviews', () => {
  it('adds a picked image as an image review with a thumbnail', async () => {
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await start(project.id, { fileIds: [IMAGE_ID], accessToken: TOKEN });

    expect(response.status).toBe(201);
    const data = await readData<{ images: Array<{ videoId: string }>; imports: unknown[] }>(
      response
    );
    expect(data.imports).toEqual([]);
    const video = await db.video.findUniqueOrThrow({
      where: { id: data.images[0]!.videoId },
      include: { versions: true },
    });
    expect(video).toMatchObject({
      projectId: project.id,
      mediaType: 'IMAGE',
      title: 'Poster final',
    });
    expect(video.versions).toHaveLength(1);
    expect(video.versions[0]).toMatchObject({
      providerId: 'r2-image',
      sizeBytes: BigInt(PNG.length),
    });
    const keys = storedKeys();
    expect(keys).toHaveLength(2);
    expect(keys).toContain(video.versions[0]!.videoId);
    expect(keys.some((key) => key.endsWith('.webp'))).toBe(true);
    expect(await db.driveImport.count()).toBe(0);
  });

  it('handles a mixed pick: the video starts an import, the image lands at once', async () => {
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await start(project.id, {
      fileIds: [VIDEO_ID, IMAGE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    const data = await readData<{ images: unknown[]; imports: unknown[] }>(response);
    expect(data.images).toHaveLength(1);
    expect(data.imports).toHaveLength(1);
    expect(await db.video.count({ where: { mediaType: 'IMAGE' } })).toBe(1);
    expect(await db.driveImport.findFirstOrThrow()).toMatchObject({ fileName: 'Cut.mp4' });
  });

  it('adds several images from one pick without them conflicting', async () => {
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await start(project.id, {
      fileIds: [IMAGE_ID, OTHER_IMAGE_ID],
      accessToken: TOKEN,
    });

    expect(response.status).toBe(201);
    const data = await readData<{ images: unknown[]; errors: unknown[] }>(response);
    expect(data.errors).toEqual([]);
    expect(data.images).toHaveLength(2);
    const positions = (
      await db.video.findMany({ where: { projectId: project.id }, select: { position: true } })
    ).map((video) => video.position);
    expect(new Set(positions).size).toBe(2);
  });

  it('refuses an image as a new version of a video, without downloading it', async () => {
    const { owner, project } = await seedProject();
    const target = await createVideo({ projectId: project.id });
    signedInAs(owner);

    const response = await start(project.id, {
      fileIds: [IMAGE_ID],
      accessToken: TOKEN,
      targetVideoId: target.id,
    });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('Only video files');
    expect(downloads).toEqual([]);
  });

  it('refuses a GIF, which image reviews do not take, without downloading it', async () => {
    driveFiles[IMAGE_ID] = { name: 'loop.gif', mimeType: 'image/gif', size: 100 };
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await start(project.id, { fileIds: [IMAGE_ID], accessToken: TOKEN });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('PNG, JPEG and WebP');
    expect(downloads).toEqual([]);
  });

  it('refuses an image over 20 MB on the size Drive reports, without downloading it', async () => {
    driveFiles[IMAGE_ID] = { name: 'huge.png', mimeType: 'image/png', size: 20 * MIB + 1 };
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await start(project.id, { fileIds: [IMAGE_ID], accessToken: TOKEN });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('larger than 20 MB');
    expect(downloads).toEqual([]);
  });

  it('refuses bytes that are not the image Drive claims, storing nothing', async () => {
    const fake = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    driveFiles[IMAGE_ID] = { name: 'x.png', mimeType: 'image/png', size: fake.length, bytes: fake };
    const { owner, project } = await seedProject();
    signedInAs(owner);

    const response = await start(project.id, { fileIds: [IMAGE_ID], accessToken: TOKEN });

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('does not match a supported format');
    expect(r2Send).not.toHaveBeenCalled();
    expect(await db.video.count()).toBe(0);
  });

  it('refuses when the account has no storage left, and stores nothing', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    const owner = await createUser();
    const { project } = await seedProject({ ownerUser: owner });
    await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(3) * BigInt(1024) * BigInt(MIB) - BigInt(10),
    });
    signedInAs(owner);

    const response = await start(project.id, { fileIds: [IMAGE_ID], accessToken: TOKEN });

    expect(response.status).toBe(507);
    expect(r2Send).not.toHaveBeenCalled();
    expect(await db.video.count()).toBe(0);
  });
});
