import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import { deriveGuestUploadContext, verifyGuestUploadToken } from '@/lib/guest-upload-token';
import { GET as watchVideo } from '@/app/api/watch/[videoId]/route';
import { GET as getProgress, POST as saveProgress } from '@/app/api/watch/[videoId]/progress/route';
import { POST as issueUploadToken } from '@/app/api/watch/[videoId]/upload-token/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createComment,
  createExpiredUser,
  createProject,
  createShareLink,
  createUser,
  createVersion,
  createVideo,
  createWorkspace,
  seedVersion,
} from '../factories';

const ORIGIN = 'http://localhost:3000';

function shareCookie(videoId: string, token: string) {
  return {
    [getShareSessionCookieName(videoId)]: createShareSessionValue(token, videoId, false),
  };
}

describe('GET /api/watch/[videoId]', () => {
  it('returns 404 for an unknown video', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(watchVideo, apiRequest('/api/watch/nope'), {
      videoId: 'nope',
    });

    expect(response.status).toBe(404);
  });

  it('returns 403 to an anonymous caller on a PRIVATE video', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedOut();

    const response = await callRoute(watchVideo, apiRequest(`/api/watch/${scenario.video.id}`), {
      videoId: scenario.video.id,
    });

    expect(response.status).toBe(403);
  });

  it('returns 403 to a signed-in stranger on an INVITE video', async () => {
    const scenario = await seedVersion({ visibility: 'INVITE' });
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(watchVideo, apiRequest(`/api/watch/${scenario.video.id}`), {
      videoId: scenario.video.id,
    });

    expect(response.status).toBe(403);
  });

  it('serves an anonymous caller a PUBLIC video with read-only capabilities', async () => {
    const scenario = await seedVersion({ visibility: 'PUBLIC' });
    signedOut();

    const response = await callRoute(watchVideo, apiRequest(`/api/watch/${scenario.video.id}`), {
      videoId: scenario.video.id,
    });
    const payload = await readData<{
      isAuthenticated: boolean;
      currentUserId: string | null;
      canComment: boolean;
      canManageTags: boolean;
      canResolveComments: boolean;
      canShareVideo: boolean;
      canDownload: boolean;
      project: { name: string; ownerId: string };
    }>(response);

    expect(response.status).toBe(200);
    expect(payload.isAuthenticated).toBe(false);
    expect(payload.currentUserId).toBeNull();
    // computeProjectAccess grants hasAccess on a PUBLIC project, and the route
    // maps that straight onto canComment. Recorded as current behaviour; see
    // the report.
    expect(payload.canComment).toBe(true);
    expect(payload.canManageTags).toBe(false);
    expect(payload.canResolveComments).toBe(false);
    expect(payload.canShareVideo).toBe(false);
    expect(payload.canDownload).toBe(false);
    expect(payload.project.ownerId).toBe(scenario.owner.id);
  });

  it('grants the full capability set to the project owner', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const payload = await readData<{
      canManageTags: boolean;
      canResolveComments: boolean;
      canShareVideo: boolean;
      currentUserId: string;
    }>(
      await callRoute(watchVideo, apiRequest(`/api/watch/${scenario.video.id}`), {
        videoId: scenario.video.id,
      })
    );

    expect(payload.canManageTags).toBe(true);
    expect(payload.canResolveComments).toBe(true);
    expect(payload.canShareVideo).toBe(true);
    expect(payload.currentUserId).toBe(scenario.owner.id);
  });

  it('gives a COMMENTATOR member access without management rights', async () => {
    const scenario = await seedVersion();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const payload = await readData<{
      canComment: boolean;
      canManageTags: boolean;
      canShareVideo: boolean;
    }>(
      await callRoute(watchVideo, apiRequest(`/api/watch/${scenario.video.id}`), {
        videoId: scenario.video.id,
      })
    );

    expect(payload.canComment).toBe(true);
    expect(payload.canManageTags).toBe(false);
    expect(payload.canShareVideo).toBe(false);
  });

  it('gives a workspace ADMIN management rights on a project they never joined', async () => {
    const scenario = await seedVersion();
    const workspaceAdmin = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: workspaceAdmin.id,
      role: 'ADMIN',
    });
    signedInAs(workspaceAdmin);

    const payload = await readData<{ canManageTags: boolean; canShareVideo: boolean }>(
      await callRoute(watchVideo, apiRequest(`/api/watch/${scenario.video.id}`), {
        videoId: scenario.video.id,
      })
    );

    expect(payload.canManageTags).toBe(true);
    expect(payload.canShareVideo).toBe(true);
  });

  it('refuses even the owner once their billing access has lapsed', async () => {
    const expiredOwner = await createExpiredUser();
    const workspace = await createWorkspace({ ownerId: expiredOwner.id });
    const project = await createProject({ ownerId: expiredOwner.id, workspaceId: workspace.id });
    const video = await createVideo({ projectId: project.id });
    await createVersion({ videoParentId: video.id });
    signedInAs(expiredOwner);

    const response = await callRoute(watchVideo, apiRequest(`/api/watch/${video.id}`), {
      videoId: video.id,
    });

    expect(response.status).toBe(403);
  });

  it('nests comments with per-viewer capability flags and hides identity columns', async () => {
    const scenario = await seedVersion({ visibility: 'PUBLIC' });
    const otherAuthor = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: otherAuthor.id });
    const mine = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      content: 'mine',
    });
    const theirs = await createComment({
      versionId: scenario.version.id,
      authorId: otherAuthor.id,
      content: 'theirs',
    });
    await createComment({
      versionId: scenario.version.id,
      authorId: otherAuthor.id,
      parentId: theirs.id,
      content: 'a reply',
    });
    signedInAs(scenario.owner);

    const payload = await readData<{
      versions: Array<{
        comments: Array<{
          id: string;
          canEdit: boolean;
          canDelete: boolean;
          authorId?: string;
          guestIdentityId?: string;
          replies: Array<{ id: string; canEdit: boolean; canDelete: boolean }>;
        }>;
      }>;
    }>(
      await callRoute(
        watchVideo,
        apiRequest(`/api/watch/${scenario.video.id}?includeComments=true`),
        { videoId: scenario.video.id }
      )
    );

    const comments = payload.versions[0].comments;
    expect(comments).toHaveLength(2);

    const own = comments.find((entry) => entry.id === mine.id)!;
    const other = comments.find((entry) => entry.id === theirs.id)!;
    expect(own.canEdit).toBe(true);
    expect(own.canDelete).toBe(true);
    // The project owner may delete anyone's comment but not rewrite it.
    expect(other.canEdit).toBe(false);
    expect(other.canDelete).toBe(true);
    expect(other.replies).toHaveLength(1);
    expect(other.replies[0].canDelete).toBe(true);

    for (const comment of comments) {
      expect(comment).not.toHaveProperty('authorId');
      expect(comment).not.toHaveProperty('guestIdentityId');
    }
  });

  it('does not tell an anonymous viewer who uploaded a version', async () => {
    const scenario = await seedVersion({ visibility: 'PUBLIC' });
    await db.videoVersion.update({
      where: { id: scenario.version.id },
      data: { uploadedById: scenario.owner.id },
    });
    signedOut();

    const payload = await readData<{ versions: Array<Record<string, unknown>> }>(
      await callRoute(
        watchVideo,
        apiRequest(`/api/watch/${scenario.video.id}?includeComments=true`),
        { videoId: scenario.video.id }
      )
    );

    expect(payload.versions[0]).toHaveProperty('comments');
    expect(payload.versions[0]).not.toHaveProperty('uploadedById');
  });

  it('omits comments entirely unless includeComments=true', async () => {
    const scenario = await seedVersion();
    await createComment({ versionId: scenario.version.id, authorId: scenario.owner.id });
    signedInAs(scenario.owner);

    const payload = await readData<{ versions: Array<Record<string, unknown>> }>(
      await callRoute(watchVideo, apiRequest(`/api/watch/${scenario.video.id}`), {
        videoId: scenario.video.id,
      })
    );

    expect(payload.versions[0]).not.toHaveProperty('comments');
    expect(payload.versions[0]).toHaveProperty('_count');
  });
});

