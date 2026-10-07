import { describe, expect, it, vi } from 'vitest';
import { POST as recordOpen } from '@/app/api/watch/[videoId]/open/route';
import {
  GET as getShare,
  PATCH as patchShare,
  POST as regenerateShare,
} from '@/app/api/projects/[projectId]/videos/[videoId]/share/route';
import { db } from '@/lib/db';
import * as shareLinks from '@/lib/share-links';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createExpiredUser,
  createShareLink,
  createUser,
  seedVersion,
} from '../factories';

const origin = 'http://localhost:3000';

function openRequest(videoId: string, token?: string, passwordVerified = false) {
  return apiRequest(`/api/watch/${videoId}/open`, {
    method: 'POST',
    headers: { origin },
    cookies: token
      ? {
          [getShareSessionCookieName(videoId)]: createShareSessionValue(
            token,
            videoId,
            passwordVerified
          ),
        }
      : {},
  });
}

async function seedLink() {
  const scenario = await seedVersion({ visibility: 'PRIVATE' });
  const link = await createShareLink({
    projectId: scenario.project.id,
    videoId: scenario.video.id,
    permission: 'COMMENT',
  });
  return { ...scenario, link };
}

async function expectNoOpens(id: string) {
  expect(await db.shareLink.findUniqueOrThrow({ where: { id } })).toMatchObject({
    firstOpenedAt: null,
    lastOpenedAt: null,
  });
}

