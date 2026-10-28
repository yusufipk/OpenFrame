import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  checkFolderAccess,
  checkVideoAccess,
  visibleFolderWhere,
  visibleVideoWhere,
} from '@/lib/content-access';
import * as foldersRoute from '@/app/api/projects/[projectId]/folders/route';
import * as videosRoute from '@/app/api/projects/[projectId]/videos/route';
import * as watchRoute from '@/app/api/watch/[videoId]/route';
import { POST as createComment } from '@/app/api/versions/[versionId]/comments/route';
import {
  createUser,
  createWorkspace,
  createProject,
  createVideo,
  createVersion,
  createShareLink,
} from '../factories';
import { signedInAs, signedOut } from '../helpers/session';
import { apiRequest, callRoute } from '../helpers/request';

// A private project with one public folder. Inside it an inherited child folder holds the
// cut a client is meant to see, and a restricted child holds one they are not.
async function fixture() {
  const [owner, outsider] = await Promise.all([createUser(), createUser()]);
  const workspace = await createWorkspace({ ownerId: owner.id });
  const project = await createProject({ workspaceId: workspace.id, ownerId: owner.id });
  const shared = await db.projectFolder.create({
    data: { projectId: project.id, name: 'Client review', accessMode: 'PUBLIC' },
  });
  const [child, locked, sibling] = await Promise.all([
    db.projectFolder.create({
      data: { projectId: project.id, parentId: shared.id, name: 'Round 2' },
    }),
    db.projectFolder.create({
      data: {
        projectId: project.id,
        parentId: shared.id,
        name: 'Internal',
        accessMode: 'RESTRICTED',
      },
    }),
    db.projectFolder.create({ data: { projectId: project.id, name: 'Other client' } }),
  ]);
  const [cut, secret, other, root] = await Promise.all([
    db.video.create({ data: { projectId: project.id, folderId: child.id, title: 'Client cut' } }),
    db.video.create({
      data: { projectId: project.id, folderId: locked.id, title: 'Internal cut' },
    }),
    db.video.create({ data: { projectId: project.id, folderId: sibling.id, title: 'Other cut' } }),
    createVideo({ projectId: project.id, title: 'Root cut' }),
  ]);
  const version = await createVersion({ videoParentId: cut.id });
  return { owner, outsider, project, shared, child, locked, sibling, cut, secret, other, root, version };
}

async function action(projectId: string, body: object) {
  return callRoute(foldersRoute.POST, apiRequest(`/api/projects/${projectId}/folders`, { body }), {
    projectId,
  });
}

async function modeOf(folderId: string) {
  return (await db.projectFolder.findUniqueOrThrow({ where: { id: folderId } })).accessMode;
}

describe('public folders', () => {
  it('opens the public subtree to signed-out and unrelated visitors and nothing else', async () => {
    const f = await fixture();
    for (const viewer of [undefined, f.outsider.id]) {
      const videos = await db.video.findMany({
        where: visibleVideoWhere(viewer),
        select: { title: true },
        orderBy: { title: 'asc' },
      });
      expect(videos.map((v) => v.title)).toEqual(['Client cut']);
      const folders = await db.projectFolder.findMany({
        where: visibleFolderWhere(viewer),
        select: { name: true },
        orderBy: { name: 'asc' },
      });
      expect(folders.map((folder) => folder.name)).toEqual(['Client review', 'Round 2']);
      expect((await checkVideoAccess(f.cut.id, viewer)).hasAccess).toBe(true);
      expect((await checkVideoAccess(f.cut.id, viewer)).canEdit).toBe(false);
      expect((await checkVideoAccess(f.secret.id, viewer)).hasAccess).toBe(false);
      expect((await checkVideoAccess(f.other.id, viewer)).hasAccess).toBe(false);
      expect((await checkVideoAccess(f.root.id, viewer)).hasAccess).toBe(false);
      const folder = await checkFolderAccess(f.project.id, f.shared.id, viewer);
      expect(folder?.hasAccess).toBe(true);
      expect(folder?.canEdit).toBe(false);
      expect((await checkFolderAccess(f.project.id, null, viewer))?.hasAccess).toBe(false);
    }
  });

  it('serves the public cut over HTTP to a signed-out visitor and refuses the rest', async () => {
    const f = await fixture();
    signedOut();
    const watch = (videoId: string) =>
      callRoute(watchRoute.GET, apiRequest(`/api/watch/${videoId}`), { videoId });
    expect((await watch(f.cut.id)).status).toBe(200);
    expect((await watch(f.secret.id)).status).toBe(403);
    expect((await watch(f.root.id)).status).toBe(403);
    const list = (folderId?: string) =>
      callRoute(
        videosRoute.GET,
        apiRequest(
          `/api/projects/${f.project.id}/videos${folderId ? `?folderId=${folderId}` : ''}`
        ),
        { projectId: f.project.id }
      );
    const listed = await list(f.child.id);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain(f.cut.id);
    expect((await list()).status).toBe(403);
    expect((await list(f.locked.id)).status).toBe(403);
  });

  it('lets a signed-out visitor comment on a public cut as a guest', async () => {
    const f = await fixture();
    signedOut();
    const response = await callRoute(
      createComment,
      apiRequest(`/api/versions/${f.version.id}/comments`, {
        body: { content: 'Love the opening', timestamp: 1, guestName: 'Client' },
      }),
      { versionId: f.version.id }
    );
    expect(response.status).toBe(201);
    const stored = await db.comment.findFirstOrThrow({ where: { versionId: f.version.id } });
    expect(stored.authorId).toBeNull();
    expect(stored.guestName).toBe('Client');
  });

  it('closes the folder again the moment it stops being public', async () => {
    const f = await fixture();
    await db.projectFolder.update({ where: { id: f.shared.id }, data: { accessMode: 'INHERIT' } });
    expect((await checkVideoAccess(f.cut.id)).hasAccess).toBe(false);
    expect(await db.video.count({ where: visibleVideoWhere() })).toBe(0);
  });

  it('stays closed while the workspace owner has no billing access', async () => {
    const f = await fixture();
    await db.user.update({
      where: { id: f.owner.id },
      data: { trialEndsAt: new Date(0), billingAccessEndedAt: new Date(0) },
    });
    expect((await checkVideoAccess(f.cut.id)).hasAccess).toBe(false);
    expect(await db.video.count({ where: visibleVideoWhere() })).toBe(0);
    expect(await db.projectFolder.count({ where: visibleFolderWhere() })).toBe(0);
  });

  it('leaves public content out of approval candidates and search', async () => {
    const f = await fixture();
    expect(await db.video.count({ where: visibleVideoWhere(f.outsider.id, false, false) })).toBe(
      0
    );
    expect(await db.video.count({ where: visibleVideoWhere(f.outsider.id, true) })).toBe(0);
  });
});

