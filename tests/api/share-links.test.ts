import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import {
  DELETE as revokeShare,
  GET as getShare,
  PATCH as patchShare,
  POST as createShare,
} from '@/app/api/projects/[projectId]/videos/[videoId]/share/route';
import { GET as watchVideo } from '@/app/api/watch/[videoId]/route';
import {
  GET as listComments,
  POST as postComment,
} from '@/app/api/versions/[versionId]/comments/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createExpiredUser,
  createProject,
  createShareLink,
  createUser,
  createVersion,
  createVideo,
  createWorkspace,
  seedVersion,
} from '../factories';

interface SharePayload {
  link: {
    id: string;
    token: string;
    permission: string;
    allowGuests: boolean;
    allowDownloads: boolean;
    hasPassword: boolean;
    expiresAt: string | null;
  } | null;
  shareUrl: string | null;
}

function shareUrl(projectId: string, videoId: string): string {
  return `/api/projects/${projectId}/videos/${videoId}/share`;
}

function shareCookie(videoId: string, token: string, passwordVerified = false) {
  return {
    [getShareSessionCookieName(videoId)]: createShareSessionValue(token, videoId, passwordVerified),
  };
}

function expectShortVideoUrl(payload: SharePayload, token: string) {
  expect(payload.link?.token).toBe(token);
  expect(payload.shareUrl).not.toBeNull();
  const url = new URL(payload.shareUrl!);
  expect(url.pathname).toBe(`/s/${token}`);
  expect(url.search).toBe('');
}

