import { DELETE as cancelBunnyUpload } from '@/app/api/projects/[projectId]/videos/bunny-init/route';
import { createBunnyUploadToken } from '@/lib/bunny-upload-token';
import { getApprovalCandidatesForProject } from '@/lib/approval-workflow';
import { startCardlessTrialOnSignup } from '@/lib/billing';
import { GET as search } from '@/app/api/search/route';
import {
  POST as initR2Upload,
  DELETE as cancelR2Upload,
} from '@/app/api/projects/[projectId]/videos/r2-init/route';
import {
  POST as shareVideo,
  PATCH as patchShareVideo,
} from '@/app/api/projects/[projectId]/videos/[videoId]/share/route';
import { describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  checkFolderAccess,
  checkVideoAccess,
  visibleVideoWhere,
  visibleFolderWhere,
} from '@/lib/content-access';
import { acceptInvitationTokenForUser } from '@/lib/invitations';
import { moveContentVideos, contentTransaction } from '@/lib/content-mutations';
import * as foldersRoute from '@/app/api/projects/[projectId]/folders/route';
import * as videosRoute from '@/app/api/projects/[projectId]/videos/route';
import * as watchRoute from '@/app/api/watch/[videoId]/route';
import {
  createUser,
  createProject,
  createWorkspace,
  createVideo,
  createVersion,
  addProjectMember,
  addWorkspaceMember,
  createShareLink,
  createVideoAsset,
} from '../factories';
import { signedInAs, signedOut } from '../helpers/session';
import { apiRequest, callRoute } from '../helpers/request';

async function fixture() {
  const [owner, a, b] = await Promise.all([createUser(), createUser(), createUser()]);
  const workspace = await createWorkspace({ ownerId: owner.id });
  const project = await createProject({ workspaceId: workspace.id, ownerId: owner.id });
  const folderA = await db.projectFolder.create({
    data: { projectId: project.id, name: 'A', accessMode: 'RESTRICTED' },
  });
  const folderB = await db.projectFolder.create({
    data: { projectId: project.id, name: 'B', accessMode: 'RESTRICTED' },
  });
  const child = await db.projectFolder.create({
    data: { projectId: project.id, parentId: folderA.id, name: 'Offline' },
  });
  const [videoA, videoB, root] = await Promise.all([
    db.video.create({ data: { projectId: project.id, folderId: child.id, title: 'A cut' } }),
    db.video.create({ data: { projectId: project.id, folderId: folderB.id, title: 'B cut' } }),
    createVideo({ projectId: project.id }),
  ]);
  await Promise.all([
    db.projectFolderMember.create({ data: { folderId: folderA.id, userId: a.id } }),
    db.projectFolderMember.create({ data: { folderId: folderB.id, userId: b.id } }),
  ]);
  return { owner, a, b, workspace, project, folderA, folderB, child, videoA, videoB, root };
}
async function action(projectId: string, body: object) {
  return callRoute(foldersRoute.POST, apiRequest(`/api/projects/${projectId}/folders`, { body }), {
    projectId,
  });
}