describe('share link page opens', () => {
  it('requires a share session even when a user is signed in', async () => {
    const { video, link } = await seedLink();
    signedOut();
    expect((await callRoute(recordOpen, openRequest(video.id), { videoId: video.id })).status).toBe(
      401
    );
    signedInAs(await createUser());
    expect((await callRoute(recordOpen, openRequest(video.id), { videoId: video.id })).status).toBe(
      401
    );
    await expectNoOpens(link.id);
  });

  it('records an anonymous open and preserves the first time on later opens', async () => {
    const { video, link } = await seedLink();
    signedOut();
    const response = await callRoute(recordOpen, openRequest(video.id, link.token), {
      videoId: video.id,
    });
    expect(response.status).toBe(200);
    expect(await readData(response)).toEqual({ recorded: true });
    const stored = await db.shareLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(stored.firstOpenedAt).toBeInstanceOf(Date);
    expect(stored.lastOpenedAt).toEqual(stored.firstOpenedAt);

    const earlier = new Date('2026-01-01T00:00:00.000Z');
    await db.shareLink.update({
      where: { id: link.id },
      data: { firstOpenedAt: earlier, lastOpenedAt: earlier },
    });
    expect(
      (await callRoute(recordOpen, openRequest(video.id, link.token), { videoId: video.id })).status
    ).toBe(200);
    const reopened = await db.shareLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(reopened.firstOpenedAt).toEqual(earlier);
    expect(reopened.lastOpenedAt!.getTime()).toBeGreaterThan(earlier.getTime());
  });

  it('records a signed-in reviewer but excludes owner and editor previews', async () => {
    const { owner, project, video, link } = await seedLink();
    const editor = await createUser();
    await addProjectMember({ projectId: project.id, userId: editor.id, role: 'ADMIN' });
    for (const user of [owner, editor]) {
      signedInAs(user);
      const response = await callRoute(recordOpen, openRequest(video.id, link.token), {
        videoId: video.id,
      });
      expect(response.status).toBe(200);
      expect(await readData(response)).toEqual({ recorded: false });
      await expectNoOpens(link.id);
    }
    const reviewer = await createUser();
    await addProjectMember({ projectId: project.id, userId: reviewer.id, role: 'COMMENTATOR' });
    signedInAs(reviewer);
    expect(
      (await callRoute(recordOpen, openRequest(video.id, link.token), { videoId: video.id })).status
    ).toBe(200);
    expect(
      (await db.shareLink.findUniqueOrThrow({ where: { id: link.id } })).firstOpenedAt
    ).toBeInstanceOf(Date);
  });

  it.each([undefined, 'https://other.example'])(
    'rejects an untrusted origin %s without recording',
    async (requestOrigin) => {
      const { video, link } = await seedLink();
      signedOut();
      const request = openRequest(video.id, link.token);
      if (requestOrigin) request.headers.set('origin', requestOrigin);
      else request.headers.delete('origin');
      expect((await callRoute(recordOpen, request, { videoId: video.id })).status).toBe(403);
      await expectNoOpens(link.id);
    }
  );

  it('rejects forged and expired cookies without recording', async () => {
    const { video, link } = await seedLink();
    signedOut();
    for (const value of ['forged', createShareSessionValue(link.token, video.id, false, -10)]) {
      const request = apiRequest(`/api/watch/${video.id}/open`, {
        method: 'POST',
        headers: { origin },
        cookies: { [getShareSessionCookieName(video.id)]: value },
      });
      expect((await callRoute(recordOpen, request, { videoId: video.id })).status).toBe(401);
      await expectNoOpens(link.id);
    }
  });

  it('rejects another video token and a project-wide token without changing either link', async () => {
    const { project, video, link } = await seedLink();
    const other = await seedLink();
    const projectLink = await createShareLink({ projectId: project.id });
    signedOut();
    for (const invalid of [other.link, projectLink]) {
      expect(
        (await callRoute(recordOpen, openRequest(video.id, invalid.token), { videoId: video.id }))
          .status
      ).toBe(403);
      await expectNoOpens(invalid.id);
    }
    await expectNoOpens(link.id);
  });

  it('rejects expired, rotated and revoked links', async () => {
    const { video, link } = await seedLink();
    signedOut();
    await db.shareLink.update({ where: { id: link.id }, data: { expiresAt: new Date(0) } });
    expect(
      (await callRoute(recordOpen, openRequest(video.id, link.token), { videoId: video.id })).status
    ).toBe(403);
    await expectNoOpens(link.id);
    await db.shareLink.update({
      where: { id: link.id },
      data: { token: 'rotated-token', expiresAt: null },
    });
    expect(
      (await callRoute(recordOpen, openRequest(video.id, link.token), { videoId: video.id })).status
    ).toBe(403);
    await expectNoOpens(link.id);
    await db.shareLink.delete({ where: { id: link.id } });
    expect(
      (await callRoute(recordOpen, openRequest(video.id, 'rotated-token'), { videoId: video.id }))
        .status
    ).toBe(403);
    expect(await db.shareLink.count()).toBe(0);
  });

  it('does not record a link rotated after validation but before the write', async () => {
    const { video, link } = await seedLink();
    signedOut();
    const validate = shareLinks.validateShareLinkAccess;
    vi.spyOn(shareLinks, 'validateShareLinkAccess').mockImplementationOnce(async (input) => {
      const access = await validate(input);
      expect(access.hasAccess).toBe(true);
      await db.shareLink.update({ where: { id: link.id }, data: { token: 'rotated-in-flight' } });
      return access;
    });
    const response = await callRoute(recordOpen, openRequest(video.id, link.token), {
      videoId: video.id,
    });
    expect(response.status).toBe(403);
    expect((await db.shareLink.findUniqueOrThrow({ where: { id: link.id } })).token).toBe(
      'rotated-in-flight'
    );
    await expectNoOpens(link.id);
  });

  it('requires password verification and records only after the link is unlocked', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      password: 'secret',
    });
    signedOut();
    expect(
      (
        await callRoute(recordOpen, openRequest(scenario.video.id, link.token), {
          videoId: scenario.video.id,
        })
      ).status
    ).toBe(403);
    await expectNoOpens(link.id);
    expect(
      (
        await callRoute(recordOpen, openRequest(scenario.video.id, link.token, true), {
          videoId: scenario.video.id,
        })
      ).status
    ).toBe(200);
    expect(
      (await db.shareLink.findUniqueOrThrow({ where: { id: link.id } })).firstOpenedAt
    ).toBeInstanceOf(Date);
  });

  it('does not record after billing access ends', async () => {
    const scenario = await seedVersion({
      visibility: 'PRIVATE',
      ownerUser: await createExpiredUser(),
    });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
    });
    signedOut();
    expect(
      (
        await callRoute(recordOpen, openRequest(scenario.video.id, link.token), {
          videoId: scenario.video.id,
        })
      ).status
    ).toBe(403);
    await expectNoOpens(link.id);
  });

  it('stores an ordered first and last time under concurrent initial opens', async () => {
    const { video, link } = await seedLink();
    signedOut();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        callRoute(recordOpen, openRequest(video.id, link.token), { videoId: video.id })
      )
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    const stored = await db.shareLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(stored.firstOpenedAt).toBeInstanceOf(Date);
    expect(stored.lastOpenedAt!.getTime()).toBeGreaterThanOrEqual(stored.firstOpenedAt!.getTime());
  });
});

