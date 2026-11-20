// Who hears about activity on a video. The audience is everyone who can open
// it and has a channel switched on, never the person who caused the event, and
// never someone a restricted folder keeps out: a notification carries the
// title and the comment text, so sending it past the folder's walls would leak
// what the folder hides.

import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { getVideoNotificationRecipients } from '@/lib/notifications';
import {
  addProjectMember,
  addWorkspaceMember,
  createUser,
  createVideo,
  seedProject,
} from '../factories';

async function withEmailOn(...userIds: string[]) {
  await db.notificationSetting.createMany({
    data: userIds.map((userId) => ({ userId, emailEnabled: true })),
  });
}

describe('getVideoNotificationRecipients', () => {
  it('includes project and workspace members and leaves out the actor', async () => {
    const { owner, workspace, project } = await seedProject();
    const [projectAdmin, workspaceMember] = await Promise.all([createUser(), createUser()]);
    await addProjectMember({ projectId: project.id, userId: projectAdmin.id, role: 'ADMIN' });
    await addWorkspaceMember({ workspaceId: workspace.id, userId: workspaceMember.id });
    await withEmailOn(owner.id, projectAdmin.id, workspaceMember.id);
    const video = await createVideo({ projectId: project.id });

    const fromOwner = await getVideoNotificationRecipients(project.id, video.id, owner.id);
    expect(fromOwner.sort()).toEqual([projectAdmin.id, workspaceMember.id].sort());

    const fromAdmin = await getVideoNotificationRecipients(project.id, video.id, projectAdmin.id);
    expect(fromAdmin.sort()).toEqual([owner.id, workspaceMember.id].sort());
  });

  it('notifies everyone, owner included, when a guest is the actor', async () => {
    const { owner, project } = await seedProject();
    const editor = await createUser();
    await addProjectMember({ projectId: project.id, userId: editor.id, role: 'ADMIN' });
    await withEmailOn(owner.id, editor.id);
    const video = await createVideo({ projectId: project.id });

    const recipients = await getVideoNotificationRecipients(project.id, video.id, null);
    expect(recipients.sort()).toEqual([owner.id, editor.id].sort());
  });

  it('skips members with no notification channel switched on', async () => {
    const { owner, project } = await seedProject();
    const quiet = await createUser();
    await addProjectMember({ projectId: project.id, userId: quiet.id });
    await db.notificationSetting.create({ data: { userId: quiet.id, emailEnabled: false } });
    const video = await createVideo({ projectId: project.id });

    expect(await getVideoNotificationRecipients(project.id, video.id, owner.id)).toEqual([]);
  });

  it('keeps a restricted folder’s video to the people the folder admits', async () => {
    const { owner, project } = await seedProject();
    const [outsider, folderMember] = await Promise.all([createUser(), createUser()]);
    await addProjectMember({ projectId: project.id, userId: outsider.id });
    await withEmailOn(outsider.id, folderMember.id);
    const folder = await db.projectFolder.create({
      data: { projectId: project.id, name: 'Private', accessMode: 'RESTRICTED' },
    });
    await db.projectFolderMember.create({ data: { folderId: folder.id, userId: folderMember.id } });
    const hidden = await db.video.create({
      data: { projectId: project.id, folderId: folder.id, title: 'Hidden cut' },
    });

    const recipients = await getVideoNotificationRecipients(project.id, hidden.id, owner.id);
    expect(recipients).toEqual([folderMember.id]);
    expect(recipients).not.toContain(outsider.id);
  });

  it('returns nobody for a project that does not exist', async () => {
    expect(await getVideoNotificationRecipients('missing', 'missing', null)).toEqual([]);
  });
});