describe('project folder access', () => {
  it('shows each invited account only its inherited area, not parent or siblings', async () => {
    const f = await fixture();
    const rows = await db.video.findMany({
      where: visibleVideoWhere(f.a.id),
      select: { id: true },
    });
    expect(rows.map((v) => v.id)).toEqual([f.videoA.id]);
    expect((await checkVideoAccess(f.videoB.id, f.a.id)).hasAccess).toBe(false);
    expect((await checkFolderAccess(f.project.id, null, f.a.id))?.hasAccess).toBe(false);
    expect((await checkVideoAccess(f.videoA.id, f.a.id)).canEdit).toBe(false);
    expect((await checkVideoAccess(f.videoB.id, f.b.id)).hasAccess).toBe(true);
    signedInAs(f.a);
    const response = await callRoute(watchRoute.GET, apiRequest(`/api/watch/${f.videoB.id}`), {
      videoId: f.videoB.id,
    });
    expect(response.status).toBe(403);
  });
  it('blocks public, project and workspace commentators while retaining managers', async () => {
    const f = await fixture();
    await db.project.update({ where: { id: f.project.id }, data: { visibility: 'PUBLIC' } });
    await addProjectMember({ projectId: f.project.id, userId: f.b.id });
    await addWorkspaceMember({ workspaceId: f.workspace.id, userId: f.b.id });
    expect((await checkVideoAccess(f.videoA.id, f.b.id)).hasAccess).toBe(false);
    expect((await checkVideoAccess(f.videoA.id)).hasAccess).toBe(false);
    expect((await checkVideoAccess(f.root.id)).hasAccess).toBe(true);
    expect((await checkVideoAccess(f.videoA.id, f.owner.id)).canEdit).toBe(true);
    await db.projectMember.update({
      where: { projectId_userId: { projectId: f.project.id, userId: f.b.id } },
      data: { role: 'ADMIN' },
    });
    expect((await checkVideoAccess(f.videoA.id, f.b.id)).canEdit).toBe(true);
  });
  it('cuts inheritance at nested folder and video restrictions and revokes immediately', async () => {
    const f = await fixture();
    await db.projectFolder.update({
      where: { id: f.child.id },
      data: { accessMode: 'RESTRICTED' },
    });
    expect((await checkVideoAccess(f.videoA.id, f.a.id)).hasAccess).toBe(false);
    await db.videoMember.create({ data: { videoId: f.videoA.id, userId: f.a.id } });
    await db.video.update({ where: { id: f.videoA.id }, data: { accessMode: 'RESTRICTED' } });
    expect((await checkVideoAccess(f.videoA.id, f.a.id)).hasAccess).toBe(true);
    await db.videoMember.deleteMany({ where: { videoId: f.videoA.id } });
    expect((await checkVideoAccess(f.videoA.id, f.a.id)).hasAccess).toBe(false);
  });
  it('authenticates creation and refuses a commentator without creating a row', async () => {
    const f = await fixture();
    signedOut();
    expect((await action(f.project.id, { action: 'create', name: 'New' })).status).toBe(401);
    signedInAs(f.a);
    expect(
      (await action(f.project.id, { action: 'create', folderId: f.folderA.id, name: 'New' })).status
    ).toBe(403);
    expect(await db.projectFolder.count({ where: { name: 'New' } })).toBe(0);
    signedInAs(f.owner);
    const response = await action(f.project.id, {
      action: 'create',
      folderId: f.folderA.id,
      name: 'New',
    });
    expect(response.status).toBe(200);
    expect(await db.projectFolder.findFirst({ where: { name: 'New' } })).toMatchObject({
      parentId: f.folderA.id,
      accessMode: 'INHERIT',
    });
  });
  it('accepts folder invitations without broadening membership, and cancellation prevents acceptance', async () => {
    const f = await fixture();
    const invited = await createUser();
    signedInAs(f.owner);
    const response = await action(f.project.id, {
      action: 'invite',
      folderId: f.child.id,
      email: invited.email,
      role: 'COMMENTATOR',
    });
    const payload = await response.json();
    const token = new URL(payload.data.invitationUrl).searchParams.get('token')!;
    expect(
      await acceptInvitationTokenForUser({ token, userId: invited.id, email: invited.email! })
    ).toBe('accepted');
    expect(await db.projectMember.count({ where: { userId: invited.id } })).toBe(0);
    expect(await db.workspaceMember.count({ where: { userId: invited.id } })).toBe(0);
    expect((await checkVideoAccess(f.videoA.id, invited.id)).hasAccess).toBe(true);
    expect((await checkFolderAccess(f.project.id, f.folderA.id, invited.id))?.hasAccess).toBe(
      false
    );
    const second = await action(f.project.id, {
      action: 'invite',
      videoId: f.videoB.id,
      email: invited.email,
      role: 'COMMENTATOR',
    });
    const secondToken = new URL((await second.json()).data.invitationUrl).searchParams.get(
      'token'
    )!;
    const pending = await db.invitation.findUniqueOrThrow({ where: { token: secondToken } });
    await action(f.project.id, {
      action: 'revokeInvitation',
      videoId: f.videoB.id,
      invitationId: pending.id,
    });
    expect(
      await acceptInvitationTokenForUser({
        token: secondToken,
        userId: invited.id,
        email: invited.email!,
      })
    ).toBe('not_found');
    expect((await checkVideoAccess(f.videoB.id, invited.id)).hasAccess).toBe(false);
  });
  it('requires fresh confirmation and revokes old links when restricting', async () => {
    const f = await fixture();
    await db.projectFolder.update({ where: { id: f.folderA.id }, data: { accessMode: 'INHERIT' } });
    await addProjectMember({ projectId: f.project.id, userId: f.b.id });
    expect((await checkVideoAccess(f.videoA.id, f.b.id)).hasAccess).toBe(true);
    const link = await createShareLink({ projectId: f.project.id, videoId: f.videoA.id });
    signedInAs(f.owner);
    const body = { action: 'access', folderId: f.folderA.id, accessMode: 'RESTRICTED' };
    const preview = await (await action(f.project.id, body)).json();
    expect(preview.data.needsConfirmation).toBe(true);
    expect(
      (await db.projectFolder.findUniqueOrThrow({ where: { id: f.folderA.id } })).accessMode
    ).toBe('INHERIT');
    await db.projectFolderMember.create({ data: { folderId: f.folderB.id, userId: f.a.id } });
    const stale = await (
      await action(f.project.id, { ...body, confirmationToken: preview.data.confirmationToken })
    ).json();
    expect(stale.data.needsConfirmation).toBe(true);
    expect(await db.shareLink.findUnique({ where: { id: link.id } })).not.toBeNull();
    await action(f.project.id, { ...body, confirmationToken: stale.data.confirmationToken });
    expect(await db.shareLink.findUnique({ where: { id: link.id } })).toBeNull();
    expect(
      (await db.projectFolder.findUniqueOrThrow({ where: { id: f.folderA.id } })).accessMode
    ).toBe('RESTRICTED');
    expect((await checkVideoAccess(f.videoA.id, f.b.id)).hasAccess).toBe(false);
    expect((await checkVideoAccess(f.videoA.id, f.a.id)).hasAccess).toBe(true);
  });
  it('preserves video identity, versions and direct grants on confirmed cross-project moves', async () => {
    const f = await fixture();
    const target = await createProject({ workspaceId: f.workspace.id, ownerId: f.owner.id });
    const version = await createVersion({ videoParentId: f.videoA.id });
    await db.videoMember.create({ data: { videoId: f.videoA.id, userId: f.a.id } });
    await createShareLink({ projectId: f.project.id, videoId: f.videoA.id });
    const input = {
      projectId: f.project.id,
      targetProjectId: target.id,
      folderId: null,
      videoIds: [f.videoA.id],
      userId: f.owner.id,
    };
    const preview = await moveContentVideos(input);
    expect('confirmationToken' in preview).toBe(true);
    await moveContentVideos({
      ...input,
      confirmationToken: 'confirmationToken' in preview ? preview.confirmationToken : '',
    });
    expect(await db.video.findUnique({ where: { id: f.videoA.id } })).toMatchObject({
      projectId: target.id,
      folderId: null,
    });
    expect(await db.videoVersion.findUnique({ where: { id: version.id } })).toMatchObject({
      videoParentId: f.videoA.id,
    });
    expect(await db.videoMember.count({ where: { videoId: f.videoA.id } })).toBe(1);
    expect(await db.shareLink.count({ where: { videoId: f.videoA.id } })).toBe(0);
  });
  it('rejects a mixed authorized and unauthorized batch without moving either', async () => {
    const f = await fixture();
    await db.projectFolderMember.update({
      where: { folderId_userId: { folderId: f.folderA.id, userId: f.a.id } },
      data: { role: 'ADMIN' },
    });
    await expect(
      moveContentVideos({
        projectId: f.project.id,
        targetProjectId: f.project.id,
        folderId: f.folderA.id,
        videoIds: [f.videoA.id, f.videoB.id],
        userId: f.a.id,
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(await db.video.findUnique({ where: { id: f.videoA.id } })).toMatchObject({
      folderId: f.child.id,
    });
    expect(await db.video.findUnique({ where: { id: f.videoB.id } })).toMatchObject({
      folderId: f.folderB.id,
    });
  });
  it('enforces same-project parent/video relations and rejects cycles and level eleven in the database', async () => {
    const f = await fixture();
    const other = await createProject({ ownerId: f.owner.id, workspaceId: f.workspace.id });
    await expect(
      db.video.update({
        where: { id: f.root.id },
        data: { projectId: other.id, folderId: f.folderA.id },
      })
    ).rejects.toThrow();
    await expect(
      db.projectFolder.update({ where: { id: f.folderA.id }, data: { parentId: f.child.id } })
    ).rejects.toThrow();
    let parentId = f.child.id;
    for (let depth = 3; depth <= 10; depth++)
      parentId = (
        await db.projectFolder.create({
          data: { projectId: f.project.id, parentId, name: `Level ${depth}` },
        })
      ).id;
    await expect(
      db.projectFolder.create({ data: { projectId: f.project.id, parentId, name: 'Too deep' } })
    ).rejects.toThrow();
    expect(await db.projectFolder.count({ where: { name: 'Too deep' } })).toBe(0);
  });
  it('refuses nonempty folder deletion and uploads to deleted destinations', async () => {
    const f = await fixture();
    signedInAs(f.owner);
    expect((await action(f.project.id, { action: 'delete', folderId: f.child.id })).status).toBe(
      409
    );
    expect(await db.video.findUnique({ where: { id: f.videoA.id } })).not.toBeNull();
    const empty = await db.projectFolder.create({
      data: { projectId: f.project.id, name: 'Temporary' },
    });
    expect((await action(f.project.id, { action: 'delete', folderId: empty.id })).status).toBe(200);
    const response = await callRoute(
      videosRoute.POST,
      apiRequest(`/api/projects/${f.project.id}/videos`, {
        body: {
          folderId: empty.id,
          title: 'Upload',
          videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        },
      }),
      { projectId: f.project.id }
    );
    expect(response.status).toBe(403);
    expect(await db.video.count({ where: { title: 'Upload' } })).toBe(0);
  });
  it('binds confirmation to the exact operation and actor', async () => {
    const f = await fixture();
    await addProjectMember({ projectId: f.project.id, userId: f.b.id, role: 'ADMIN' });
    signedInAs(f.owner);
    const body = { action: 'access', folderId: f.folderA.id, accessMode: 'INHERIT' };
    const preview = await (await action(f.project.id, body)).json();
    const wrongOperation = await (
      await action(f.project.id, {
        ...body,
        accessMode: 'RESTRICTED',
        confirmationToken: preview.data.confirmationToken,
      })
    ).json();
    expect(wrongOperation.data.needsConfirmation).toBe(true);
    signedInAs(f.b);
    const wrongActor = await (
      await action(f.project.id, { ...body, confirmationToken: preview.data.confirmationToken })
    ).json();
    expect(wrongActor.data.needsConfirmation).toBe(true);
    expect(
      (await db.projectFolder.findUniqueOrThrow({ where: { id: f.folderA.id } })).accessMode
    ).toBe('RESTRICTED');
  });
  it('keeps direct content grants behind workspace owner billing, including after a preview', async () => {
    const f = await fixture();
    await db.videoMember.create({ data: { videoId: f.videoB.id, userId: f.a.id, role: 'ADMIN' } });
    signedInAs(f.owner);
    const body = { action: 'access', videoId: f.videoB.id, accessMode: 'INHERIT' };
    const preview = await (await action(f.project.id, body)).json();
    await db.user.update({
      where: { id: f.owner.id },
      data: { trialEndsAt: new Date(0), billingAccessEndedAt: new Date(0) },
    });
    expect(await db.video.count({ where: visibleVideoWhere(f.a.id) })).toBe(0);
    expect(await db.projectFolder.count({ where: visibleFolderWhere(f.a.id) })).toBe(0);
    expect((await checkVideoAccess(f.videoB.id, f.a.id)).hasAccess).toBe(false);
    expect((await checkFolderAccess(f.project.id, f.folderA.id, f.a.id))?.hasAccess).toBe(false);
    expect(
      (await action(f.project.id, { ...body, confirmationToken: preview.data.confirmationToken }))
        .status
    ).toBe(403);
  });
  it('does not recreate a share link when access is revoked while reading the request body', async () => {
    const f = await fixture();
    await db.projectFolderMember.update({
      where: { folderId_userId: { folderId: f.folderA.id, userId: f.a.id } },
      data: { role: 'ADMIN' },
    });
    signedInAs(f.a);
    const request = apiRequest(`/api/projects/${f.project.id}/videos/${f.videoA.id}/share`, {
      body: {},
    });
    vi.spyOn(request, 'json').mockImplementation(async () => {
      await db.video.update({ where: { id: f.videoA.id }, data: { accessMode: 'RESTRICTED' } });
      return {};
    });
    const response = await callRoute(shareVideo, request, {
      projectId: f.project.id,
      videoId: f.videoA.id,
    });
    expect(response.status).toBe(403);
    expect(await db.shareLink.count({ where: { videoId: f.videoA.id } })).toBe(0);
  });
  it('binds a real R2 admission to its folder and never finalizes into root after deletion', async () => {
    const f = await fixture();
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'true');
    vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'false');
    vi.stubEnv('R2_ACCESS_KEY_ID', 'test');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test');
    vi.stubEnv('R2_BUCKET_NAME', 'test');
    vi.stubEnv('R2_ACCOUNT_ID', 'test');
    signedInAs(f.owner);
    const empty = await db.projectFolder.create({
      data: { projectId: f.project.id, name: 'Upload destination' },
    });
    const init = await callRoute(
      initR2Upload,
      apiRequest(`/api/projects/${f.project.id}/videos/r2-init`, {
        body: {
          folderId: empty.id,
          fileName: 'clip.mp4',
          sizeBytes: '1024',
          contentType: 'video/mp4',
        },
      }),
      { projectId: f.project.id }
    );
    expect(init.status).toBe(200);
    const upload = (await init.json()).data;
    const saved = await db.videoUploadSession.findUniqueOrThrow({
      where: { objectKey: upload.objectKey },
    });
    expect(saved.folderId).toBe(empty.id);
    await action(f.project.id, { action: 'delete', folderId: empty.id });
    const completeBody = {
      folderId: empty.id,
      title: 'Uploaded cut',
      videoUrl: upload.proxyUrl,
      providerId: 'r2',
      videoId: upload.objectKey,
      objectKey: upload.objectKey,
      uploadToken: upload.uploadToken,
    };
    const complete = await callRoute(
      videosRoute.POST,
      apiRequest(`/api/projects/${f.project.id}/videos`, { body: completeBody }),
      { projectId: f.project.id }
    );
    expect(complete.status).toBe(403);
    const fallback = await callRoute(
      videosRoute.POST,
      apiRequest(`/api/projects/${f.project.id}/videos`, {
        body: { ...completeBody, folderId: null },
      }),
      { projectId: f.project.id }
    );
    expect(fallback.status).toBe(403);
    expect(await db.video.count({ where: { title: 'Uploaded cut' } })).toBe(0);
    expect(
      (await db.videoUploadSession.findUniqueOrThrow({ where: { id: saved.id } })).status
    ).toBe('INITIATED');
    expect(
      await db.uploadReservation.findUnique({ where: { id: saved.reservationId! } })
    ).not.toBeNull();
  });
  it('admits a direct video admin to version uploads without granting root upload rights', async () => {
    const f = await fixture();
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'true');
    vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'false');
    vi.stubEnv('R2_ACCESS_KEY_ID', 'test');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test');
    vi.stubEnv('R2_BUCKET_NAME', 'test');
    vi.stubEnv('R2_ACCOUNT_ID', 'test');
    await db.videoMember.create({ data: { videoId: f.videoA.id, userId: f.b.id, role: 'ADMIN' } });
    signedInAs(f.b);
    const body = {
      targetVideoId: f.videoA.id,
      fileName: 'revision.mp4',
      sizeBytes: '1024',
      contentType: 'video/mp4',
    };
    const init = await callRoute(
      initR2Upload,
      apiRequest(`/api/projects/${f.project.id}/videos/r2-init`, { body }),
      { projectId: f.project.id }
    );
    expect(init.status).toBe(200);
    const upload = (await init.json()).data;
    const saved = await db.videoUploadSession.findFirstOrThrow();
    expect(saved.targetVideoId).toBe(f.videoA.id);
    const root = await callRoute(
      initR2Upload,
      apiRequest(`/api/projects/${f.project.id}/videos/r2-init`, {
        body: { ...body, targetVideoId: null },
      }),
      { projectId: f.project.id }
    );
    expect(root.status).toBe(403);
    expect(await db.videoUploadSession.count()).toBe(1);
    expect(await db.uploadReservation.count()).toBe(1);
    await db.videoMember.deleteMany({ where: { videoId: f.videoA.id, userId: f.b.id } });
    const cancelled = await callRoute(
      cancelR2Upload,
      apiRequest(`/api/projects/${f.project.id}/videos/r2-init`, {
        method: 'DELETE',
        body: { objectKey: upload.objectKey, uploadToken: upload.uploadToken },
      }),
      { projectId: f.project.id }
    );
    expect(cancelled.status).toBe(200);
    expect(
      (await db.videoUploadSession.findUniqueOrThrow({ where: { id: saved.id } })).status
    ).toBe('CANCELLED');
    expect(
      await db.uploadReservation.findUnique({ where: { id: saved.reservationId! } })
    ).toBeNull();
  });
});

