// How many people upload inside an account, as the admin users table and the
// growth scoreboard show it.

import { describe, expect, it } from 'vitest';
import { getUploaderCountsByAccount, uploaderWindowStart } from '@/lib/uploader-stats';
import { getScoreboard } from '@/lib/analytics/scoreboard';
import {
  createProject,
  createUser,
  createVersion,
  createVideo,
  createWorkspace,
  seedProject,
} from '../factories';

const DAY = 24 * 60 * 60 * 1000;

describe('getUploaderCountsByAccount', () => {
  it('counts each person once per account, across its workspaces and projects', async () => {
    const { owner, project } = await seedProject();
    const secondWorkspace = await createWorkspace({ ownerId: owner.id });
    const secondProject = await createProject({
      ownerId: owner.id,
      workspaceId: secondWorkspace.id,
    });
    const editor = await createUser();
    const colorist = await createUser();

    const first = await createVideo({ projectId: project.id });
    const second = await createVideo({ projectId: secondProject.id });
    await createVersion({ videoParentId: first.id, versionNumber: 1, uploadedById: owner.id });
    await createVersion({ videoParentId: first.id, versionNumber: 2, uploadedById: editor.id });
    // The same editor again, in the owner's other workspace: still one person.
    await createVersion({ videoParentId: second.id, versionNumber: 1, uploadedById: editor.id });
    await createVersion({ videoParentId: second.id, versionNumber: 2, uploadedById: colorist.id });

    const counts = await getUploaderCountsByAccount(uploaderWindowStart());

    expect(counts).toEqual({ [owner.id]: 3 });
  });

  it('skips versions with no recorded uploader and versions older than the window', async () => {
    const { owner, project } = await seedProject();
    const editor = await createUser();
    const lateInWindow = await createUser();
    const video = await createVideo({ projectId: project.id });
    await createVersion({ videoParentId: video.id, versionNumber: 1, uploadedById: null });
    await createVersion({
      videoParentId: video.id,
      versionNumber: 2,
      uploadedById: editor.id,
      createdAt: new Date(Date.now() - 31 * DAY),
    });
    // Inside the 30 days, so a window that shrank would drop this one.
    await createVersion({
      videoParentId: video.id,
      versionNumber: 3,
      uploadedById: lateInWindow.id,
      createdAt: new Date(Date.now() - 29 * DAY),
    });
    await createVersion({ videoParentId: video.id, versionNumber: 4, uploadedById: owner.id });

    const counts = await getUploaderCountsByAccount(uploaderWindowStart());

    expect(counts).toEqual({ [owner.id]: 2 });
  });

  it('credits an upload to the workspace owner, not to the project owner', async () => {
    const workspaceOwner = await createUser();
    const projectOwner = await createUser();
    const workspace = await createWorkspace({ ownerId: workspaceOwner.id });
    const project = await createProject({ ownerId: projectOwner.id, workspaceId: workspace.id });
    const video = await createVideo({ projectId: project.id });
    await createVersion({ videoParentId: video.id, uploadedById: projectOwner.id });

    const counts = await getUploaderCountsByAccount(uploaderWindowStart());

    expect(counts).toEqual({ [workspaceOwner.id]: 1 });
  });
});

describe('scoreboard uploaders', () => {
  it('reports the uploaders of each paid account, and zero for one with none', async () => {
    const { owner, project } = await seedProject({ owner: { subscriptionStatus: 'ACTIVE' } });
    const quiet = await createUser({ subscriptionStatus: 'ACTIVE' });
    const editor = await createUser();
    const video = await createVideo({ projectId: project.id });
    await createVersion({ videoParentId: video.id, versionNumber: 1, uploadedById: owner.id });
    await createVersion({ videoParentId: video.id, versionNumber: 2, uploadedById: editor.id });

    const scoreboard = await getScoreboard({ weeks: 1 });
    const rowFor = (userId: string) => scoreboard.paidAccounts.find((row) => row.userId === userId);

    expect(rowFor(owner.id)?.uploaders30).toBe(2);
    expect(rowFor(quiet.id)?.uploaders30).toBe(0);
  });
});
