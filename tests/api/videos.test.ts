import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { GET as listVideos, POST as addVideo } from '@/app/api/projects/[projectId]/videos/route';
import { POST as bulkDelete } from '@/app/api/projects/[projectId]/videos/bulk-delete/route';
import {
  GET as listMoveTargets,
  POST as moveVideos,
} from '@/app/api/projects/[projectId]/videos/move/route';
import {
  DELETE as cancelR2Upload,
  POST as initR2Upload,
} from '@/app/api/projects/[projectId]/videos/r2-init/route';
import { POST as completeR2Upload } from '@/app/api/projects/[projectId]/videos/r2-complete/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createProject,
  createShareLink,
  createUser,
  createVersion,
  createVideo,
  createWorkspace,
  seedProject,
  seedVersion,
} from '../factories';

function videosUrl(projectId: string): string {
  return `/api/projects/${projectId}/videos`;
}

/** Turns on the self-hosted direct-upload path for a single test. */
function enableS3VideoUploads(): void {
  vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'false');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'test-access-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test-secret-key');
  vi.stubEnv('R2_BUCKET_NAME', 'openframe-test');
  vi.stubEnv('R2_ACCOUNT_ID', 'test-account');
}

describe('GET /api/projects/[projectId]/videos', () => {
  it('returns 404 for an unknown project', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(listVideos, apiRequest(videosUrl('nope')), {
      projectId: 'nope',
    });

    expect(response.status).toBe(404);
  });

  it('returns 403 to an anonymous caller on a PRIVATE project', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE' });
    signedOut();

    const response = await callRoute(listVideos, apiRequest(videosUrl(scenario.project.id)), {
      projectId: scenario.project.id,
    });

    expect(response.status).toBe(403);
  });

  it('lists videos in position order with the active version only', async () => {
    const scenario = await seedProject();
    const second = await createVideo({ projectId: scenario.project.id, position: 1 });
    const first = await createVideo({ projectId: scenario.project.id, position: 0 });
    await createVersion({ videoParentId: first.id, versionNumber: 1, isActive: false });
    const active = await createVersion({
      videoParentId: first.id,
      versionNumber: 2,
      isActive: true,
    });
    signedInAs(scenario.owner);

    const payload = await readData<{
      videos: Array<{ id: string; versions: Array<{ id: string }>; _count: { versions: number } }>;
    }>(
      await callRoute(listVideos, apiRequest(videosUrl(scenario.project.id)), {
        projectId: scenario.project.id,
      })
    );

    expect(payload.videos.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(payload.videos[0].versions.map((entry) => entry.id)).toEqual([active.id]);
    expect(payload.videos[0]._count.versions).toBe(2);
  });
});