describe('content mutation regression checks', () => {
  it('rejects an old permission snapshot after waiting for membership revocation', async () => {
    const f = await fixture();
    await db.projectFolderMember.update({
      where: { folderId_userId: { folderId: f.folderA.id, userId: f.a.id } },
      data: { role: 'ADMIN' },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let holderPid = 0;
    const revoke = contentTransaction([f.project.id], async (tx) => {
      holderPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]
        .pid;
      await tx.projectFolderMember.deleteMany({
        where: { folderId: f.folderA.id, userId: f.a.id },
      });
      entered();
      await gate;
    });
    void revoke.catch(() => {});
    await ready;
    signedInAs(f.a);
    const pending = callRoute(
      shareVideo,
      apiRequest(`/api/projects/${f.project.id}/videos/${f.videoA.id}/share`, { body: {} }),
      { projectId: f.project.id, videoId: f.videoA.id }
    );
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const rows = await db.$queryRaw<
          Array<{ waiting: boolean }>
        >`SELECT EXISTS (SELECT 1 FROM pg_locks held JOIN pg_locks waiter USING (database, classid, objid, objsubid) WHERE held.pid = ${holderPid} AND held.locktype = 'advisory' AND held.granted AND waiter.locktype = 'advisory' AND NOT waiter.granted) AS waiting`;
        if (rows[0].waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await Promise.allSettled([revoke, pending]);
    }
    await revoke;
    const response = await pending;
    expect([403, 409]).toContain(response.status);
    expect(await db.shareLink.count({ where: { videoId: f.videoA.id } })).toBe(0);
    expect((await checkVideoAccess(f.videoA.id, f.a.id)).hasAccess).toBe(false);
  });
  it('does not read or modify a freshly reissued link after a delayed PATCH loses access', async () => {
    const f = await fixture();
    await db.projectFolderMember.update({
      where: { folderId_userId: { folderId: f.folderA.id, userId: f.a.id } },
      data: { role: 'ADMIN' },
    });
    signedInAs(f.a);
    const request = apiRequest(`/api/projects/${f.project.id}/videos/${f.videoA.id}/share`, {
      method: 'PATCH',
      body: { allowDownloads: true },
    });
    let freshId = '';
    vi.spyOn(request, 'json').mockImplementation(async () => {
      await db.video.update({ where: { id: f.videoA.id }, data: { accessMode: 'RESTRICTED' } });
      freshId = (
        await createShareLink({
          projectId: f.project.id,
          videoId: f.videoA.id,
          allowDownloads: false,
        })
      ).id;
      return { allowDownloads: true };
    });
    const response = await callRoute(patchShareVideo, request, {
      projectId: f.project.id,
      videoId: f.videoA.id,
    });
    expect(response.status).toBe(403);
    expect((await db.shareLink.findUniqueOrThrow({ where: { id: freshId } })).allowDownloads).toBe(
      false
    );
  });
  it('keeps public sibling invitees out of approval candidates and preserves safe search shape', async () => {
    const f = await fixture();
    await db.project.update({
      where: { id: f.project.id },
      data: { visibility: 'PUBLIC', name: 'Hidden campaign' },
    });
    const candidates = await getApprovalCandidatesForProject(f.project.id, f.root.id);
    expect(candidates?.map((candidate) => candidate.id)).toEqual([f.owner.id]);
    await db.project.update({ where: { id: f.project.id }, data: { visibility: 'PRIVATE' } });
    signedInAs(f.a);
    const response = await callRoute(search, apiRequest('/api/search?q=cut'));
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.videos).toEqual([
      {
        id: f.videoA.id,
        title: 'A cut',
        projectId: f.project.id,
        project: { id: f.project.id, name: 'Shared video' },
      },
    ]);
    expect(data.projects).toEqual([]);
  });
  it('defers the signup trial for accepted folder and video collaborators', async () => {
    const f = await fixture();
    await db.videoMember.create({ data: { videoId: f.videoB.id, userId: f.b.id } });
    await db.projectFolderMember.deleteMany({ where: { userId: f.b.id } });
    await db.user.updateMany({
      where: { id: { in: [f.a.id, f.b.id] } },
      data: { trialEndsAt: null, billingTrialConsumedAt: null },
    });
    await Promise.all([startCardlessTrialOnSignup(f.a.id), startCardlessTrialOnSignup(f.b.id)]);
    const users = await db.user.findMany({ where: { id: { in: [f.a.id, f.b.id] } } });
    expect(users).toHaveLength(2);
    for (const user of users) {
      expect(user.trialEndsAt).toBeNull();
      expect(user.billingTrialConsumedAt).toBeNull();
    }
  });
  it('prevents opposing folder moves from creating a cycle and validates the whole moved subtree depth', async () => {
    const f = await fixture();
    signedInAs(f.owner);
    const a = { action: 'move', folderId: f.folderA.id, parentId: f.folderB.id };
    const b = { action: 'move', folderId: f.folderB.id, parentId: f.folderA.id };
    const pa = (await (await action(f.project.id, a)).json()).data;
    const pb = (await (await action(f.project.id, b)).json()).data;
    const responses = await Promise.all([
      action(f.project.id, { ...a, confirmationToken: pa.confirmationToken }),
      action(f.project.id, { ...b, confirmationToken: pb.confirmationToken }),
    ]);
    expect(responses.some((response) => response.status === 200)).toBe(true);
    const [afterA, afterB] = await Promise.all([
      db.projectFolder.findUniqueOrThrow({ where: { id: f.folderA.id } }),
      db.projectFolder.findUniqueOrThrow({ where: { id: f.folderB.id } }),
    ]);
    const movedA = afterA.parentId === f.folderB.id;
    const movedB = afterB.parentId === f.folderA.id;
    expect(Number(movedA) + Number(movedB)).toBe(1);
    const winner = movedA ? 0 : 1;
    expect(responses[winner].status).toBe(200);
    expect((await responses[winner].json()).data).toMatchObject({
      id: winner === 0 ? f.folderA.id : f.folderB.id,
    });
    const loser = responses[1 - winner];
    if (loser.status === 200) expect((await loser.json()).data.needsConfirmation).toBe(true);
    else expect([400, 403, 409]).toContain(loser.status);
    let parentId: string | null = null;
    for (let i = 1; i <= 9; i++)
      parentId = (
        await db.projectFolder.create({
          data: { projectId: f.project.id, parentId, name: `Deep ${i}` },
        })
      ).id;
    const move = { action: 'move', folderId: f.folderA.id, parentId };
    const preview = (await (await action(f.project.id, move)).json()).data;
    const tooDeep = await action(f.project.id, {
      ...move,
      confirmationToken: preview.confirmationToken,
    });
    expect(tooDeep.status).toBe(400);
    expect(
      (await db.projectFolder.findUniqueOrThrow({ where: { id: f.folderA.id } })).parentId
    ).toBe(afterA.parentId);
  });
  it('serializes empty-folder deletion against child creation without orphaning content', async () => {
    const f = await fixture();
    signedInAs(f.owner);
    const empty = await db.projectFolder.create({
      data: { projectId: f.project.id, name: 'Race' },
    });
    const responses = await Promise.all([
      action(f.project.id, { action: 'delete', folderId: empty.id }),
      action(f.project.id, { action: 'create', folderId: empty.id, name: 'Racing child' }),
    ]);
    expect(responses.some((response) => response.status === 200)).toBe(true);
    const parent = await db.projectFolder.findUnique({ where: { id: empty.id } });
    const child = await db.projectFolder.findFirst({ where: { name: 'Racing child' } });
    if (child) expect(parent?.id).toBe(child.parentId);
    else expect(parent).toBeNull();
  });
});

