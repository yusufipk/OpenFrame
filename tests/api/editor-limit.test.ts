import { describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';
import { db } from '@/lib/db';
import { POST as inviteWorkspaceMember } from '@/app/api/workspaces/[workspaceId]/members/route';
import { PATCH as patchWorkspaceMember } from '@/app/api/workspaces/[workspaceId]/members/[memberId]/route';
import { POST as inviteProjectMember } from '@/app/api/projects/[projectId]/members/route';
import { PATCH as patchProjectMember } from '@/app/api/projects/[projectId]/members/[memberId]/route';
import { POST as folderAction } from '@/app/api/projects/[projectId]/folders/route';
import { acceptInvitationTokenForUser } from '@/lib/invitations';
import { listAccountEditorIds } from '@/lib/account-editors';
import { apiRequest, callRoute } from '../helpers/request';
import { signedInAs } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createInvitation,
  createSubscribedUser,
  createUser,
  createVideo,
  seedProject,
} from '../factories';

type Account = 'solo' | 'studio' | 'founding' | 'trial';

/** An owner on the given footing, with one workspace and one project. */
async function accountScenario(account: Account) {
  let owner: User;
  if (account === 'trial') {
    owner = await createUser();
  } else {
    owner = await createSubscribedUser();
    if (account === 'studio') {
      owner = await db.user.update({ where: { id: owner.id }, data: { billingPlan: 'STUDIO' } });
    }
    if (account === 'founding') {
      owner = await db.user.update({
        where: { id: owner.id },
        data: { foundingSubscriptionId: owner.stripeSubscriptionId },
      });
    }
  }
  const scenario = await seedProject({ ownerUser: owner });
  const folder = await db.projectFolder.create({
    data: { projectId: scenario.project.id, name: 'Cuts' },
  });
  const video = await createVideo({ projectId: scenario.project.id });
  return { ...scenario, folder, video };
}

function inviteToWorkspace(workspaceId: string, email: string, role: string) {
  return callRoute(
    inviteWorkspaceMember,
    apiRequest(`/api/workspaces/${workspaceId}/members`, { body: { email, role } }),
    { workspaceId }
  );
}

function inviteToProject(projectId: string, email: string, role: string) {
  return callRoute(
    inviteProjectMember,
    apiRequest(`/api/projects/${projectId}/members`, { body: { email, role } }),
    { projectId }
  );
}

function inviteToContent(
  projectId: string,
  target: { folderId: string } | { videoId: string },
  email: string,
  role: string
) {
  return callRoute(
    folderAction,
    apiRequest(`/api/projects/${projectId}/folders`, {
      body: { action: 'invite', ...target, email, role },
    }),
    { projectId }
  );
}

async function pendingInvitationCount(email: string) {
  return db.invitation.count({ where: { email, status: 'PENDING' } });
}