describe('POST /api/projects/[projectId]/videos', () => {
  it('returns 401 without a session', async () => {
    const scenario = await seedProject();
    signedOut();

    const response = await callRoute(
      addVideo,
      apiRequest(videosUrl(scenario.project.id), {
        body: { title: 'X', videoUrl: 'https://www.youtube.com/watch?v=abc' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(401);
    expect(await db.video.count()).toBe(0);
  });

  it('returns 403 for a project COMMENTATOR', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      addVideo,
      apiRequest(videosUrl(scenario.project.id), {
        body: { title: 'X', videoUrl: 'https://www.youtube.com/watch?v=abc' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.video.count()).toBe(0);
  });

  it.each([
    [{ videoUrl: 'https://www.youtube.com/watch?v=abc' }, 'a missing title'],
    [{ title: 'X' }, 'a missing videoUrl'],
    [{ title: 'X', videoUrl: 'javascript:alert(1)' }, 'a javascript: URL'],
    [{ title: 'X', videoUrl: 'data:text/html,<script>' }, 'a data: URL'],
    [{ title: 'X', videoUrl: 'file:///etc/passwd' }, 'a file: URL'],
    [{ title: 'X', videoUrl: 'not a url at all' }, 'an unparseable URL'],
    [
      {
        title: 'X',
        videoUrl: 'https://www.youtube.com/watch?v=abc',
        thumbnailUrl: 'javascript:alert(1)',
      },
      'a javascript: thumbnail',
    ],
    [
      { title: 'X', videoUrl: 'https://www.youtube.com/watch?v=abc', thumbnailUrl: '/etc/passwd' },
      'a traversal-shaped thumbnail path',
    ],
    [
      { title: 'X', videoUrl: '/api/upload/video/abc.mp4', providerId: 'r2' },
      'an r2 upload with no objectKey',
    ],
  ])('rejects %j with 400 (%s)', async (body, label) => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      addVideo,
      apiRequest(videosUrl(scenario.project.id), { body }),
      { projectId: scenario.project.id }
    );

    expect(response.status, label).toBe(400);
    expect(await db.video.count()).toBe(0);
  });

  it('rejects an r2 video whose url is not an upload path', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      addVideo,
      apiRequest(videosUrl(scenario.project.id), {
        body: {
          title: 'X',
          providerId: 'r2',
          videoUrl: 'https://evil.example.com/video.mp4',
          objectKey: 'videos/x.mp4',
          uploadToken: 'nope',
        },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(400);
    expect(await db.video.count()).toBe(0);
  });

  it('rejects a bunny video without a valid upload token', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      addVideo,
      apiRequest(videosUrl(scenario.project.id), {
        body: {
          title: 'X',
          providerId: 'bunny',
          videoUrl: 'https://iframe.mediadelivery.net/play/1/abc',
          videoId: 'abc',
          uploadToken: 'forged.token',
        },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.video.count()).toBe(0);
  });

  it('creates the video with version 1 and appends it after the existing videos', async () => {
    const scenario = await seedProject();
    await createVideo({ projectId: scenario.project.id, position: 0 });
    await createVideo({ projectId: scenario.project.id, position: 7 });
    signedInAs(scenario.owner);

    const response = await callRoute(
      addVideo,
      apiRequest(videosUrl(scenario.project.id), {
        body: {
          title: '  New Cut  ',
          description: '  a description  ',
          videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          videoId: 'dQw4w9WgXcQ',
          duration: 212,
        },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(201);
    const created = await db.video.findFirstOrThrow({
      where: { title: 'New Cut' },
      include: { versions: true },
    });
    expect(created.description).toBe('a description');
    expect(created.position).toBe(8);
    expect(created.projectId).toBe(scenario.project.id);
    expect(created.versions).toHaveLength(1);
    expect(created.versions[0].versionNumber).toBe(1);
    expect(created.versions[0].providerId).toBe('youtube');
    expect(created.versions[0].videoId).toBe('dQw4w9WgXcQ');
    expect(created.versions[0].duration).toBe(212);
    expect(created.versions[0].isActive).toBe(true);
    expect(created.versions[0].sizeBytes).toBe(BigInt(0));
  });

  it('lets a project ADMIN add a video, lowercasing the provider id', async () => {
    const scenario = await seedProject();
    const admin = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: admin.id, role: 'ADMIN' });
    signedInAs(admin);

    const response = await callRoute(
      addVideo,
      apiRequest(videosUrl(scenario.project.id), {
        body: {
          title: 'Admin Cut',
          videoUrl: 'https://vimeo.com/12345',
          providerId: '  VIMEO  ',
          videoId: '12345',
        },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(201);
    expect((await db.videoVersion.findFirstOrThrow()).providerId).toBe('vimeo');
  });
});

describe('POST /api/projects/[projectId]/videos/bulk-delete', () => {
  it('returns 401 without a session', async () => {
    const scenario = await seedVersion();
    signedOut();

    const response = await callRoute(
      bulkDelete,
      apiRequest(`${videosUrl(scenario.project.id)}/bulk-delete`, {
        body: { videoIds: [scenario.video.id] },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(401);
    expect(await db.video.count()).toBe(1);
  });

  it('returns 403 for a project COMMENTATOR', async () => {
    const scenario = await seedVersion();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      bulkDelete,
      apiRequest(`${videosUrl(scenario.project.id)}/bulk-delete`, {
        body: { videoIds: [scenario.video.id] },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.video.count()).toBe(1);
  });

  it.each([
    [{ videoIds: [] }, 'an empty list'],
    [{ videoIds: 'not-an-array' }, 'a non-array'],
    [{}, 'a missing videoIds'],
    [{ videoIds: ['ok', ''] }, 'a blank id'],
    [{ videoIds: [1, 2] }, 'non-string ids'],
    [{ videoIds: Array.from({ length: 51 }, (_unused, index) => `id-${index}`) }, '51 ids'],
  ])('rejects %j with 400 (%s)', async (body, label) => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      bulkDelete,
      apiRequest(`${videosUrl(scenario.project.id)}/bulk-delete`, { body }),
      { projectId: scenario.project.id }
    );

    expect(response.status, label).toBe(400);
    expect(await db.video.count()).toBe(1);
  });

  // The whole point of the route's id check: a project admin must not be able
  // to delete a video out of a project they have nothing to do with.
  it('refuses a batch containing a video from another project and deletes nothing', async () => {
    const mine = await seedVersion();
    const theirs = await seedVersion();
    signedInAs(mine.owner);

    const response = await callRoute(
      bulkDelete,
      apiRequest(`${videosUrl(mine.project.id)}/bulk-delete`, {
        body: { videoIds: [mine.video.id, theirs.video.id] },
      }),
      { projectId: mine.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.video.count()).toBe(2);
  });

  it('deletes the selected videos and cascades to versions', async () => {
    const scenario = await seedVersion();
    const second = await createVideo({ projectId: scenario.project.id, position: 1 });
    await createVersion({ videoParentId: second.id });
    const survivor = await createVideo({ projectId: scenario.project.id, position: 2 });
    signedInAs(scenario.owner);

    const response = await callRoute(
      bulkDelete,
      apiRequest(`${videosUrl(scenario.project.id)}/bulk-delete`, {
        body: { videoIds: [scenario.video.id, second.id, scenario.video.id] },
      }),
      { projectId: scenario.project.id }
    );
    const payload = await readData<{ deletedCount: number }>(response);

    expect(response.status).toBe(200);
    expect(payload.deletedCount).toBe(2);
    expect((await db.video.findMany({ select: { id: true } })).map((row) => row.id)).toEqual([
      survivor.id,
    ]);
    expect(await db.videoVersion.count()).toBe(0);
  });
});

describe('video move', () => {
  it('returns 401 for the target list without a session', async () => {
    const scenario = await seedProject();
    signedOut();

    const response = await callRoute(
      listMoveTargets,
      apiRequest(`${videosUrl(scenario.project.id)}/move`),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(401);
  });

  it('lists current and other projects in the workspace for a workspace ADMIN', async () => {
    const scenario = await seedProject();
    const sibling = await createProject({
      ownerId: scenario.owner.id,
      workspaceId: scenario.workspace.id,
    });
    const elsewhere = await seedProject();
    const workspaceAdmin = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: workspaceAdmin.id,
      role: 'ADMIN',
    });
    signedInAs(workspaceAdmin);

    const payload = await readData<{ projects: Array<{ id: string }> }>(
      await callRoute(listMoveTargets, apiRequest(`${videosUrl(scenario.project.id)}/move`), {
        projectId: scenario.project.id,
      })
    );

    expect(payload.projects.map((entry) => entry.id)).toEqual([scenario.project.id, sibling.id]);
    expect(payload.projects.map((entry) => entry.id)).not.toContain(elsewhere.project.id);
  });

  it('limits the target list to projects a project ADMIN can manage', async () => {
    const scenario = await seedProject();
    const manageable = await createProject({
      ownerId: scenario.owner.id,
      workspaceId: scenario.workspace.id,
    });
    await createProject({ ownerId: scenario.owner.id, workspaceId: scenario.workspace.id });
    const projectAdmin = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: projectAdmin.id,
      role: 'ADMIN',
    });
    await addProjectMember({ projectId: manageable.id, userId: projectAdmin.id, role: 'ADMIN' });
    signedInAs(projectAdmin);

    const payload = await readData<{ projects: Array<{ id: string }> }>(
      await callRoute(listMoveTargets, apiRequest(`${videosUrl(scenario.project.id)}/move`), {
        projectId: scenario.project.id,
      })
    );

    expect(payload.projects.map((entry) => entry.id)).toEqual([scenario.project.id, manageable.id]);
  });

  it.each([
    [{ videoIds: [], targetProjectId: 'x' }, 'an empty video list'],
    [{ videoIds: ['a'] }, 'a missing targetProjectId'],
    [{ videoIds: ['a'], targetProjectId: '   ' }, 'a blank targetProjectId'],
    [{ videoIds: [''], targetProjectId: 'x' }, 'a blank video id'],
  ])('rejects %j with 400 (%s)', async (body, label) => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      moveVideos,
      apiRequest(`${videosUrl(scenario.project.id)}/move`, { body }),
      { projectId: scenario.project.id }
    );

    expect(response.status, label).toBe(400);
    expect((await db.video.findUniqueOrThrow({ where: { id: scenario.video.id } })).projectId).toBe(
      scenario.project.id
    );
  });

  it('refuses a move into the same project', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      moveVideos,
      apiRequest(`${videosUrl(scenario.project.id)}/move`, {
        body: { videoIds: [scenario.video.id], targetProjectId: scenario.project.id },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(400);
  });

  it('refuses a move across workspaces', async () => {
    const source = await seedVersion();
    const target = await seedProject();
    signedInAs(source.owner);

    const response = await callRoute(
      moveVideos,
      apiRequest(`${videosUrl(source.project.id)}/move`, {
        body: { videoIds: [source.video.id], targetProjectId: target.project.id },
      }),
      { projectId: source.project.id }
    );

    expect(response.status).toBe(400);
    expect((await db.video.findUniqueOrThrow({ where: { id: source.video.id } })).projectId).toBe(
      source.project.id
    );
  });

  // The destination permission check. A project ADMIN of the source project has
  // canEdit there but not necessarily in the destination.
  it('refuses a move into a project the caller cannot manage', async () => {
    const scenario = await seedVersion();
    const target = await createProject({
      ownerId: scenario.owner.id,
      workspaceId: scenario.workspace.id,
    });
    const projectAdmin = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: projectAdmin.id,
      role: 'ADMIN',
    });
    await addProjectMember({
      projectId: target.id,
      userId: projectAdmin.id,
      role: 'COMMENTATOR',
    });
    signedInAs(projectAdmin);

    const response = await callRoute(
      moveVideos,
      apiRequest(`${videosUrl(scenario.project.id)}/move`, {
        body: { videoIds: [scenario.video.id], targetProjectId: target.id },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect((await db.video.findUniqueOrThrow({ where: { id: scenario.video.id } })).projectId).toBe(
      scenario.project.id
    );
  });

  it('refuses a move of a video that is not in the source project', async () => {
    const source = await seedVersion();
    const target = await createProject({
      ownerId: source.owner.id,
      workspaceId: source.workspace.id,
    });
    const foreign = await seedVersion();
    signedInAs(source.owner);

    const response = await callRoute(
      moveVideos,
      apiRequest(`${videosUrl(source.project.id)}/move`, {
        body: { videoIds: [foreign.video.id], targetProjectId: target.id },
      }),
      { projectId: source.project.id }
    );

    expect(response.status).toBe(400);
    expect((await db.video.findUniqueOrThrow({ where: { id: foreign.video.id } })).projectId).toBe(
      foreign.project.id
    );
  });

  it('confirms the move, appends positions and revokes old video links', async () => {
    const source = await seedVersion();
    const target = await createProject({
      ownerId: source.owner.id,
      workspaceId: source.workspace.id,
    });
    await createVideo({ projectId: target.id, position: 4 });
    const secondVideo = await createVideo({ projectId: source.project.id, position: 1 });
    const link = await createShareLink({
      projectId: source.project.id,
      videoId: source.video.id,
      permission: 'COMMENT',
    });
    signedInAs(source.owner);

    const previewResponse = await callRoute(
      moveVideos,
      apiRequest(`${videosUrl(source.project.id)}/move`, {
        body: {
          videoIds: [source.video.id, secondVideo.id],
          targetProjectId: target.id,
        },
      }),
      { projectId: source.project.id }
    );
    const preview = await readData<{ needsConfirmation: boolean; confirmationToken: string }>(
      previewResponse
    );
    expect(preview.needsConfirmation).toBe(true);
    expect((await db.video.findUniqueOrThrow({ where: { id: source.video.id } })).projectId).toBe(
      source.project.id
    );
    const response = await callRoute(
      moveVideos,
      apiRequest(`${videosUrl(source.project.id)}/move`, {
        body: {
          videoIds: [source.video.id, secondVideo.id],
          targetProjectId: target.id,
          confirmationToken: preview.confirmationToken,
        },
      }),
      { projectId: source.project.id }
    );
    const payload = await readData<{ movedCount: number; targetProjectId: string }>(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ movedCount: 2, targetProjectId: target.id });

    const moved = await db.video.findUniqueOrThrow({ where: { id: source.video.id } });
    const movedSecond = await db.video.findUniqueOrThrow({ where: { id: secondVideo.id } });
    expect(moved.projectId).toBe(target.id);
    expect(movedSecond.projectId).toBe(target.id);
    expect(moved.position).toBe(5);
    expect(movedSecond.position).toBe(6);

    expect(await db.shareLink.findUnique({ where: { id: link.id } })).toBeNull();
  });
});

describe('R2 video upload session lifecycle', () => {
  beforeEach(() => {
    signedOut();
  });

  it('returns 400 when self-hosted S3 uploads are disabled', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      initR2Upload,
      apiRequest(`${videosUrl(scenario.project.id)}/r2-init`, {
        body: { fileName: 'clip.mp4', sizeBytes: '1024', contentType: 'video/mp4' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(400);
    expect(await db.videoUploadSession.count()).toBe(0);
  });

  it('returns 403 for a project COMMENTATOR', async () => {
    enableS3VideoUploads();
    const scenario = await seedProject();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      initR2Upload,
      apiRequest(`${videosUrl(scenario.project.id)}/r2-init`, {
        body: { fileName: 'clip.mp4', sizeBytes: '1024', contentType: 'video/mp4' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.videoUploadSession.count()).toBe(0);
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it.each([
    [{ sizeBytes: '1024', contentType: 'video/mp4' }, 'a missing fileName'],
    [{ fileName: 'clip.mp4', sizeBytes: '0', contentType: 'video/mp4' }, 'a zero size'],
    [{ fileName: 'clip.mp4', sizeBytes: '-5', contentType: 'video/mp4' }, 'a negative size'],
    [{ fileName: 'clip.mp4', sizeBytes: 'huge', contentType: 'video/mp4' }, 'an unparseable size'],
    [
      { fileName: 'clip.exe', sizeBytes: '1024', contentType: 'application/x-msdownload' },
      'a non-video type',
    ],
    [
      { fileName: 'clip.mp4', sizeBytes: '99999999999999', contentType: 'video/mp4' },
      'a size over the configured maximum',
    ],
  ])('rejects %j with 400 (%s)', async (body, label) => {
    enableS3VideoUploads();
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      initR2Upload,
      apiRequest(`${videosUrl(scenario.project.id)}/r2-init`, { body }),
      { projectId: scenario.project.id }
    );

    expect(response.status, label).toBe(400);
    expect(await db.videoUploadSession.count()).toBe(0);
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('creates an INITIATED session with a quota reservation billed to the workspace owner', async () => {
    enableS3VideoUploads();
    const workspaceOwner = await createUser();
    const workspace = await createWorkspace({ ownerId: workspaceOwner.id });
    const projectOwner = await createUser();
    const project = await createProject({
      ownerId: projectOwner.id,
      workspaceId: workspace.id,
    });
    await addProjectMember({ projectId: project.id, userId: projectOwner.id, role: 'ADMIN' });
    signedInAs(projectOwner);

    const response = await callRoute(
      initR2Upload,
      apiRequest(`${videosUrl(project.id)}/r2-init`, {
        body: { fileName: 'clip.mp4', sizeBytes: '2048', contentType: 'video/mp4' },
      }),
      { projectId: project.id }
    );
    const payload = await readData<{
      presignedPutUrl: string;
      objectKey: string;
      proxyUrl: string;
      uploadToken: string;
      thumbnailObjectKey: string;
      thumbnailProxyUrl: string;
      contentType: string;
      multipart: unknown;
    }>(response);

    expect(response.status).toBe(200);
    expect(payload.objectKey).toMatch(/^videos\/[0-9a-f-]{36}\.mp4$/);
    expect(payload.proxyUrl).toBe(`/api/upload/video/${payload.objectKey.slice('videos/'.length)}`);
    expect(payload.thumbnailObjectKey).toMatch(/^images\/[0-9a-f-]{36}\.jpg$/);
    expect(payload.contentType).toBe('video/mp4');
    expect(payload.multipart).toBeNull();
    expect(payload.presignedPutUrl).toContain(payload.objectKey);

    const session = await db.videoUploadSession.findFirstOrThrow();
    expect(session.status).toBe('INITIATED');
    expect(session.userId).toBe(projectOwner.id);
    expect(session.projectId).toBe(project.id);
    // Storage is billed to the workspace owner, not to whoever pressed upload.
    expect(session.billedUserId).toBe(workspaceOwner.id);
    expect(session.objectKey).toBe(payload.objectKey);
    expect(session.declaredSizeBytes).toBe(BigInt(2048));
    expect(session.multipartUploadId).toBeNull();
    expect(session.consumedAt).toBeNull();
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const reservation = await db.uploadReservation.findFirstOrThrow();
    expect(reservation.id).toBe(session.reservationId);
    expect(reservation.billedUserId).toBe(workspaceOwner.id);
    // The declared size plus the 512 KiB thumbnail headroom.
    expect(reservation.sizeBytes).toBe(BigInt(2048) + BigInt(512 * 1024));
  });

  it('switches to multipart above the threshold and records the upload id', async () => {
    enableS3VideoUploads();
    vi.stubEnv('OPENFRAME_R2_MULTIPART_THRESHOLD_BYTES', '1024');
    vi.stubEnv('OPENFRAME_R2_MULTIPART_PART_SIZE_BYTES', String(5 * 1024 * 1024));
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      initR2Upload,
      apiRequest(`${videosUrl(scenario.project.id)}/r2-init`, {
        body: {
          fileName: 'clip.mp4',
          sizeBytes: String(12 * 1024 * 1024),
          contentType: 'video/mp4',
        },
      }),
      { projectId: scenario.project.id }
    );
    const payload = await readData<{
      presignedPutUrl: string;
      multipart: { uploadId: string; partSizeBytes: number; parts: Array<{ partNumber: number }> };
    }>(response);

    expect(response.status).toBe(200);
    expect(payload.presignedPutUrl).toBe('');
    expect(payload.multipart.uploadId).toBe('test-multipart-upload-id');
    expect(payload.multipart.partSizeBytes).toBe(5 * 1024 * 1024);
    expect(payload.multipart.parts.map((part) => part.partNumber)).toEqual([1, 2, 3]);
    expect((await db.videoUploadSession.findFirstOrThrow()).multipartUploadId).toBe(
      'test-multipart-upload-id'
    );
  });

  it('refuses a completion presenting a forged upload token', async () => {
    enableS3VideoUploads();
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      completeR2Upload,
      apiRequest(`${videosUrl(scenario.project.id)}/r2-complete`, {
        body: {
          objectKey: 'videos/11111111-1111-4111-8111-111111111111.mp4',
          uploadToken: 'forged.token',
          parts: [{ partNumber: 1, etag: 'etag-1' }],
        },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
  });

  it('refuses a completion whose parts list is malformed', async () => {
    enableS3VideoUploads();
    vi.stubEnv('OPENFRAME_R2_MULTIPART_THRESHOLD_BYTES', '1024');
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const init = await readData<{ objectKey: string; uploadToken: string }>(
      await callRoute(
        initR2Upload,
        apiRequest(`${videosUrl(scenario.project.id)}/r2-init`, {
          body: {
            fileName: 'clip.mp4',
            sizeBytes: String(6 * 1024 * 1024),
            contentType: 'video/mp4',
          },
        }),
        { projectId: scenario.project.id }
      )
    );

    for (const parts of [
      [],
      [{ partNumber: 0, etag: 'x' }],
      [{ partNumber: 1, etag: '' }],
      'nope',
    ]) {
      const response = await callRoute(
        completeR2Upload,
        apiRequest(`${videosUrl(scenario.project.id)}/r2-complete`, {
          body: { objectKey: init.objectKey, uploadToken: init.uploadToken, parts },
        }),
        { projectId: scenario.project.id }
      );
      expect(response.status).toBe(400);
    }

    // The session must survive a rejected completion attempt.
    expect((await db.videoUploadSession.findFirstOrThrow()).status).toBe('INITIATED');
  });

  it('completes a multipart upload and leaves the session open for finalisation', async () => {
    enableS3VideoUploads();
    vi.stubEnv('OPENFRAME_R2_MULTIPART_THRESHOLD_BYTES', '1024');
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const init = await readData<{ objectKey: string; uploadToken: string; proxyUrl: string }>(
      await callRoute(
        initR2Upload,
        apiRequest(`${videosUrl(scenario.project.id)}/r2-init`, {
          body: {
            fileName: 'clip.mp4',
            sizeBytes: String(6 * 1024 * 1024),
            contentType: 'video/mp4',
          },
        }),
        { projectId: scenario.project.id }
      )
    );

    const response = await callRoute(
      completeR2Upload,
      apiRequest(`${videosUrl(scenario.project.id)}/r2-complete`, {
        body: {
          objectKey: init.objectKey,
          uploadToken: init.uploadToken,
          parts: [{ partNumber: 1, etag: 'etag-1' }],
        },
      }),
      { projectId: scenario.project.id }
    );
    const payload = await readData<{ objectKey: string; proxyUrl: string }>(response);

    expect(response.status).toBe(200);
    expect(payload.objectKey).toBe(init.objectKey);
    expect(payload.proxyUrl).toBe(init.proxyUrl);
    // r2-complete only assembles the object. POST /videos is what consumes the
    // session and creates the row.
    expect((await db.videoUploadSession.findFirstOrThrow()).status).toBe('INITIATED');
  });

  it('cancels a pending upload and releases the reservation', async () => {
    enableS3VideoUploads();
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const init = await readData<{ objectKey: string; uploadToken: string }>(
      await callRoute(
        initR2Upload,
        apiRequest(`${videosUrl(scenario.project.id)}/r2-init`, {
          body: { fileName: 'clip.mp4', sizeBytes: '2048', contentType: 'video/mp4' },
        }),
        { projectId: scenario.project.id }
      )
    );
    expect(await db.uploadReservation.count()).toBe(1);

    const response = await callRoute(
      cancelR2Upload,
      apiRequest(`${videosUrl(scenario.project.id)}/r2-init`, {
        method: 'DELETE',
        body: { objectKey: init.objectKey, uploadToken: init.uploadToken },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);
    const session = await db.videoUploadSession.findFirstOrThrow();
    expect(session.status).toBe('CANCELLED');
    expect(session.consumedAt).toBeInstanceOf(Date);
    // Leaving the reservation behind would eat the user's quota for the TTL.
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('refuses to cancel the same session twice', async () => {
    enableS3VideoUploads();
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const init = await readData<{ objectKey: string; uploadToken: string }>(
      await callRoute(
        initR2Upload,
        apiRequest(`${videosUrl(scenario.project.id)}/r2-init`, {
          body: { fileName: 'clip.mp4', sizeBytes: '2048', contentType: 'video/mp4' },
        }),
        { projectId: scenario.project.id }
      )
    );

    const first = await callRoute(
      cancelR2Upload,
      apiRequest(`${videosUrl(scenario.project.id)}/r2-init`, {
        method: 'DELETE',
        body: { objectKey: init.objectKey, uploadToken: init.uploadToken },
      }),
      { projectId: scenario.project.id }
    );
    const second = await callRoute(
      cancelR2Upload,
      apiRequest(`${videosUrl(scenario.project.id)}/r2-init`, {
        method: 'DELETE',
        body: { objectKey: init.objectKey, uploadToken: init.uploadToken },
      }),
      { projectId: scenario.project.id }
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
  });

  // The session is keyed on the user who started it, so another admin of the
  // same project cannot consume or cancel someone else's upload token.
  it('refuses a cancellation from a different user holding the same token', async () => {
    enableS3VideoUploads();
    const scenario = await seedProject();
    const otherAdmin = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: otherAdmin.id,
      role: 'ADMIN',
    });
    signedInAs(scenario.owner);

    const init = await readData<{ objectKey: string; uploadToken: string }>(
      await callRoute(
        initR2Upload,
        apiRequest(`${videosUrl(scenario.project.id)}/r2-init`, {
          body: { fileName: 'clip.mp4', sizeBytes: '2048', contentType: 'video/mp4' },
        }),
        { projectId: scenario.project.id }
      )
    );

    signedInAs(otherAdmin);
    const response = await callRoute(
      cancelR2Upload,
      apiRequest(`${videosUrl(scenario.project.id)}/r2-init`, {
        method: 'DELETE',
        body: { objectKey: init.objectKey, uploadToken: init.uploadToken },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect((await db.videoUploadSession.findFirstOrThrow()).status).toBe('INITIATED');
  });
});