describe('scoped Bunny cancellation', () => {
  it('allows revoked uploaders to cancel pending media but protects persisted versions and assets', async () => {
    const f = await fixture();
    vi.stubEnv('BUNNY_STREAM_API_KEY', 'test');
    vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '123');
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    signedInAs(f.a);
    await db.projectFolderMember.deleteMany({ where: { userId: f.a.id } });
    const request = (providerVideoId: string) =>
      callRoute(
        cancelBunnyUpload,
        apiRequest(`/api/projects/${f.project.id}/videos/bunny-init`, {
          method: 'DELETE',
          body: {
            videoId: providerVideoId,
            uploadToken: createBunnyUploadToken({
              userId: f.a.id,
              projectId: f.project.id,
              videoId: providerVideoId,
            }),
          },
        }),
        { projectId: f.project.id }
      );
    expect((await request('pending-bunny-video')).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const version = await createVersion({
      videoParentId: f.videoA.id,
      providerId: 'bunny',
      providerVideoId: 'attached-bunny-version',
    });
    expect((await request('attached-bunny-version')).status).toBe(409);
    const asset = await createVideoAsset({
      videoId: f.videoA.id,
      billedUserId: f.owner.id,
      provider: 'BUNNY',
      providerVideoId: 'attached-bunny-asset',
    });
    expect((await request('attached-bunny-asset')).status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.videoVersion.findUnique({ where: { id: version.id } })).not.toBeNull();
    expect(await db.videoAsset.findUnique({ where: { id: asset.id } })).not.toBeNull();
  });
});