describe('GET /api/watch/[videoId]/progress', () => {
  it('returns 401 without a session, even for a PUBLIC video', async () => {
    const scenario = await seedVersion({ visibility: 'PUBLIC' });
    signedOut();

    const response = await callRoute(
      getProgress,
      apiRequest(`/api/watch/${scenario.video.id}/progress`),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 for a signed-in stranger on a PRIVATE video', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      getProgress,
      apiRequest(`/api/watch/${scenario.video.id}/progress`),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
  });

  it('returns zero progress and the version duration when nothing is stored', async () => {
    const scenario = await seedVersion({ duration: 300 });
    signedInAs(scenario.owner);

    const payload = await readData<{
      progress: number;
      duration: number;
      percentage: number;
      updatedAt: string | null;
    }>(
      await callRoute(getProgress, apiRequest(`/api/watch/${scenario.video.id}/progress`), {
        videoId: scenario.video.id,
      })
    );

    expect(payload).toEqual({ progress: 0, duration: 300, percentage: 0, updatedAt: null });
  });

  it('returns 404 when the video has no active version', async () => {
    const scenario = await seedVersion();
    await db.videoVersion.update({
      where: { id: scenario.version.id },
      data: { isActive: false },
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      getProgress,
      apiRequest(`/api/watch/${scenario.video.id}/progress`),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(404);
  });

  it('reads back only the calling user own progress', async () => {
    const scenario = await seedVersion();
    const other = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: other.id });
    await db.watchProgress.create({
      data: {
        userId: other.id,
        versionId: scenario.version.id,
        progress: 90,
        duration: 120,
        percentage: 75,
      },
    });
    signedInAs(scenario.owner);

    const payload = await readData<{ progress: number; percentage: number }>(
      await callRoute(getProgress, apiRequest(`/api/watch/${scenario.video.id}/progress`), {
        videoId: scenario.video.id,
      })
    );

    expect(payload.progress).toBe(0);
    expect(payload.percentage).toBe(0);
  });
});

describe('POST /api/watch/[videoId]/progress', () => {
  it('returns 401 without a session and stores nothing', async () => {
    const scenario = await seedVersion({ visibility: 'PUBLIC' });
    signedOut();

    const response = await callRoute(
      saveProgress,
      apiRequest(`/api/watch/${scenario.video.id}/progress`, {
        body: { progress: 10, duration: 100 },
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(401);
    expect(await db.watchProgress.count()).toBe(0);
  });

  it('returns 403 for a signed-in stranger', async () => {
    const scenario = await seedVersion();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      saveProgress,
      apiRequest(`/api/watch/${scenario.video.id}/progress`, {
        body: { progress: 10, duration: 100 },
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.watchProgress.count()).toBe(0);
  });

  it.each([
    [{ progress: -1, duration: 100 }, 'a negative progress'],
    [{ progress: 86_401, duration: 100 }, 'a progress past 24 hours'],
    [{ progress: 'ten', duration: 100 }, 'a non-numeric progress'],
    [{ duration: 100 }, 'a missing progress'],
    [{ progress: 10, duration: -5 }, 'a negative duration'],
    [{ progress: 10, duration: 86_401 }, 'a duration past 24 hours'],
    [{ progress: 10, duration: 100, versionId: 5 }, 'a non-string versionId'],
  ])('rejects %j with 400 (%s)', async (body, label) => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      saveProgress,
      apiRequest(`/api/watch/${scenario.video.id}/progress`, { body }),
      { videoId: scenario.video.id }
    );

    expect(response.status, label).toBe(400);
    expect(await db.watchProgress.count()).toBe(0);
  });

  it('upserts progress for the caller with a computed percentage', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const first = await callRoute(
      saveProgress,
      apiRequest(`/api/watch/${scenario.video.id}/progress`, {
        body: { progress: 30, duration: 120 },
      }),
      { videoId: scenario.video.id }
    );
    const second = await callRoute(
      saveProgress,
      apiRequest(`/api/watch/${scenario.video.id}/progress`, {
        body: { progress: 60, duration: 120 },
      }),
      { videoId: scenario.video.id }
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const rows = await db.watchProgress.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(scenario.owner.id);
    expect(rows[0].versionId).toBe(scenario.version.id);
    expect(rows[0].progress).toBe(60);
    expect(rows[0].percentage).toBe(50);
  });

  it('clamps the percentage at 100 when progress exceeds the reported duration', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    await callRoute(
      saveProgress,
      apiRequest(`/api/watch/${scenario.video.id}/progress`, {
        body: { progress: 500, duration: 100 },
      }),
      { videoId: scenario.video.id }
    );

    expect((await db.watchProgress.findFirstOrThrow()).percentage).toBe(100);
  });

  it('records zero percent when no duration is supplied', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      saveProgress,
      apiRequest(`/api/watch/${scenario.video.id}/progress`, { body: { progress: 42 } }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(200);
    const stored = await db.watchProgress.findFirstOrThrow();
    expect(stored.duration).toBe(0);
    expect(stored.percentage).toBe(0);
  });

  it('returns 404 for a versionId that belongs to a different video', async () => {
    const scenario = await seedVersion();
    const other = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      saveProgress,
      apiRequest(`/api/watch/${scenario.video.id}/progress`, {
        body: { progress: 10, duration: 100, versionId: other.version.id },
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(404);
    expect(await db.watchProgress.count()).toBe(0);
  });

  it('writes to the named version of the same video when versionId is supplied', async () => {
    const scenario = await seedVersion();
    const older = await createVersion({
      videoParentId: scenario.video.id,
      versionNumber: 2,
      isActive: false,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      saveProgress,
      apiRequest(`/api/watch/${scenario.video.id}/progress`, {
        body: { progress: 10, duration: 100, versionId: older.id },
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(200);
    expect((await db.watchProgress.findFirstOrThrow()).versionId).toBe(older.id);
  });

  it('ignores a userId supplied in the body and always writes for the session user', async () => {
    const scenario = await seedVersion();
    const victim = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: victim.id });
    signedInAs(scenario.owner);

    const response = await callRoute(
      saveProgress,
      apiRequest(`/api/watch/${scenario.video.id}/progress`, {
        body: { progress: 10, duration: 100, userId: victim.id },
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(200);
    const rows = await db.watchProgress.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(scenario.owner.id);
  });
});

describe('POST /api/watch/[videoId]/upload-token', () => {
  it('returns 403 without an Origin header', async () => {
    const scenario = await seedVersion();
    signedOut();

    const response = await callRoute(
      issueUploadToken,
      apiRequest(`/api/watch/${scenario.video.id}/upload-token`, { body: { intent: 'image' } }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
  });

  it('returns 403 for a cross-origin request', async () => {
    const scenario = await seedVersion();
    signedOut();

    const response = await callRoute(
      issueUploadToken,
      apiRequest(`/api/watch/${scenario.video.id}/upload-token`, {
        body: { intent: 'image' },
        headers: { origin: 'https://evil.example.com' },
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
  });

  it('returns 400 for a signed-in caller, who does not need a guest token', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      issueUploadToken,
      apiRequest(`/api/watch/${scenario.video.id}/upload-token`, {
        body: { intent: 'image' },
        headers: { origin: ORIGIN },
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(400);
  });

  it.each([['video'], [''], ['IMAGE']])('returns 400 for the intent %s', async (intent) => {
    const scenario = await seedVersion();
    signedOut();

    const response = await callRoute(
      issueUploadToken,
      apiRequest(`/api/watch/${scenario.video.id}/upload-token`, {
        body: { intent },
        headers: { origin: ORIGIN },
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(400);
  });

  it('returns 403 for a guest with no share session', async () => {
    const scenario = await seedVersion();
    signedOut();

    const response = await callRoute(
      issueUploadToken,
      apiRequest(`/api/watch/${scenario.video.id}/upload-token`, {
        body: { intent: 'image' },
        headers: { origin: ORIGIN },
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
  });

  it('returns 403 for a guest holding only a VIEW share session', async () => {
    const scenario = await seedVersion();
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'VIEW',
    });
    signedOut();

    const response = await callRoute(
      issueUploadToken,
      apiRequest(`/api/watch/${scenario.video.id}/upload-token`, {
        body: { intent: 'image' },
        headers: { origin: ORIGIN },
        cookies: shareCookie(scenario.video.id, link.token),
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
  });

  it('returns 403 when the COMMENT link disallows guests', async () => {
    const scenario = await seedVersion();
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
      allowGuests: false,
    });
    signedOut();

    const response = await callRoute(
      issueUploadToken,
      apiRequest(`/api/watch/${scenario.video.id}/upload-token`, {
        body: { intent: 'image' },
        headers: { origin: ORIGIN },
        cookies: shareCookie(scenario.video.id, link.token),
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
  });

  // The token is scoped to project, video and intent. An image token must not
  // be accepted for an audio upload, nor for another video.
  it('issues a token scoped to the video, project and intent', async () => {
    const scenario = await seedVersion();
    const otherVideo = await createVideo({ projectId: scenario.project.id });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
      allowGuests: true,
    });
    signedOut();

    const request = apiRequest(`/api/watch/${scenario.video.id}/upload-token`, {
      body: { intent: 'image' },
      headers: { origin: ORIGIN },
      cookies: shareCookie(scenario.video.id, link.token),
    });
    const response = await callRoute(issueUploadToken, request, { videoId: scenario.video.id });
    const payload = await readData<{ token: string; intent: string; expiresInSeconds: number }>(
      response
    );

    expect(response.status).toBe(200);
    expect(payload.intent).toBe('image');
    expect(payload.expiresInSeconds).toBeGreaterThan(0);

    const context = deriveGuestUploadContext(request, link.token)!;
    expect(context).toBeTruthy();

    expect(
      verifyGuestUploadToken(payload.token, {
        projectId: scenario.project.id,
        videoId: scenario.video.id,
        intent: 'image',
        context,
      })
    ).toBe(true);

    expect(
      verifyGuestUploadToken(payload.token, {
        projectId: scenario.project.id,
        videoId: scenario.video.id,
        intent: 'audio',
        context,
      })
    ).toBe(false);

    expect(
      verifyGuestUploadToken(payload.token, {
        projectId: scenario.project.id,
        videoId: otherVideo.id,
        intent: 'image',
        context,
      })
    ).toBe(false);

    // The context binds the token to the presented share token, so a token
    // minted through one share link cannot be replayed through another.
    const otherLinkContext = deriveGuestUploadContext(request, 'a-different-share-token')!;
    expect(
      verifyGuestUploadToken(payload.token, {
        projectId: scenario.project.id,
        videoId: scenario.video.id,
        intent: 'image',
        context: otherLinkContext,
      })
    ).toBe(false);
  });
});
