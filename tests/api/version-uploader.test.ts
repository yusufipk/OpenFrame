// Every way a version gets created records who created it, separately from the
// workspace owner whose storage and bill it lands on. The uploader in each test
// is a workspace ADMIN who is not the owner, because an upload by the owner would
// pass whether the route recorded the caller or the owner.

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { POST as addVideo } from '@/app/api/projects/[projectId]/videos/route';
import { POST as addVersion } from '@/app/api/projects/[projectId]/videos/[videoId]/versions/route';
import { POST as uploadImageReview } from '@/app/api/projects/[projectId]/videos/images/route';
import { getScoreboard } from '@/lib/analytics/scoreboard';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { addWorkspaceMember, createUser, seedProject, seedVersion } from '../factories';

const { r2Send } = vi.hoisted(() => ({ r2Send: vi.fn() }));
vi.mock('@/lib/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/r2')>();
  return { ...actual, r2Client: { send: r2Send } };
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
);

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

beforeEach(() => {
  vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'test-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test-secret');
  vi.stubEnv('R2_BUCKET_NAME', 'test-bucket');
  vi.stubEnv('R2_ENDPOINT', 'http://minio-test:9000');
  r2Send.mockReset();
  r2Send.mockResolvedValue({});
});

afterEach(() => vi.unstubAllEnvs());

async function addEditor(workspaceId: string, subscriptionStatus?: 'ACTIVE') {
  const editor = await createUser(subscriptionStatus ? { subscriptionStatus } : undefined);
  await addWorkspaceMember({ workspaceId, userId: editor.id, role: 'ADMIN' });
  return editor;
}

function newVideoRequest(projectId: string, headers?: Record<string, string>) {
  return apiRequest(`/api/projects/${projectId}/videos`, {
    headers,
    body: { title: 'Editor cut', videoUrl: YOUTUBE_URL, videoId: 'dQw4w9WgXcQ' },
  });
}

describe('version uploader', () => {
  it('records the team member who adds a video, and keeps the event on the owner', async () => {
    const { owner, workspace, project } = await seedProject();
    const editor = await addEditor(workspace.id);
    signedInAs(editor);

    const response = await callRoute(addVideo, newVideoRequest(project.id), {
      projectId: project.id,
    });

    expect(response.status).toBe(201);
    const version = await db.videoVersion.findFirstOrThrow({
      where: { video: { projectId: project.id } },
    });
    expect(version.uploadedById).toBe(editor.id);

    const event = await db.analyticsEvent.findFirstOrThrow({ where: { name: 'VIDEO_ADDED' } });
    expect(event.userId).toBe(owner.id);
    expect(event.actorId).toBe(editor.id);
  });

  it('records the team member who adds a new version to an existing video', async () => {
    const { workspace, project, video, version: existing } = await seedVersion();
    const editor = await addEditor(workspace.id);
    signedInAs(editor);

    const response = await callRoute(
      addVersion,
      apiRequest(`/api/projects/${project.id}/videos/${video.id}/versions`, {
        body: { videoUrl: YOUTUBE_URL, versionLabel: 'v2' },
      }),
      { projectId: project.id, videoId: video.id }
    );

    expect(response.status).toBe(201);
    const created = await readData<{ id: string }>(response);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: created.id } })).uploadedById
    ).toBe(editor.id);
    // A row written before uploaders were recorded is left as it was.
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: existing.id } })).uploadedById
    ).toBeNull();
  });

  it('records the team members who upload an image review and its next version', async () => {
    const { owner, workspace, project } = await seedProject();
    const editor = await addEditor(workspace.id);
    const retoucher = await addEditor(workspace.id);
    signedInAs(editor);

    const imageRequest = (fields: Record<string, string>) => {
      const form = new FormData();
      form.set('file', new File([PNG], 'review.png', { type: 'image/png' }));
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      return apiRequest(`/api/projects/${project.id}/videos/images`, { rawBody: form });
    };

    const first = await callRoute(uploadImageReview, imageRequest({ title: 'Still' }), {
      projectId: project.id,
    });
    expect(first.status).toBe(201);
    const { id: imageId } = await readData<{ id: string }>(first);

    signedInAs(retoucher);
    const second = await callRoute(
      uploadImageReview,
      imageRequest({ targetVideoId: imageId, versionLabel: 'Retouch' }),
      { projectId: project.id }
    );
    expect(second.status).toBe(201);

    const versions = await db.videoVersion.findMany({
      where: { videoParentId: imageId },
      orderBy: { versionNumber: 'asc' },
      select: { uploadedById: true },
    });
    expect(versions.map((row) => row.uploadedById)).toEqual([editor.id, retoucher.id]);

    // Only a new image is a VIDEO_ADDED; the follow-up version is not.
    const events = await db.analyticsEvent.findMany({ where: { name: 'VIDEO_ADDED' } });
    expect(events.map(({ userId, actorId }) => ({ userId, actorId }))).toEqual([
      { userId: owner.id, actorId: editor.id },
    ]);
  });

  it('credits an upload made with a personal API token to the token owner', async () => {
    const { workspace, project } = await seedProject();
    const editor = await addEditor(workspace.id);
    const token = `of_pat_${'u'.repeat(43)}`;
    await db.apiToken.create({
      data: {
        userId: editor.id,
        name: 'Script',
        tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
        prefix: token.slice(0, 13),
        scopes: ['read', 'upload'],
      },
    });
    signedOut();

    const response = await callRoute(
      addVideo,
      newVideoRequest(project.id, { authorization: `Bearer ${token}` }),
      { projectId: project.id }
    );

    expect(response.status).toBe(201);
    const version = await db.videoVersion.findFirstOrThrow({
      where: { video: { projectId: project.id } },
    });
    expect(version.uploadedById).toBe(editor.id);
  });

  // A regression guard rather than coverage of the new column: the scoreboard
  // counts value events per account, and moving VIDEO_ADDED onto the uploader
  // would make a paying owner whose editors do the uploading look idle.
  it('keeps a team upload counting toward the paying owner on the scoreboard', async () => {
    const { owner, workspace, project } = await seedProject({
      owner: { subscriptionStatus: 'ACTIVE' },
    });
    const editor = await addEditor(workspace.id, 'ACTIVE');
    signedInAs(editor);

    const response = await callRoute(addVideo, newVideoRequest(project.id), {
      projectId: project.id,
    });
    expect(response.status).toBe(201);

    const scoreboard = await getScoreboard({ weeks: 1 });
    const rowFor = (userId: string) => scoreboard.paidAccounts.find((row) => row.userId === userId);
    expect(rowFor(owner.id)?.valueEvents7).toBe(1);
    expect(rowFor(editor.id)?.valueEvents7).toBe(0);
  });
});
