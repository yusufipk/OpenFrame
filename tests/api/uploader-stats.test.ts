// How many people upload inside an account, as the admin users table and the
// growth scoreboard show it.

import { describe, expect, it } from 'vitest';
import {
  getTeamUploadersByAccount,
  getUploaderCountsByAccount,
  uploaderWindowStart,
} from '@/lib/uploader-stats';
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
  it('counts each collaborator once per account and excludes the workspace owner', async () => {
    const { owner, project } = await seedProject();
    const secondWorkspace = await createWorkspace({ ownerId: owner.id });
    const secondProject = await createProject({
      ownerId: owner.id,
      workspaceId: secondWorkspace.id,
    });
    const editor = await createUser({ name: 'Editor', email: 'editor@example.com' });
    const colorist = await createUser({ name: 'Colorist', email: 'colorist@example.com' });

    const first = await createVideo({ projectId: project.id });
    const second = await createVideo({ projectId: secondProject.id });
    await createVersion({ videoParentId: first.id, versionNumber: 1, uploadedById: owner.id });
    await createVersion({ videoParentId: first.id, versionNumber: 2, uploadedById: editor.id });
    // The same editor again, in the owner's other workspace: still one person.
    await createVersion({ videoParentId: second.id, versionNumber: 1, uploadedById: editor.id });
    await createVersion({ videoParentId: second.id, versionNumber: 2, uploadedById: colorist.id });

    const counts = await getUploaderCountsByAccount(uploaderWindowStart());

    expect(counts).toEqual({ [owner.id]: 2 });
    expect(await getTeamUploadersByAccount(uploaderWindowStart())).toEqual({
      [owner.id]: [
        { userId: colorist.id, name: 'Colorist', email: 'colorist@example.com' },
        { userId: editor.id, name: 'Editor', email: 'editor@example.com' },
      ],
    });
  });

  it('reports no team uploaders when only the workspace owner uploads', async () => {
    const { owner, project } = await seedProject();
    const video = await createVideo({ projectId: project.id });
    await createVersion({ videoParentId: video.id, uploadedById: owner.id });

    expect(await getUploaderCountsByAccount(uploaderWindowStart())).toEqual({});
    expect(await getTeamUploadersByAccount(uploaderWindowStart())).toEqual({});
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

    expect(counts).toEqual({ [owner.id]: 1 });
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

  it('counts an owner as a collaborator only when uploading to another account', async () => {
    const first = await seedProject();
    const second = await seedProject();
    const ownVideo = await createVideo({ projectId: first.project.id });
    const teamVideo = await createVideo({ projectId: second.project.id });
    await createVersion({ videoParentId: ownVideo.id, uploadedById: first.owner.id });
    await createVersion({ videoParentId: teamVideo.id, uploadedById: first.owner.id });

    expect(await getUploaderCountsByAccount(uploaderWindowStart())).toEqual({
      [second.owner.id]: 1,
    });
    expect(await getTeamUploadersByAccount(uploaderWindowStart())).toEqual({
      [second.owner.id]: [
        { userId: first.owner.id, name: first.owner.name, email: first.owner.email },
      ],
    });
  });
});

describe('scoreboard uploaders', () => {
  it('reports team uploaders for each paid account, excluding its owner', async () => {
    const { owner, project } = await seedProject({ owner: { subscriptionStatus: 'ACTIVE' } });
    const quiet = await createUser({ subscriptionStatus: 'ACTIVE' });
    const editor = await createUser();
    const video = await createVideo({ projectId: project.id });
    await createVersion({ videoParentId: video.id, versionNumber: 1, uploadedById: owner.id });
    await createVersion({ videoParentId: video.id, versionNumber: 2, uploadedById: editor.id });

    const scoreboard = await getScoreboard({ weeks: 1 });
    const rowFor = (userId: string) => scoreboard.paidAccounts.find((row) => row.userId === userId);

    expect(rowFor(owner.id)?.uploaders30).toBe(1);
    expect(rowFor(owner.id)?.teamUploaders30).toEqual([
      { userId: editor.id, name: editor.name, email: editor.email },
    ]);
    expect(rowFor(quiet.id)?.uploaders30).toBe(0);
    expect(rowFor(quiet.id)?.teamUploaders30).toEqual([]);
  });
});