describe('share link management', () => {
  it.each([
    ['GET', getShare],
    ['POST', createShare],
    ['PATCH', patchShare],
    ['DELETE', revokeShare],
  ] as const)('returns 401 for %s without a session', async (method, handler) => {
    const scenario = await seedVersion();
    signedOut();

    const response = await callRoute(
      handler,
      apiRequest(shareUrl(scenario.project.id, scenario.video.id), {
        method,
        ...(method === 'GET' ? {} : { body: {} }),
      }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(response.status).toBe(401);
    expect(await db.shareLink.count()).toBe(0);
  });

  it('returns 403 for a project COMMENTATOR and creates nothing', async () => {
    const scenario = await seedVersion();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      createShare,
      apiRequest(shareUrl(scenario.project.id, scenario.video.id), { body: {} }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.shareLink.count()).toBe(0);
  });

  it.each([
    ['GET', getShare],
    ['PATCH', patchShare],
    ['DELETE', revokeShare],
  ] as const)(
    'returns 403 for %s to a COMMENTATOR and preserves the link',
    async (method, handler) => {
      const scenario = await seedVersion();
      const link = await createShareLink({
        projectId: scenario.project.id,
        videoId: scenario.video.id,
        permission: 'COMMENT',
      });
      const commentator = await createUser();
      await addProjectMember({
        projectId: scenario.project.id,
        userId: commentator.id,
        role: 'COMMENTATOR',
      });
      signedInAs(commentator);

      const response = await callRoute(
        handler,
        apiRequest(shareUrl(scenario.project.id, scenario.video.id), {
          method,
          ...(method === 'PATCH' ? { body: { allowGuests: false } } : {}),
        }),
        { projectId: scenario.project.id, videoId: scenario.video.id }
      );

      expect(response.status).toBe(403);
      expect(await db.shareLink.findUnique({ where: { id: link.id } })).toMatchObject({
        token: link.token,
        allowGuests: link.allowGuests,
      });
    }
  );

  it('returns 404 when the video belongs to another project', async () => {
    const mine = await seedVersion();
    const theirs = await seedVersion();
    signedInAs(mine.owner);

    const response = await callRoute(
      createShare,
      apiRequest(shareUrl(mine.project.id, theirs.video.id), { body: {} }),
      { projectId: mine.project.id, videoId: theirs.video.id }
    );

    expect(response.status).toBe(404);
    expect(await db.shareLink.count()).toBe(0);
  });

  it('returns 403 once the workspace owner has lost billing access', async () => {
    const expiredOwner = await createExpiredUser();
    const workspace = await createWorkspace({ ownerId: expiredOwner.id });
    const project = await createProject({ ownerId: expiredOwner.id, workspaceId: workspace.id });
    const video = await createVideo({ projectId: project.id });
    signedInAs(expiredOwner);

    const response = await callRoute(
      createShare,
      apiRequest(shareUrl(project.id, video.id), { body: {} }),
      { projectId: project.id, videoId: video.id }
    );

    expect(response.status).toBe(403);
  });

  it('creates a COMMENT link with a bcrypt-hashed password and never echoes it back', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      createShare,
      apiRequest(shareUrl(scenario.project.id, scenario.video.id), {
        body: { password: '  correct horse  ', allowGuests: false, allowDownloads: true },
      }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );
    const payload = await readData<SharePayload>(response);

    expect(response.status).toBe(200);
    expect(payload.link?.hasPassword).toBe(true);
    expect(payload.link?.allowGuests).toBe(false);
    expect(payload.link?.allowDownloads).toBe(true);
    expect(payload.link?.token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expectShortVideoUrl(payload, payload.link!.token);
    expect(JSON.stringify(payload)).not.toContain('correct horse');

    const stored = await db.shareLink.findFirstOrThrow();
    expect(stored.permission).toBe('COMMENT');
    expect(stored.videoId).toBe(scenario.video.id);
    expect(stored.passwordHash).not.toBeNull();
    expect(stored.passwordHash).not.toContain('correct horse');
    // Trimmed before hashing, so the untrimmed form must not verify.
    expect(await bcrypt.compare('correct horse', stored.passwordHash!)).toBe(true);
    expect(await bcrypt.compare('  correct horse  ', stored.passwordHash!)).toBe(false);
  });

  it('rejects a password longer than 128 characters', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      createShare,
      apiRequest(shareUrl(scenario.project.id, scenario.video.id), {
        body: { password: 'x'.repeat(129) },
      }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(response.status).toBe(400);
    expect(await db.shareLink.count()).toBe(0);
  });

  it('rotates the token on a second create instead of adding a row', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const first = await readData<SharePayload>(
      await callRoute(
        createShare,
        apiRequest(shareUrl(scenario.project.id, scenario.video.id), { body: {} }),
        { projectId: scenario.project.id, videoId: scenario.video.id }
      )
    );
    const second = await readData<SharePayload>(
      await callRoute(
        createShare,
        apiRequest(shareUrl(scenario.project.id, scenario.video.id), { body: {} }),
        { projectId: scenario.project.id, videoId: scenario.video.id }
      )
    );

    expect(await db.shareLink.count()).toBe(1);
    expect(second.link?.id).toBe(first.link?.id);
    expect(second.link?.token).not.toBe(first.link?.token);
    expect(first.link?.token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(second.link?.token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expectShortVideoUrl(second, second.link!.token);
    expect((await db.shareLink.findUniqueOrThrow({ where: { id: first.link!.id } })).token).toBe(
      second.link?.token
    );
  });

  it('lets a workspace ADMIN manage the link for a project they are not a member of', async () => {
    const scenario = await seedVersion();
    const workspaceAdmin = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: workspaceAdmin.id,
      role: 'ADMIN',
    });
    signedInAs(workspaceAdmin);

    const response = await callRoute(
      createShare,
      apiRequest(shareUrl(scenario.project.id, scenario.video.id), { body: {} }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(response.status).toBe(200);
    expect(await db.shareLink.count()).toBe(1);
  });

  it('reports no link when none exists', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const payload = await readData<SharePayload>(
      await callRoute(getShare, apiRequest(shareUrl(scenario.project.id, scenario.video.id)), {
        projectId: scenario.project.id,
        videoId: scenario.video.id,
      })
    );

    expect(payload).toEqual({ link: null, shareUrl: null });
  });

  it('keeps a stored 32-character token and serializes its short URL on GET', async () => {
    const scenario = await seedVersion();
    const legacyToken = '1234567890abcdefghijklmnopqrstuv';
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
      token: legacyToken,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      getShare,
      apiRequest(shareUrl(scenario.project.id, scenario.video.id)),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );
    const payload = await readData<SharePayload>(response);

    expect(response.status).toBe(200);
    expectShortVideoUrl(payload, legacyToken);
    expect((await db.shareLink.findUniqueOrThrow({ where: { id: link.id } })).token).toBe(
      legacyToken
    );
  });

  it('ignores a project-wide VIEW link when reading the video share settings', async () => {
    const scenario = await seedVersion();
    await createShareLink({ projectId: scenario.project.id, permission: 'VIEW' });
    await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'VIEW',
    });
    signedInAs(scenario.owner);

    const payload = await readData<SharePayload>(
      await callRoute(getShare, apiRequest(shareUrl(scenario.project.id, scenario.video.id)), {
        projectId: scenario.project.id,
        videoId: scenario.video.id,
      })
    );

    expect(payload.link).toBeNull();
  });

  it('returns 404 on PATCH when there is no link yet', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchShare,
      apiRequest(shareUrl(scenario.project.id, scenario.video.id), {
        method: 'PATCH',
        body: { allowGuests: false },
      }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(response.status).toBe(404);
  });

  it('toggles allowGuests without rotating the token', async () => {
    const scenario = await seedVersion();
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
      allowGuests: true,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchShare,
      apiRequest(shareUrl(scenario.project.id, scenario.video.id), {
        method: 'PATCH',
        body: { allowGuests: false, allowDownloads: true },
      }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(response.status).toBe(200);
    const stored = await db.shareLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(stored.allowGuests).toBe(false);
    expect(stored.allowDownloads).toBe(true);
    expect(stored.token).toBe(link.token);
    expectShortVideoUrl(await readData<SharePayload>(response), link.token);
  });

  it('rotates to a 16-character token when adding a password', async () => {
    const scenario = await seedVersion();
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
      token: '1234567890abcdefghijklmnopqrstuv',
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchShare,
      apiRequest(shareUrl(scenario.project.id, scenario.video.id), {
        method: 'PATCH',
        body: { password: 'new secret' },
      }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );
    const payload = await readData<SharePayload>(response);
    const stored = await db.shareLink.findUniqueOrThrow({ where: { id: link.id } });

    expect(response.status).toBe(200);
    expect(stored.token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(stored.token).not.toBe(link.token);
    expect(await bcrypt.compare('new secret', stored.passwordHash!)).toBe(true);
    expectShortVideoUrl(payload, stored.token);
  });

  it('clears the password and rotates the token on clearPassword', async () => {
    const scenario = await seedVersion();
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
      password: 'secret123',
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchShare,
      apiRequest(shareUrl(scenario.project.id, scenario.video.id), {
        method: 'PATCH',
        body: { clearPassword: true },
      }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(response.status).toBe(200);
    const stored = await db.shareLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(stored.passwordHash).toBeNull();
    // Dropping the password must invalidate the old URL, otherwise anyone who
    // already had the token silently gains unprotected access.
    expect(stored.token).not.toBe(link.token);
    expect(stored.token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expectShortVideoUrl(await readData<SharePayload>(response), stored.token);
  });

  it('revokes only the COMMENT link for that video', async () => {
    const scenario = await seedVersion();
    const otherVideo = await createVideo({ projectId: scenario.project.id });
    await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
    });
    const viewLink = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'VIEW',
    });
    const otherLink = await createShareLink({
      projectId: scenario.project.id,
      videoId: otherVideo.id,
      permission: 'COMMENT',
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      revokeShare,
      apiRequest(shareUrl(scenario.project.id, scenario.video.id), { method: 'DELETE' }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(response.status).toBe(200);
    const remaining = (await db.shareLink.findMany({ select: { id: true } })).map((row) => row.id);
    expect(remaining.sort()).toEqual([viewLink.id, otherLink.id].sort());
  });
});

describe('share link enforcement on read', () => {
  it('grants a guest access with a valid VIEW session', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'VIEW',
    });
    signedOut();

    const response = await callRoute(
      watchVideo,
      apiRequest(`/api/watch/${scenario.video.id}`, {
        cookies: shareCookie(scenario.video.id, link.token),
      }),
      { videoId: scenario.video.id }
    );
    const payload = await readData<{ canComment: boolean; canDownload: boolean }>(response);

    expect(response.status).toBe(200);
    // VIEW must not confer comment rights.
    expect(payload.canComment).toBe(false);
    expect(payload.canDownload).toBe(false);
  });

  it('grants comment rights only with a COMMENT link', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
      allowGuests: true,
    });
    signedOut();

    const payload = await readData<{ canComment: boolean }>(
      await callRoute(
        watchVideo,
        apiRequest(`/api/watch/${scenario.video.id}`, {
          cookies: shareCookie(scenario.video.id, link.token),
        }),
        { videoId: scenario.video.id }
      )
    );

    expect(payload.canComment).toBe(true);
  });

  it('reports canDownload only when the link allows downloads', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'VIEW',
      allowDownloads: true,
    });
    signedOut();

    const payload = await readData<{ canDownload: boolean; canDownloadAssets: boolean }>(
      await callRoute(
        watchVideo,
        apiRequest(`/api/watch/${scenario.video.id}`, {
          cookies: shareCookie(scenario.video.id, link.token),
        }),
        { videoId: scenario.video.id }
      )
    );

    expect(payload.canDownload).toBe(true);
    expect(payload.canDownloadAssets).toBe(true);
  });

  it('refuses an expired link', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'VIEW',
      expiresAt: new Date(Date.now() - 1000),
    });
    signedOut();

    const response = await callRoute(
      watchVideo,
      apiRequest(`/api/watch/${scenario.video.id}`, {
        cookies: shareCookie(scenario.video.id, link.token),
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
  });

  it('refuses a password-protected link until the session records the password check', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'VIEW',
      password: 'letmein',
    });
    signedOut();

    const unverified = await callRoute(
      watchVideo,
      apiRequest(`/api/watch/${scenario.video.id}`, {
        cookies: shareCookie(scenario.video.id, link.token, false),
      }),
      { videoId: scenario.video.id }
    );
    const verified = await callRoute(
      watchVideo,
      apiRequest(`/api/watch/${scenario.video.id}`, {
        cookies: shareCookie(scenario.video.id, link.token, true),
      }),
      { videoId: scenario.video.id }
    );

    expect(unverified.status).toBe(403);
    expect(verified.status).toBe(200);
  });

  it('refuses a share session whose HMAC does not verify', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'VIEW',
    });
    const tampered = createShareSessionValue(link.token, scenario.video.id, true).replace(
      /.$/,
      'X'
    );
    signedOut();

    const response = await callRoute(
      watchVideo,
      apiRequest(`/api/watch/${scenario.video.id}`, {
        cookies: { [getShareSessionCookieName(scenario.video.id)]: tampered },
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
  });

  it('refuses a project-wide link presented for a specific video', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const projectWide = await createShareLink({
      projectId: scenario.project.id,
      videoId: null,
      permission: 'COMMENT',
    });
    signedOut();

    const response = await callRoute(
      watchVideo,
      apiRequest(`/api/watch/${scenario.video.id}`, {
        cookies: shareCookie(scenario.video.id, projectWide.token),
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
  });

  it('refuses a link once the workspace owner loses billing access', async () => {
    const expiredOwner = await createExpiredUser();
    const workspace = await createWorkspace({ ownerId: expiredOwner.id });
    const project = await createProject({ ownerId: expiredOwner.id, workspaceId: workspace.id });
    const video = await createVideo({ projectId: project.id });
    await createVersion({ videoParentId: video.id });
    const link = await createShareLink({
      projectId: project.id,
      videoId: video.id,
      permission: 'VIEW',
    });
    signedOut();

    const response = await callRoute(
      watchVideo,
      apiRequest(`/api/watch/${video.id}`, { cookies: shareCookie(video.id, link.token) }),
      { videoId: video.id }
    );

    expect(response.status).toBe(403);
  });

  it('lets a COMMENT-link guest post a comment but a VIEW-link guest cannot', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const viewLink = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'VIEW',
    });
    const commentLink = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
      allowGuests: true,
    });
    signedOut();

    const asViewer = await callRoute(
      postComment,
      apiRequest(`/api/versions/${scenario.version.id}/comments`, {
        body: { content: 'hi', timestamp: 1, guestName: 'Viewer' },
        cookies: shareCookie(scenario.video.id, viewLink.token),
      }),
      { versionId: scenario.version.id }
    );
    const asCommenter = await callRoute(
      postComment,
      apiRequest(`/api/versions/${scenario.version.id}/comments`, {
        body: { content: 'hi', timestamp: 1, guestName: 'Commenter' },
        cookies: shareCookie(scenario.video.id, commentLink.token),
      }),
      { versionId: scenario.version.id }
    );

    expect(asViewer.status).toBe(403);
    expect(asCommenter.status).toBe(201);
    const stored = await db.comment.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0].guestName).toBe('Commenter');
  });

  // A COMMENT link satisfies a VIEW requirement, but not the other way round.
  it('accepts a COMMENT link where only VIEW is required', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
    });
    signedOut();

    const response = await callRoute(
      listComments,
      apiRequest(`/api/versions/${scenario.version.id}/comments`, {
        cookies: shareCookie(scenario.video.id, link.token),
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(200);
  });

  it('refuses a token that does not exist', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedOut();

    const response = await callRoute(
      watchVideo,
      apiRequest(`/api/watch/${scenario.video.id}`, {
        cookies: shareCookie(scenario.video.id, 'not-a-real-token'),
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
  });
});
