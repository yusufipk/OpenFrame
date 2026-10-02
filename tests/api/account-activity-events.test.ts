// Everyday use of a paying account has to reach the scoreboard's silence check.
//
// Each scenario starts from an account whose last value event was a month ago,
// so it is on the at-risk list, and asserts that one action moves its last value
// event to today and takes it off the list. The list is what growth.py prints as
// the silent payers, read straight from /api/admin/growth.

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { db } from '@/lib/db';
import { getScoreboard } from '@/lib/analytics/scoreboard';
import { POST as addVersion } from '@/app/api/projects/[projectId]/videos/[videoId]/versions/route';
import { POST as uploadImageReview } from '@/app/api/projects/[projectId]/videos/images/route';
import { POST as createComment } from '@/app/api/versions/[versionId]/comments/route';
import { POST as requestApproval } from '@/app/api/versions/[versionId]/approvals/route';
import { POST as liveReview } from '@/app/api/videos/[videoId]/live-review/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import {
  addWorkspaceMember,
  createShareLink,
  createUser,
  seedProject,
  seedVersion,
} from '../factories';

const { r2Send } = vi.hoisted(() => ({ r2Send: vi.fn() }));
vi.mock('@/lib/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/r2')>();
  return { ...actual, r2Client: { send: r2Send } };
});

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
);

beforeEach(() => {
  vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_LIVE_REVIEW', 'true');
  vi.stubEnv('LIVE_REVIEW_SECRET', 'test-live-secret');
  vi.stubEnv('LIVE_REVIEW_INTERNAL_URL', 'http://live-review:3101');
  vi.stubEnv('LIVE_REVIEW_PUBLIC_URL', 'ws://localhost:3101/ws');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'test-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test-secret');
  vi.stubEnv('R2_BUCKET_NAME', 'test-bucket');
  vi.stubEnv('R2_ENDPOINT', 'http://minio-test:9000');
  r2Send.mockReset();
  r2Send.mockResolvedValue({});
  // The live review health check calls out to the realtime service.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 }))
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

/** A paying owner whose only value event is a month old, so the scoreboard calls it silent. */
async function silentPayingVersion(providerId?: string) {
  const scenario = await seedVersion({
    owner: { subscriptionStatus: 'ACTIVE' },
    ...(providerId ? { providerId } : {}),
  });
  await db.analyticsEvent.create({
    data: {
      name: 'VIDEO_ADDED',
      dedupeKey: `VIDEO_ADDED:old-${scenario.owner.id}`,
      userId: scenario.owner.id,
      occurredAt: daysAgo(30),
    },
  });
  return scenario;
}

async function accountRow(userId: string) {
  const scoreboard = await getScoreboard({ weeks: 1 });
  return {
    row: scoreboard.paidAccounts.find((account) => account.userId === userId),
    atRisk: scoreboard.atRisk.some((account) => account.userId === userId),
    week: scoreboard.weeks[scoreboard.weeks.length - 1]!,
  };
}

function isToday(date: Date | null | undefined): boolean {
  return (
    Boolean(date) && date!.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)
  );
}

async function addEditor(workspaceId: string) {
  const editor = await createUser();
  await addWorkspaceMember({ workspaceId, userId: editor.id, role: 'ADMIN' });
  return editor;
}

async function apiTokenFor(user: User) {
  const token = `of_pat_${'a'.repeat(43)}`;
  await db.apiToken.create({
    data: {
      userId: user.id,
      name: 'Pipeline',
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      prefix: token.slice(0, 13),
      scopes: ['read', 'upload'],
    },
  });
  return token;
}

function versionRequest(projectId: string, videoId: string, headers?: Record<string, string>) {
  return apiRequest(`/api/projects/${projectId}/videos/${videoId}/versions`, {
    headers,
    body: { videoUrl: YOUTUBE_URL, versionLabel: 'Next cut' },
  });
}

