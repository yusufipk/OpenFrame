import { describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { checkVideoAccess, visibleVideoWhere } from '@/lib/content-access';
import {
  addProjectMember,
  addWorkspaceMember,
  createProject,
  createUser,
  createVideo,
  createWorkspace,
} from '../factories';

async function expectVideoRights(
  videoId: string,
  userId: string | undefined,
  expected: { hasAccess: boolean; canEdit: boolean }
) {
  const [access, visible, editable] = await Promise.all([
    checkVideoAccess(videoId, userId),
    db.video.count({ where: { id: videoId, AND: visibleVideoWhere(userId) } }),
    db.video.count({ where: { id: videoId, AND: visibleVideoWhere(userId, true) } }),
  ]);
  expect({ hasAccess: access.hasAccess, canEdit: access.canEdit }).toEqual(expected);
  expect(access.hasAccess).toBe(visible > 0);
  expect(access.canEdit).toBe(editable > 0);
  if (!access.canManageProject) expect(access.canDelete).toBe(access.canEdit);
}

describe('checkVideoAccess narrow permission lookup', () => {
  it('does not expand list filters when checking a flat video for a commentator', async () => {
    const [owner, viewer] = await Promise.all([createUser(), createUser()]);
    const workspace = await createWorkspace({ ownerId: owner.id });
    const project = await createProject({ workspaceId: workspace.id, ownerId: owner.id });
    const video = await createVideo({ projectId: project.id });
    await addProjectMember({ projectId: project.id, userId: viewer.id });

    const count = vi.spyOn(db.video, 'count');
    try {
      const access = await checkVideoAccess(video.id, viewer.id);
      expect(access.hasAccess).toBe(true);
      expect(access.canEdit).toBe(false);
      expect(count).not.toHaveBeenCalled();
    } finally {
      count.mockRestore();
    }
  });

  it('matches the list filter for public, project and workspace audiences', async () => {
    const [owner, viewer, manager] = await Promise.all([createUser(), createUser(), createUser()]);
    const workspace = await createWorkspace({ ownerId: owner.id });
    const project = await createProject({ workspaceId: workspace.id, ownerId: owner.id });
    const video = await createVideo({ projectId: project.id });

    await expectVideoRights(video.id, undefined, { hasAccess: false, canEdit: false });
    await expectVideoRights(video.id, viewer.id, { hasAccess: false, canEdit: false });
    await db.project.update({ where: { id: project.id }, data: { visibility: 'PUBLIC' } });
    await expectVideoRights(video.id, undefined, { hasAccess: true, canEdit: false });
    await db.project.update({ where: { id: project.id }, data: { visibility: 'PRIVATE' } });
    await addProjectMember({ projectId: project.id, userId: viewer.id });
    await expectVideoRights(video.id, viewer.id, { hasAccess: true, canEdit: false });
    await db.projectMember.deleteMany({ where: { projectId: project.id, userId: viewer.id } });
    await addWorkspaceMember({ workspaceId: workspace.id, userId: viewer.id });
    await expectVideoRights(video.id, viewer.id, { hasAccess: true, canEdit: false });
    await addProjectMember({ projectId: project.id, userId: manager.id, role: 'ADMIN' });
    await expectVideoRights(video.id, manager.id, { hasAccess: true, canEdit: true });
    await expectVideoRights(video.id, owner.id, { hasAccess: true, canEdit: true });
  });

  it('combines direct and inherited grants, then reflects revocation and billing loss', async () => {
    const [owner, viewer] = await Promise.all([createUser(), createUser()]);
    const workspace = await createWorkspace({ ownerId: owner.id });
    const project = await createProject({ workspaceId: workspace.id, ownerId: owner.id });
    const parent = await db.projectFolder.create({
      data: { projectId: project.id, name: 'Parent', accessMode: 'RESTRICTED' },
    });
    const child = await db.projectFolder.create({
      data: { projectId: project.id, parentId: parent.id, name: 'Child' },
    });
    const video = await db.video.create({
      data: { projectId: project.id, folderId: child.id, title: 'Restricted ancestry' },
    });

    await expectVideoRights(video.id, viewer.id, { hasAccess: false, canEdit: false });
    await db.projectFolderMember.create({
      data: { folderId: parent.id, userId: viewer.id, role: 'COMMENTATOR' },
    });
    await expectVideoRights(video.id, viewer.id, { hasAccess: true, canEdit: false });
    await db.projectFolderMember.create({
      data: { folderId: child.id, userId: viewer.id, role: 'COMMENTATOR' },
    });
    await db.projectFolderMember.update({
      where: { folderId_userId: { folderId: parent.id, userId: viewer.id } },
      data: { role: 'ADMIN' },
    });
    await expectVideoRights(video.id, viewer.id, { hasAccess: true, canEdit: true });
    await db.projectFolderMember.update({
      where: { folderId_userId: { folderId: parent.id, userId: viewer.id } },
      data: { role: 'COMMENTATOR' },
    });
    await db.projectFolderMember.delete({
      where: { folderId_userId: { folderId: child.id, userId: viewer.id } },
    });
    await db.projectFolder.update({
      where: { id: child.id },
      data: { accessMode: 'RESTRICTED' },
    });
    await expectVideoRights(video.id, viewer.id, { hasAccess: false, canEdit: false });
    await db.videoMember.create({
      data: { videoId: video.id, userId: viewer.id, role: 'ADMIN' },
    });
    await expectVideoRights(video.id, viewer.id, { hasAccess: true, canEdit: true });
    await db.video.update({ where: { id: video.id }, data: { accessMode: 'RESTRICTED' } });
    await expectVideoRights(video.id, viewer.id, { hasAccess: true, canEdit: true });
    await db.videoMember.deleteMany({ where: { videoId: video.id, userId: viewer.id } });
    await expectVideoRights(video.id, viewer.id, { hasAccess: false, canEdit: false });
    await db.videoMember.create({
      data: { videoId: video.id, userId: viewer.id, role: 'ADMIN' },
    });
    await db.user.update({
      where: { id: owner.id },
      data: { trialEndsAt: new Date(0), billingAccessEndedAt: new Date(0) },
    });
    await expectVideoRights(video.id, viewer.id, { hasAccess: false, canEdit: false });
  });

  it('resolves inheritance and direct grants at the tenth folder level', async () => {
    const [owner, viewer] = await Promise.all([createUser(), createUser()]);
    const workspace = await createWorkspace({ ownerId: owner.id });
    const project = await createProject({
      workspaceId: workspace.id,
      ownerId: owner.id,
      visibility: 'PUBLIC',
    });
    let parentId: string | null = null;
    let rootId = '';
    let leafId = '';
    for (let level = 1; level <= 10; level++) {
      const folder: { id: string } = await db.projectFolder.create({
        data: { projectId: project.id, parentId, name: `Level ${level}` },
      });
      if (level === 1) rootId = folder.id;
      if (level === 10) leafId = folder.id;
      parentId = folder.id;
    }
    const video = await db.video.create({
      data: { projectId: project.id, folderId: leafId, title: 'Deep video' },
    });

    await expectVideoRights(video.id, undefined, { hasAccess: true, canEdit: false });
    await db.projectFolder.update({
      where: { id: rootId },
      data: { accessMode: 'RESTRICTED' },
    });
    await expectVideoRights(video.id, undefined, { hasAccess: false, canEdit: false });
    await db.projectFolderMember.create({
      data: { folderId: rootId, userId: viewer.id, role: 'ADMIN' },
    });
    await expectVideoRights(video.id, viewer.id, { hasAccess: true, canEdit: true });
  });
});
