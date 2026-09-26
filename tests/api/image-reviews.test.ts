import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { db } from '@/lib/db';
import { POST as uploadImageReview } from '@/app/api/projects/[projectId]/videos/images/route';
import { POST as addVideoVersion } from '@/app/api/projects/[projectId]/videos/[videoId]/versions/route';
import { DELETE as deleteImageVersion } from '@/app/api/projects/[projectId]/videos/[videoId]/versions/[versionId]/route';
import { DELETE as deleteImageReview } from '@/app/api/projects/[projectId]/videos/[videoId]/route';
import { GET as serveImage } from '@/app/api/upload/image/[filename]/route';
import { getUserTotalStorageBytes } from '@/lib/storage-quota';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { createShareLink, createUploadReservation, createUser, seedProject } from '../factories';
import { signedInAs, signedOut } from '../helpers/session';

const { r2Send } = vi.hoisted(() => ({ r2Send: vi.fn() }));
vi.mock('@/lib/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/r2')>();
  return { ...actual, r2Client: { send: r2Send } };
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
);

function imageRequest(
  projectId: string,
  fields: Record<string, string> = {},
  bytes = PNG,
  mime = 'image/png'
) {
  const form = new FormData();
  form.set('file', new File([bytes], 'review.png', { type: mime }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return apiRequest(`/api/projects/${projectId}/videos/images`, { rawBody: form });
}

beforeEach(() => {
  vi.stubEnv('R2_ACCESS_KEY_ID', 'test-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test-secret');
  vi.stubEnv('R2_BUCKET_NAME', 'test-bucket');
  vi.stubEnv('R2_ENDPOINT', 'http://minio-test:9000');
  r2Send.mockReset();
  r2Send.mockResolvedValue({});
});

afterEach(() => vi.unstubAllEnvs());

describe('POST /api/projects/[projectId]/videos/images', () => {
  it('refuses anonymous uploads before writing storage or rows', async () => {
    const { project } = await seedProject();
    signedOut();
    const response = await callRoute(uploadImageReview, imageRequest(project.id), {
      projectId: project.id,
    });
    expect(response.status).toBe(401);
    expect(r2Send).not.toHaveBeenCalled();
    expect(await db.video.count({ where: { projectId: project.id } })).toBe(0);
  });

  it('refuses a signed-in outsider and malformed image bytes', async () => {
    const { project, owner } = await seedProject();
    signedInAs(await createUser());
    expect(
      (await callRoute(uploadImageReview, imageRequest(project.id), { projectId: project.id }))
        .status
    ).toBe(403);
    signedInAs(owner);
    const invalid = imageRequest(project.id, {}, Buffer.from('not a png'), 'image/png');
    expect((await callRoute(uploadImageReview, invalid, { projectId: project.id })).status).toBe(
      400
    );
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('stores an image review, then adds an image version and charges both files', async () => {
    const { project, owner } = await seedProject();
    signedInAs(owner);
    const first = await callRoute(
      uploadImageReview,
      imageRequest(project.id, { title: 'Still frame' }),
      { projectId: project.id }
    );
    expect(first.status).toBe(201);
    const firstData = await readData<{ id: string; videoId: string; versionId: string }>(first);
    expect(firstData.videoId).toBe(firstData.id);
    const second = await callRoute(
      uploadImageReview,
      imageRequest(project.id, { targetVideoId: firstData.id, versionLabel: 'Retouch' }),
      { projectId: project.id }
    );
    expect(second.status).toBe(201);
    const secondData = await readData<{ id: string; versionId: string }>(second);
    expect(secondData.id).toBe(firstData.id);
    const video = await db.video.findUniqueOrThrow({
      where: { id: firstData.id },
      include: { versions: { orderBy: { versionNumber: 'asc' } } },
    });
    expect(video.mediaType).toBe('IMAGE');
    expect(
      video.versions.map((v) => [
        v.versionNumber,
        v.isActive,
        v.providerId,
        v.duration,
        v.sizeBytes,
      ])
    ).toEqual([
      [1, false, 'r2-image', null, BigInt(PNG.length)],
      [2, true, 'r2-image', null, BigInt(PNG.length)],
    ]);
    expect(video.versions.every((version) => version.thumbnailUrl !== version.originalUrl)).toBe(
      true
    );
    expect(video.versions.every((version) => version.thumbnailUrl?.endsWith('.webp'))).toBe(true);
    expect(video.versions.every((version) => version.thumbnailSizeBytes > BigInt(0))).toBe(true);
    expect(await getUserTotalStorageBytes(owner.id)).toBe(
      video.versions.reduce(
        (sum, version) => sum + version.sizeBytes + version.thumbnailSizeBytes,
        BigInt(0)
      )
    );
    expect(
      r2Send.mock.calls.filter(([command]) => command instanceof PutObjectCommand)
    ).toHaveLength(4);
    const blockedVideoVersion = await callRoute(
      addVideoVersion,
      apiRequest(`/api/projects/${project.id}/videos/${video.id}/versions`, {
        body: { videoUrl: 'https://example.com/video', providerId: 'youtube' },
      }),
      { projectId: project.id, videoId: video.id }
    );
    expect(blockedVideoVersion.status).toBe(400);
    expect(await db.videoVersion.count({ where: { videoParentId: video.id } })).toBe(2);
  });

  it('refuses an outsider adding an image version without changing rows or storage', async () => {
    const { project, owner } = await seedProject();
    signedInAs(owner);
    const created = await readData<{ id: string }>(
      await callRoute(uploadImageReview, imageRequest(project.id), { projectId: project.id })
    );
    r2Send.mockClear();
    signedInAs(await createUser());
    const response = await callRoute(
      uploadImageReview,
      imageRequest(project.id, { targetVideoId: created.id }),
      { projectId: project.id }
    );
    expect(response.status).toBe(403);
    expect(await db.videoVersion.count({ where: { videoParentId: created.id } })).toBe(1);
    expect(r2Send).not.toHaveBeenCalled();
  });

  it('refuses an over-quota image before storage write or row creation', async () => {
    const { project, owner } = await seedProject();
    await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(3) * BigInt(1024) * BigInt(1024) * BigInt(1024),
    });
    signedInAs(owner);
    const response = await callRoute(uploadImageReview, imageRequest(project.id), {
      projectId: project.id,
    });
    expect(response.status).toBe(507);
    expect(await db.video.count({ where: { projectId: project.id } })).toBe(0);
    expect(r2Send).not.toHaveBeenCalled();
    expect(await db.uploadReservation.count({ where: { billedUserId: owner.id } })).toBe(1);
  });

  it('serves a review image only to someone with access to its video', async () => {
    const { project, owner } = await seedProject();
    signedInAs(owner);
    const created = await readData<{ id: string; versionId: string }>(
      await callRoute(uploadImageReview, imageRequest(project.id), { projectId: project.id })
    );
    const version = await db.videoVersion.findUniqueOrThrow({ where: { id: created.versionId } });
    const filename = version.originalUrl.split('/').pop()!;
    r2Send.mockImplementation(async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        return { Body: Readable.from([PNG]), ContentLength: PNG.length, ContentType: 'image/png' };
      }
      return {};
    });
    signedInAs(await createUser());
    expect(
      (await callRoute(serveImage, apiRequest(version.originalUrl), { filename })).status
    ).toBe(403);
    signedInAs(owner);
    const response = await callRoute(serveImage, apiRequest(version.originalUrl), { filename });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
  });

  it('serves a review image to a guest with a valid share session', async () => {
    const { project, owner } = await seedProject();
    signedInAs(owner);
    const created = await readData<{ id: string; versionId: string }>(
      await callRoute(uploadImageReview, imageRequest(project.id), { projectId: project.id })
    );
    const version = await db.videoVersion.findUniqueOrThrow({ where: { id: created.versionId } });
    const link = await createShareLink({
      projectId: project.id,
      videoId: created.id,
      permission: 'VIEW',
      allowGuests: true,
    });
    r2Send.mockImplementation(async (command: unknown) =>
      command instanceof GetObjectCommand
        ? { Body: Readable.from([PNG]), ContentLength: PNG.length, ContentType: 'image/png' }
        : {}
    );
    signedOut();
    const response = await callRoute(
      serveImage,
      apiRequest(version.originalUrl, {
        cookies: {
          [getShareSessionCookieName(created.id)]: createShareSessionValue(
            link.token,
            created.id,
            false
          ),
        },
      }),
      { filename: version.originalUrl.split('/').pop()! }
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
  });

  it('removes image objects and releases charged bytes when versions and reviews are deleted', async () => {
    const { project, owner } = await seedProject();
    signedInAs(owner);
    const first = await readData<{ id: string; versionId: string }>(
      await callRoute(uploadImageReview, imageRequest(project.id), { projectId: project.id })
    );
    const second = await readData<{ versionId: string }>(
      await callRoute(uploadImageReview, imageRequest(project.id, { targetVideoId: first.id }), {
        projectId: project.id,
      })
    );
    const versions = await db.videoVersion.findMany({ where: { videoParentId: first.id } });
    r2Send.mockClear();
    const deleteFirst = await callRoute(
      deleteImageVersion,
      apiRequest(`/api/projects/${project.id}/videos/${first.id}/versions/${first.versionId}`, {
        method: 'DELETE',
      }),
      { projectId: project.id, videoId: first.id, versionId: first.versionId }
    );
    expect(deleteFirst.status).toBe(200);
    expect(await db.videoVersion.count({ where: { videoParentId: first.id } })).toBe(1);
    expect(await getUserTotalStorageBytes(owner.id)).toBe(
      versions.find((version) => version.id === second.versionId)!.sizeBytes +
        versions.find((version) => version.id === second.versionId)!.thumbnailSizeBytes
    );
    const deleteReview = await callRoute(
      deleteImageReview,
      apiRequest(`/api/projects/${project.id}/videos/${first.id}`, { method: 'DELETE' }),
      { projectId: project.id, videoId: first.id }
    );
    expect(deleteReview.status).toBe(200);
    expect(await db.video.count({ where: { id: first.id } })).toBe(0);
    expect(await getUserTotalStorageBytes(owner.id)).toBe(BigInt(0));
    expect(
      new Set(
        r2Send.mock.calls
          .filter(([command]) => command instanceof DeleteObjectCommand)
          .map(([command]) => command.input.Key)
      )
    ).toEqual(
      new Set(
        versions.flatMap((version) => [
          version.videoId,
          `images/${version.thumbnailUrl!.split('/').pop()}`,
        ])
      )
    );
    expect(second.versionId).not.toBe(first.versionId);
  });

  it('deletes the uploaded object when the destination disappears during upload', async () => {
    const { project, owner } = await seedProject();
    signedInAs(owner);
    r2Send.mockImplementationOnce(async (command: unknown) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      await db.project.delete({ where: { id: project.id } });
      return {};
    });
    const response = await callRoute(uploadImageReview, imageRequest(project.id), {
      projectId: project.id,
    });
    expect(response.status).toBe(403);
    expect(r2Send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(
      true
    );
    expect(await db.video.count({ where: { projectId: project.id } })).toBe(0);
  });

  it('cleans both possible objects when the thumbnail write fails', async () => {
    const { project, owner } = await seedProject();
    signedInAs(owner);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    r2Send.mockImplementation(async (command: unknown) => {
      if (command instanceof PutObjectCommand && String(command.input.Key).endsWith('.webp')) {
        throw new Error('thumbnail upload failed');
      }
      return {};
    });
    try {
      const response = await callRoute(uploadImageReview, imageRequest(project.id), {
        projectId: project.id,
      });
      expect(response.status).toBe(500);
      const puts = r2Send.mock.calls
        .filter(([command]) => command instanceof PutObjectCommand)
        .map(([command]) => command.input.Key);
      const deletes = r2Send.mock.calls
        .filter(([command]) => command instanceof DeleteObjectCommand)
        .map(([command]) => command.input.Key);
      expect(puts).toHaveLength(2);
      expect(new Set(deletes)).toEqual(new Set(puts));
      expect(await db.video.count({ where: { projectId: project.id } })).toBe(0);
      expect(await db.uploadReservation.count({ where: { billedUserId: owner.id } })).toBe(0);
    } finally {
      logged.mockRestore();
    }
  });
});