describe('account activity events', () => {
  it('takes the owner off the silent list when they push a version with an API token', async () => {
    const { owner, project, video } = await silentPayingVersion();
    expect((await accountRow(owner.id)).atRisk).toBe(true);
    const token = await apiTokenFor(owner);
    signedOut();

    const response = await callRoute(
      addVersion,
      versionRequest(project.id, video.id, { authorization: `Bearer ${token}` }),
      { projectId: project.id, videoId: video.id }
    );

    expect(response.status).toBe(201);
    const event = await db.analyticsEvent.findFirstOrThrow({ where: { name: 'VERSION_ADDED' } });
    expect(event).toMatchObject({ userId: owner.id, actorId: owner.id });
    const { row, atRisk } = await accountRow(owner.id);
    expect(isToday(row?.lastValueEventAt)).toBe(true);
    expect(atRisk).toBe(false);
  });

  it('records a version once per account per day, however many are pushed', async () => {
    const { owner, workspace, project, video } = await silentPayingVersion();
    const editor = await addEditor(workspace.id);

    signedInAs(owner);
    for (let push = 0; push < 2; push += 1) {
      const response = await callRoute(addVersion, versionRequest(project.id, video.id), {
        projectId: project.id,
        videoId: video.id,
      });
      expect(response.status).toBe(201);
    }
    signedInAs(editor);
    const third = await callRoute(addVersion, versionRequest(project.id, video.id), {
      projectId: project.id,
      videoId: video.id,
    });
    expect(third.status).toBe(201);

    const events = await db.analyticsEvent.findMany({ where: { name: 'VERSION_ADDED' } });
    // The first actor of the day is the one kept. The key has to name the day: a
    // key per account alone would keep one row forever, and the account would go
    // silent two weeks after its first version however much it uploaded.
    expect(
      events.map(({ userId, actorId, dedupeKey }) => ({ userId, actorId, dedupeKey }))
    ).toEqual([
      {
        userId: owner.id,
        actorId: owner.id,
        dedupeKey: `VERSION_ADDED:${owner.id}:${new Date().toISOString().slice(0, 10)}`,
      },
    ]);
  });

  it('credits the workspace owner when the project owner is someone else', async () => {
    const { owner, project, video } = await silentPayingVersion();
    const formerOwner = await createUser();
    await db.project.update({ where: { id: project.id }, data: { ownerId: formerOwner.id } });
    signedInAs(owner);

    const response = await callRoute(addVersion, versionRequest(project.id, video.id), {
      projectId: project.id,
      videoId: video.id,
    });

    expect(response.status).toBe(201);
    const event = await db.analyticsEvent.findFirstOrThrow({ where: { name: 'VERSION_ADDED' } });
    expect(event.userId).toBe(owner.id);
  });

  it('records nothing when a stranger is refused a version, a comment or an approval', async () => {
    const { owner, project, video, version } = await silentPayingVersion();
    signedInAs(await createUser());

    const responses = [
      await callRoute(addVersion, versionRequest(project.id, video.id), {
        projectId: project.id,
        videoId: video.id,
      }),
      await callRoute(
        createComment,
        apiRequest(`/api/versions/${version.id}/comments`, {
          body: { content: 'drive-by', timestamp: 1 },
        }),
        { versionId: version.id }
      ),
      await callRoute(
        requestApproval,
        apiRequest(`/api/versions/${version.id}/approvals`, {
          body: { approverIds: [owner.id] },
        }),
        { versionId: version.id }
      ),
    ];

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
    expect(await db.videoVersion.count({ where: { videoParentId: video.id } })).toBe(1);
    expect(await db.comment.count()).toBe(0);
    expect(await db.approvalRequest.count()).toBe(0);
    // Only the month-old seed row is left.
    expect(await db.analyticsEvent.count()).toBe(1);
    expect((await accountRow(owner.id)).atRisk).toBe(true);
  });

  it('credits a version a team member adds to the paying owner, not to the member', async () => {
    const { owner, workspace, project, video } = await silentPayingVersion();
    const editor = await addEditor(workspace.id);
    signedInAs(editor);

    const response = await callRoute(addVersion, versionRequest(project.id, video.id), {
      projectId: project.id,
      videoId: video.id,
    });

    expect(response.status).toBe(201);
    const event = await db.analyticsEvent.findFirstOrThrow({ where: { name: 'VERSION_ADDED' } });
    expect(event).toMatchObject({ userId: owner.id, actorId: editor.id });
    expect((await accountRow(owner.id)).atRisk).toBe(false);
  });

  it('records a new image version as VERSION_ADDED and a new image as VIDEO_ADDED', async () => {
    const { owner, workspace, project } = await seedProject({
      owner: { subscriptionStatus: 'ACTIVE' },
    });
    const retoucher = await addEditor(workspace.id);
    signedInAs(owner);
    const imageRequest = (fields: Record<string, string>) => {
      const form = new FormData();
      form.set('file', new File([PNG], 'still.png', { type: 'image/png' }));
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      return apiRequest(`/api/projects/${project.id}/videos/images`, { rawBody: form });
    };

    const first = await callRoute(uploadImageReview, imageRequest({ title: 'Still' }), {
      projectId: project.id,
    });
    expect(first.status).toBe(201);
    expect(await db.analyticsEvent.count({ where: { name: 'VIDEO_ADDED' } })).toBe(1);
    expect(await db.analyticsEvent.count({ where: { name: 'VERSION_ADDED' } })).toBe(0);

    const { id: imageId } = await readData<{ id: string }>(first);
    signedInAs(retoucher);
    const second = await callRoute(
      uploadImageReview,
      imageRequest({ targetVideoId: imageId, versionLabel: 'Retouch' }),
      { projectId: project.id }
    );
    expect(second.status).toBe(201);

    const events = await db.analyticsEvent.findMany({ where: { name: 'VERSION_ADDED' } });
    expect(events.map(({ userId, actorId }) => ({ userId, actorId }))).toEqual([
      { userId: owner.id, actorId: retoucher.id },
    ]);
    expect(await db.analyticsEvent.count({ where: { name: 'VIDEO_ADDED' } })).toBe(1);
  });

  it("takes the owner off the silent list when a team member comments on the owner's video", async () => {
    const { owner, workspace, version } = await silentPayingVersion();
    const member = await addEditor(workspace.id);
    signedInAs(member);

    const response = await callRoute(
      createComment,
      apiRequest(`/api/versions/${version.id}/comments`, {
        body: { content: 'Trim the intro', timestamp: 3 },
      }),
      { versionId: version.id }
    );

    expect(response.status).toBe(201);
    const event = await db.analyticsEvent.findFirstOrThrow({ where: { name: 'COMMENT_ADDED' } });
    expect(event).toMatchObject({ userId: owner.id, actorId: member.id });
    const { row, atRisk } = await accountRow(owner.id);
    expect(isToday(row?.lastValueEventAt)).toBe(true);
    expect(atRisk).toBe(false);
    // A member's comment is not outside feedback; the funnel step must not move.
    expect(await db.analyticsEvent.count({ where: { name: 'FIRST_GUEST_COMMENT' } })).toBe(0);
  });

  it('credits a guest comment through a share link to the owner, with no actor', async () => {
    const { owner, project, video, version } = await silentPayingVersion();
    const link = await createShareLink({
      projectId: project.id,
      videoId: video.id,
      permission: 'COMMENT',
    });
    signedOut();

    const response = await callRoute(
      createComment,
      apiRequest(`/api/versions/${version.id}/comments`, {
        body: { content: 'Looks great', timestamp: 1, guestName: 'Client' },
        cookies: {
          [getShareSessionCookieName(video.id)]: createShareSessionValue(
            link.token,
            video.id,
            false
          ),
        },
      }),
      { versionId: version.id }
    );

    expect(response.status).toBe(201);
    const event = await db.analyticsEvent.findFirstOrThrow({ where: { name: 'COMMENT_ADDED' } });
    expect(event).toMatchObject({ userId: owner.id, actorId: null });
    expect((await accountRow(owner.id)).atRisk).toBe(false);
  });

  it('records one comment event per account per day', async () => {
    const { owner, version } = await silentPayingVersion();
    signedInAs(owner);

    for (const content of ['one', 'two', 'three']) {
      const response = await callRoute(
        createComment,
        apiRequest(`/api/versions/${version.id}/comments`, { body: { content, timestamp: 1 } }),
        { versionId: version.id }
      );
      expect(response.status).toBe(201);
    }

    expect(await db.comment.count()).toBe(3);
    expect(await db.analyticsEvent.count({ where: { name: 'COMMENT_ADDED' } })).toBe(1);
  });

  it('takes the owner off the silent list when a live review is started', async () => {
    const { owner, workspace, video, version } = await silentPayingVersion('r2');
    signedInAs(owner);

    const response = await callRoute(
      liveReview,
      apiRequest(`/api/videos/${video.id}/live-review`, {
        body: { action: 'start', versionId: version.id },
        headers: { origin: 'http://localhost:3000' },
      }),
      { videoId: video.id }
    );

    expect(response.status).toBe(200);
    const started = await db.analyticsEvent.findFirstOrThrow({
      where: { name: 'LIVE_REVIEW_STARTED' },
    });
    expect(started).toMatchObject({ userId: owner.id, actorId: owner.id });
    const { row, atRisk } = await accountRow(owner.id);
    expect(isToday(row?.lastValueEventAt)).toBe(true);
    expect(atRisk).toBe(false);

    const member = await addEditor(workspace.id);
    signedInAs(member);
    const joined = await callRoute(
      liveReview,
      apiRequest(`/api/videos/${video.id}/live-review`, {
        body: { action: 'join', versionId: version.id },
        headers: { origin: 'http://localhost:3000' },
      }),
      { videoId: video.id }
    );
    expect(joined.status).toBe(200);
    const joinEvent = await db.analyticsEvent.findFirstOrThrow({
      where: { name: 'LIVE_REVIEW_JOINED' },
    });
    expect(joinEvent).toMatchObject({ userId: owner.id, actorId: member.id });
  });

  it('takes the owner off the silent list when a member only joins a live review', async () => {
    const { owner, workspace, video, version } = await silentPayingVersion('r2');
    const liveRequest = (action: 'start' | 'join') =>
      apiRequest(`/api/videos/${video.id}/live-review`, {
        body: { action, versionId: version.id },
        headers: { origin: 'http://localhost:3000' },
      });
    // The room is opened while nothing is measured, so the join is the only event.
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'false');
    signedInAs(owner);
    expect((await callRoute(liveReview, liveRequest('start'), { videoId: video.id })).status).toBe(
      200
    );
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
    expect((await accountRow(owner.id)).atRisk).toBe(true);

    signedInAs(await createUser());
    expect((await callRoute(liveReview, liveRequest('join'), { videoId: video.id })).status).toBe(
      403
    );
    expect(await db.analyticsEvent.count({ where: { name: 'LIVE_REVIEW_JOINED' } })).toBe(0);

    const member = await addEditor(workspace.id);
    signedInAs(member);
    expect((await callRoute(liveReview, liveRequest('join'), { videoId: video.id })).status).toBe(
      200
    );

    expect(await db.analyticsEvent.count({ where: { name: 'LIVE_REVIEW_STARTED' } })).toBe(0);
    const joined = await db.analyticsEvent.findFirstOrThrow({
      where: { name: 'LIVE_REVIEW_JOINED' },
    });
    expect(joined).toMatchObject({ userId: owner.id, actorId: member.id });
    expect((await accountRow(owner.id)).atRisk).toBe(false);
  });

  it('records nothing for a live review start the route refuses', async () => {
    const { video, version } = await silentPayingVersion('r2');
    signedInAs(await createUser());

    const response = await callRoute(
      liveReview,
      apiRequest(`/api/videos/${video.id}/live-review`, {
        body: { action: 'start', versionId: version.id },
        headers: { origin: 'http://localhost:3000' },
      }),
      { videoId: video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.analyticsEvent.count({ where: { name: 'LIVE_REVIEW_STARTED' } })).toBe(0);
  });

  it('takes the owner off the silent list when an approval is requested', async () => {
    const { owner, workspace, version } = await silentPayingVersion();
    const editor = await addEditor(workspace.id);
    signedInAs(editor);

    const response = await callRoute(
      requestApproval,
      apiRequest(`/api/versions/${version.id}/approvals`, {
        body: { approverIds: [owner.id] },
      }),
      { versionId: version.id }
    );

    expect(response.status).toBe(201);
    const event = await db.analyticsEvent.findFirstOrThrow({
      where: { name: 'APPROVAL_REQUESTED' },
    });
    expect(event).toMatchObject({ userId: owner.id, actorId: editor.id });
    expect((await accountRow(owner.id)).atRisk).toBe(false);
  });

  it('leaves the weekly funnel exactly as it was', async () => {
    const { owner } = await silentPayingVersion();
    // Written by hand rather than through the routes, so every new name is
    // covered and none of them drags a funnel event in alongside it.
    const names = [
      'VERSION_ADDED',
      'COMMENT_ADDED',
      'LIVE_REVIEW_STARTED',
      'LIVE_REVIEW_JOINED',
      'APPROVAL_REQUESTED',
    ] as const;
    await db.analyticsEvent.createMany({
      data: names.map((name) => ({
        name,
        dedupeKey: `${name}:funnel-${owner.id}`,
        userId: owner.id,
        actorId: owner.id,
      })),
    });

    const { week, row } = await accountRow(owner.id);
    expect(row?.valueEvents7).toBe(5);
    expect(week).toMatchObject({
      visitors: 0,
      ctaClicks: 0,
      signupStarted: 0,
      emailVerified: 0,
      canceled: 0,
      firstVideo: 0,
      shareLinks: 0,
      externalFeedback: 0,
      signups: 0,
      trials: 0,
      newPaid: 0,
    });
  });

  it('writes nothing when analytics is off', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'false');
    const { owner, project, video } = await seedVersion();
    signedInAs(owner);

    const response = await callRoute(addVersion, versionRequest(project.id, video.id), {
      projectId: project.id,
      videoId: video.id,
    });

    expect(response.status).toBe(201);
    expect(await db.analyticsEvent.count()).toBe(0);
  });
});