describe('making a folder public', () => {
  it('refuses a signed-out caller and a folder commentator without changing the folder', async () => {
    const f = await fixture();
    await db.projectFolder.update({ where: { id: f.sibling.id }, data: { accessMode: 'INHERIT' } });
    const commentator = await createUser();
    await db.projectFolderMember.create({
      data: { folderId: f.sibling.id, userId: commentator.id, role: 'COMMENTATOR' },
    });
    const body = { action: 'access', folderId: f.sibling.id, accessMode: 'PUBLIC' };
    signedOut();
    expect((await action(f.project.id, body)).status).toBe(401);
    signedInAs(commentator);
    expect((await action(f.project.id, body)).status).toBe(403);
    signedInAs(f.outsider);
    expect((await action(f.project.id, body)).status).toBe(403);
    expect(await modeOf(f.sibling.id)).toBe('INHERIT');
  });

  it('refuses PUBLIC on a single video', async () => {
    const f = await fixture();
    signedInAs(f.owner);
    const response = await action(f.project.id, {
      action: 'access',
      videoId: f.root.id,
      accessMode: 'PUBLIC',
    });
    expect(response.status).toBe(400);
    expect((await db.video.findUniqueOrThrow({ where: { id: f.root.id } })).accessMode).toBe(
      'INHERIT'
    );
  });

  it('asks for confirmation, then opens the folder and keeps its video links', async () => {
    const f = await fixture();
    const link = await createShareLink({ projectId: f.project.id, videoId: f.other.id });
    signedInAs(f.owner);
    const body = { action: 'access', folderId: f.sibling.id, accessMode: 'PUBLIC' };
    const preview = await (await action(f.project.id, body)).json();
    expect(preview.data.needsConfirmation).toBe(true);
    expect(preview.data.message).toBe(
      'Anyone with the link can view and comment, without an account.'
    );
    expect(await modeOf(f.sibling.id)).toBe('INHERIT');
    const confirmed = await action(f.project.id, {
      ...body,
      confirmationToken: preview.data.confirmationToken,
    });
    expect(confirmed.status).toBe(200);
    expect(await modeOf(f.sibling.id)).toBe('PUBLIC');
    expect((await checkVideoAccess(f.other.id)).hasAccess).toBe(true);
    expect(await db.shareLink.findUnique({ where: { id: link.id } })).not.toBeNull();
    const members = await (
      await action(f.project.id, { action: 'members', folderId: f.sibling.id })
    ).json();
    expect(members.data.accessMode).toBe('PUBLIC');
  });

  it('still revokes video links when a public folder becomes restricted', async () => {
    const f = await fixture();
    const link = await createShareLink({ projectId: f.project.id, videoId: f.cut.id });
    signedInAs(f.owner);
    const body = { action: 'access', folderId: f.shared.id, accessMode: 'RESTRICTED' };
    const preview = await (await action(f.project.id, body)).json();
    expect(preview.data.message).toBe(
      'Owners and admins keep access. 1 existing video link will be revoked.'
    );
    await action(f.project.id, { ...body, confirmationToken: preview.data.confirmationToken });
    expect(await modeOf(f.shared.id)).toBe('RESTRICTED');
    expect(await db.shareLink.findUnique({ where: { id: link.id } })).toBeNull();
    expect((await checkVideoAccess(f.cut.id)).hasAccess).toBe(false);
  });
});