describe('share link activity management', () => {
  it('exposes activity only to editors and resets it when the token is regenerated', async () => {
    const { owner, project, video, link } = await seedLink();
    const openedAt = new Date('2026-01-01T00:00:00.000Z');
    await db.shareLink.update({
      where: { id: link.id },
      data: { firstOpenedAt: openedAt, lastOpenedAt: openedAt },
    });
    const path = `/api/projects/${project.id}/videos/${video.id}/share`;
    const params = { projectId: project.id, videoId: video.id };
    signedOut();
    expect((await callRoute(getShare, apiRequest(path), params)).status).toBe(401);
    const reviewer = await createUser();
    await addProjectMember({ projectId: project.id, userId: reviewer.id, role: 'COMMENTATOR' });
    signedInAs(reviewer);
    expect((await callRoute(getShare, apiRequest(path), params)).status).toBe(403);
    expect(await db.shareLink.findUniqueOrThrow({ where: { id: link.id } })).toMatchObject({
      firstOpenedAt: openedAt,
      lastOpenedAt: openedAt,
    });
    signedInAs(owner);
    const payload = await readData<{ link: { firstOpenedAt: string; lastOpenedAt: string } }>(
      await callRoute(getShare, apiRequest(path), params)
    );
    expect(payload.link).toMatchObject({
      firstOpenedAt: openedAt.toISOString(),
      lastOpenedAt: openedAt.toISOString(),
    });
    const response = await callRoute(regenerateShare, apiRequest(path, { body: {} }), params);
    expect(response.status).toBe(200);
    expect(await readData(response)).toMatchObject({
      link: { firstOpenedAt: null, lastOpenedAt: null },
    });
    await expectNoOpens(link.id);
    expect((await db.shareLink.findUniqueOrThrow({ where: { id: link.id } })).token).not.toBe(
      link.token
    );
  });

  it('preserves activity for download changes and resets it for password rotation', async () => {
    const { owner, project, video, link } = await seedLink();
    const openedAt = new Date('2026-01-01T00:00:00.000Z');
    await db.shareLink.update({
      where: { id: link.id },
      data: { firstOpenedAt: openedAt, lastOpenedAt: openedAt },
    });
    signedInAs(owner);
    const path = `/api/projects/${project.id}/videos/${video.id}/share`;
    const params = { projectId: project.id, videoId: video.id };
    expect(
      (
        await callRoute(
          patchShare,
          apiRequest(path, { method: 'PATCH', body: { allowDownloads: true } }),
          params
        )
      ).status
    ).toBe(200);
    expect(await db.shareLink.findUniqueOrThrow({ where: { id: link.id } })).toMatchObject({
      token: link.token,
      firstOpenedAt: openedAt,
      lastOpenedAt: openedAt,
    });
    const response = await callRoute(
      patchShare,
      apiRequest(path, { method: 'PATCH', body: { password: 'new-secret' } }),
      params
    );
    expect(response.status).toBe(200);
    expect(await readData(response)).toMatchObject({
      link: { firstOpenedAt: null, lastOpenedAt: null },
    });
    await expectNoOpens(link.id);
  });
});