describe('editor limit on Solo', () => {
  it('refuses an ADMIN invitation at the workspace level and records none', async () => {
    const s = await accountScenario('solo');
    signedInAs(s.owner);

    const response = await inviteToWorkspace(s.workspace.id, 'editor@example.com', 'ADMIN');

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('EDITOR_LIMIT_REACHED');
    expect(await pendingInvitationCount('editor@example.com')).toBe(0);
  });

  it('refuses an ADMIN invitation at the project level and records none', async () => {
    const s = await accountScenario('solo');
    signedInAs(s.owner);

    const response = await inviteToProject(s.project.id, 'editor@example.com', 'ADMIN');

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('EDITOR_LIMIT_REACHED');
    expect(await pendingInvitationCount('editor@example.com')).toBe(0);
  });

  it('refuses an ADMIN invitation at the folder level and records none', async () => {
    const s = await accountScenario('solo');
    signedInAs(s.owner);

    const response = await inviteToContent(
      s.project.id,
      { folderId: s.folder.id },
      'editor@example.com',
      'ADMIN'
    );

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('EDITOR_LIMIT_REACHED');
    expect(await pendingInvitationCount('editor@example.com')).toBe(0);
  });

  it('refuses an ADMIN invitation at the video level and records none', async () => {
    const s = await accountScenario('solo');
    signedInAs(s.owner);

    const response = await inviteToContent(
      s.project.id,
      { videoId: s.video.id },
      'editor@example.com',
      'ADMIN'
    );

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('EDITOR_LIMIT_REACHED');
    expect(await pendingInvitationCount('editor@example.com')).toBe(0);
  });

  it('never limits a COMMENTATOR invitation, at any of the four levels', async () => {
    const s = await accountScenario('solo');
    signedInAs(s.owner);

    const responses = [
      await inviteToWorkspace(s.workspace.id, 'r1@example.com', 'COMMENTATOR'),
      await inviteToProject(s.project.id, 'r2@example.com', 'COMMENTATOR'),
      await inviteToContent(
        s.project.id,
        { folderId: s.folder.id },
        'r3@example.com',
        'COMMENTATOR'
      ),
      await inviteToContent(s.project.id, { videoId: s.video.id }, 'r4@example.com', 'COMMENTATOR'),
    ];

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(
      await db.invitation.count({
        where: {
          email: { in: ['r1@example.com', 'r2@example.com', 'r3@example.com', 'r4@example.com'] },
          status: 'PENDING',
          role: 'COMMENTATOR',
        },
      })
    ).toBe(4);
  });

  it('refuses promoting a workspace COMMENTATOR to ADMIN and leaves the role as it was', async () => {
    const s = await accountScenario('solo');
    const reviewer = await createUser();
    const member = await addWorkspaceMember({ workspaceId: s.workspace.id, userId: reviewer.id });
    signedInAs(s.owner);

    const response = await callRoute(
      patchWorkspaceMember,
      apiRequest(`/api/workspaces/${s.workspace.id}/members/${member.id}`, {
        method: 'PATCH',
        body: { role: 'ADMIN' },
      }),
      { workspaceId: s.workspace.id, memberId: member.id }
    );

    expect(response.status).toBe(403);
    expect((await db.workspaceMember.findUniqueOrThrow({ where: { id: member.id } })).role).toBe(
      'COMMENTATOR'
    );
  });

  it('refuses promoting a project COMMENTATOR to ADMIN and leaves the role as it was', async () => {
    const s = await accountScenario('solo');
    const reviewer = await createUser();
    const member = await addProjectMember({ projectId: s.project.id, userId: reviewer.id });
    signedInAs(s.owner);

    const response = await callRoute(
      patchProjectMember,
      apiRequest(`/api/projects/${s.project.id}/members/${member.id}`, {
        method: 'PATCH',
        body: { role: 'ADMIN' },
      }),
      { projectId: s.project.id, memberId: member.id }
    );

    expect(response.status).toBe(403);
    expect((await db.projectMember.findUniqueOrThrow({ where: { id: member.id } })).role).toBe(
      'COMMENTATOR'
    );
  });

  it('still allows demoting an ADMIN to COMMENTATOR', async () => {
    const s = await accountScenario('solo');
    const legacyEditor = await createUser();
    const member = await addWorkspaceMember({
      workspaceId: s.workspace.id,
      userId: legacyEditor.id,
      role: 'ADMIN',
    });
    signedInAs(s.owner);

    const response = await callRoute(
      patchWorkspaceMember,
      apiRequest(`/api/workspaces/${s.workspace.id}/members/${member.id}`, {
        method: 'PATCH',
        body: { role: 'COMMENTATOR' },
      }),
      { workspaceId: s.workspace.id, memberId: member.id }
    );

    expect(response.status).toBe(200);
    expect((await db.workspaceMember.findUniqueOrThrow({ where: { id: member.id } })).role).toBe(
      'COMMENTATOR'
    );
  });

  it('refuses accepting a pending ADMIN invitation on Solo, and keeps it pending', async () => {
    const s = await accountScenario('solo');
    const invitee = await createUser();
    const invitation = await createInvitation({
      invitedById: s.owner.id,
      email: invitee.email!,
      scope: 'WORKSPACE',
      role: 'ADMIN',
      workspaceId: s.workspace.id,
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: invitee.id,
      email: invitee.email!,
    });

    expect(result).toBe('editor_limit');
    expect(await db.workspaceMember.count({ where: { userId: invitee.id } })).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'PENDING'
    );
  });

  it('accepts a COMMENTATOR invitation on Solo', async () => {
    const s = await accountScenario('solo');
    const invitee = await createUser();
    const invitation = await createInvitation({
      invitedById: s.owner.id,
      email: invitee.email!,
      scope: 'PROJECT',
      role: 'COMMENTATOR',
      projectId: s.project.id,
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: invitee.id,
      email: invitee.email!,
    });

    expect(result).toBe('accepted');
    expect((await db.projectMember.findFirstOrThrow({ where: { userId: invitee.id } })).role).toBe(
      'COMMENTATOR'
    );
  });

  it('tells a non-owner admin to ask the owner, under its own code', async () => {
    const s = await accountScenario('solo');
    const legacyEditor = await createUser();
    await addWorkspaceMember({
      workspaceId: s.workspace.id,
      userId: legacyEditor.id,
      role: 'ADMIN',
    });
    signedInAs(legacyEditor);

    const response = await inviteToWorkspace(s.workspace.id, 'another@example.com', 'ADMIN');

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('EDITOR_LIMIT_REACHED_ASK_OWNER');
    expect(await pendingInvitationCount('another@example.com')).toBe(0);
  });

  it('does not count somebody who edits on a different account as an editor here', async () => {
    const s = await accountScenario('solo');
    const elsewhere = await accountScenario('studio');
    const outsider = await createUser();
    await addWorkspaceMember({
      workspaceId: elsewhere.workspace.id,
      userId: outsider.id,
      role: 'ADMIN',
    });
    await db.projectFolderMember.create({
      data: { folderId: elsewhere.folder.id, userId: outsider.id, role: 'ADMIN' },
    });
    await db.videoMember.create({
      data: { videoId: elsewhere.video.id, userId: outsider.id, role: 'ADMIN' },
    });
    await addProjectMember({ projectId: elsewhere.project.id, userId: outsider.id, role: 'ADMIN' });
    signedInAs(s.owner);

    const response = await inviteToWorkspace(s.workspace.id, outsider.email!, 'ADMIN');

    expect(response.status).toBe(403);
    expect([...(await listAccountEditorIds(s.owner.id))]).toEqual([s.owner.id]);
  });

  for (const scope of ['PROJECT', 'FOLDER', 'VIDEO'] as const) {
    it(`refuses accepting a pending ${scope} ADMIN invitation on Solo, and grants nothing`, async () => {
      const s = await accountScenario('solo');
      const invitee = await createUser();
      const invitation = await db.invitation.create({
        data: {
          token: `token-${scope}-${invitee.id}`,
          email: invitee.email!,
          scope,
          role: 'ADMIN',
          projectId: s.project.id,
          folderId: scope === 'FOLDER' ? s.folder.id : null,
          videoId: scope === 'VIDEO' ? s.video.id : null,
          invitedById: s.owner.id,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const result = await acceptInvitationTokenForUser({
        token: invitation.token,
        userId: invitee.id,
        email: invitee.email!,
      });

      expect(result).toBe('editor_limit');
      expect(await db.projectMember.count({ where: { userId: invitee.id } })).toBe(0);
      expect(await db.projectFolderMember.count({ where: { userId: invitee.id } })).toBe(0);
      expect(await db.videoMember.count({ where: { userId: invitee.id } })).toBe(0);
      expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
        'PENDING'
      );
    });
  }

  it('lets somebody who already edits on the account become ADMIN at another level', async () => {
    const s = await accountScenario('solo');
    const legacyEditor = await createUser();
    await addWorkspaceMember({
      workspaceId: s.workspace.id,
      userId: legacyEditor.id,
      role: 'ADMIN',
    });
    const projectMember = await addProjectMember({
      projectId: s.project.id,
      userId: legacyEditor.id,
    });
    signedInAs(s.owner);

    const response = await callRoute(
      patchProjectMember,
      apiRequest(`/api/projects/${s.project.id}/members/${projectMember.id}`, {
        method: 'PATCH',
        body: { role: 'ADMIN' },
      }),
      { projectId: s.project.id, memberId: projectMember.id }
    );

    expect(response.status).toBe(200);
    expect(
      (await db.projectMember.findUniqueOrThrow({ where: { id: projectMember.id } })).role
    ).toBe('ADMIN');
  });
});

describe('accounts the editor limit does not apply to', () => {
  for (const account of ['studio', 'founding', 'trial'] as const) {
    it(`lets a ${account} account invite several ADMINs and promote a member`, async () => {
      const s = await accountScenario(account);
      const reviewer = await createUser();
      const member = await addWorkspaceMember({ workspaceId: s.workspace.id, userId: reviewer.id });
      signedInAs(s.owner);

      const first = await inviteToWorkspace(s.workspace.id, `a-${account}@example.com`, 'ADMIN');
      const second = await inviteToProject(s.project.id, `b-${account}@example.com`, 'ADMIN');
      const promoted = await callRoute(
        patchWorkspaceMember,
        apiRequest(`/api/workspaces/${s.workspace.id}/members/${member.id}`, {
          method: 'PATCH',
          body: { role: 'ADMIN' },
        }),
        { workspaceId: s.workspace.id, memberId: member.id }
      );

      expect([first.status, second.status, promoted.status]).toEqual([200, 200, 200]);
      expect(
        await db.invitation.count({
          where: {
            email: { in: [`a-${account}@example.com`, `b-${account}@example.com`] },
            role: 'ADMIN',
            status: 'PENDING',
          },
        })
      ).toBe(2);
      expect((await db.workspaceMember.findUniqueOrThrow({ where: { id: member.id } })).role).toBe(
        'ADMIN'
      );
    });
  }

  it('treats Studio with a scheduled move to Solo as Solo', async () => {
    const s = await accountScenario('studio');
    await db.user.update({ where: { id: s.owner.id }, data: { pendingBillingPlan: 'SOLO' } });
    signedInAs(s.owner);

    const response = await inviteToWorkspace(s.workspace.id, 'late@example.com', 'ADMIN');

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('EDITOR_LIMIT_REACHED');
    expect(await pendingInvitationCount('late@example.com')).toBe(0);
  });

  for (const account of ['studio', 'founding', 'trial'] as const) {
    it(`lets a ${account} account invite ADMINs at the folder and video level`, async () => {
      const s = await accountScenario(account);
      signedInAs(s.owner);

      const folder = await inviteToContent(
        s.project.id,
        { folderId: s.folder.id },
        `f-${account}@example.com`,
        'ADMIN'
      );
      const video = await inviteToContent(
        s.project.id,
        { videoId: s.video.id },
        `v-${account}@example.com`,
        'ADMIN'
      );

      expect([folder.status, video.status]).toEqual([200, 200]);
      expect(
        await db.invitation.count({
          where: {
            email: { in: [`f-${account}@example.com`, `v-${account}@example.com`] },
            role: 'ADMIN',
            status: 'PENDING',
          },
        })
      ).toBe(2);
    });
  }
});

describe('listAccountEditorIds', () => {
  it('counts ADMINs at all four levels and project owners, but no COMMENTATOR', async () => {
    const s = await accountScenario('studio');
    const [wsAdmin, projectAdmin, folderAdmin, videoAdmin, projectOwner, reviewer] =
      await Promise.all(Array.from({ length: 6 }, () => createUser()));
    await addWorkspaceMember({ workspaceId: s.workspace.id, userId: wsAdmin.id, role: 'ADMIN' });
    await addProjectMember({ projectId: s.project.id, userId: projectAdmin.id, role: 'ADMIN' });
    await db.projectFolderMember.create({
      data: { folderId: s.folder.id, userId: folderAdmin.id, role: 'ADMIN' },
    });
    await db.videoMember.create({
      data: { videoId: s.video.id, userId: videoAdmin.id, role: 'ADMIN' },
    });
    await db.project.create({
      data: {
        name: 'Owned by a member',
        slug: `owned-${projectOwner.id}`,
        ownerId: projectOwner.id,
        workspaceId: s.workspace.id,
      },
    });
    await addWorkspaceMember({ workspaceId: s.workspace.id, userId: reviewer.id });

    const editors = await listAccountEditorIds(s.owner.id);

    expect([...editors].sort()).toEqual(
      [
        s.owner.id,
        wsAdmin.id,
        projectAdmin.id,
        folderAdmin.id,
        videoAdmin.id,
        projectOwner.id,
      ].sort()
    );
  });
});
