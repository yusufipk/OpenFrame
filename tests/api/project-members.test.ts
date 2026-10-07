import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  GET as listProjectMembers,
  POST as inviteProjectMember,
} from '@/app/api/projects/[projectId]/members/route';
import {
  DELETE as removeProjectMember,
  PATCH as patchProjectMember,
} from '@/app/api/projects/[projectId]/members/[memberId]/route';
import { DELETE as cancelProjectInvitation } from '@/app/api/projects/[projectId]/members/invitations/[invitationId]/route';
import { PATCH as patchWorkspaceMember } from '@/app/api/workspaces/[workspaceId]/members/[memberId]/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { mailTo, sentMail } from '../helpers/mail';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createInvitation,
  createUser,
  seedProject,
} from '../factories';

interface MembersPayload {
  members: Array<{ id: string; role: string; user: { id: string } }>;
  owner: { id: string } | null;
  pendingInvitations: Array<{ id: string; email: string; role: string }>;
}

function membersUrl(projectId: string): string {
  return `/api/projects/${projectId}/members`;
}

describe('GET /api/projects/[projectId]/members', () => {
  it('returns 401 without a session', async () => {
    const scenario = await seedProject();
    signedOut();

    const response = await callRoute(
      listProjectMembers,
      apiRequest(membersUrl(scenario.project.id)),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 for a signed-in stranger', async () => {
    const scenario = await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      listProjectMembers,
      apiRequest(membersUrl(scenario.project.id)),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
  });

  // The project is PUBLIC, so checkProjectAccess grants hasAccess to anyone.
  // The route adds `(!isOwner && !isMember)` on top, which is what keeps the
  // member roster out of a passer-by's hands.
  it('returns 403 to a non-member even on a PUBLIC project', async () => {
    const scenario = await seedProject({ visibility: 'PUBLIC' });
    const passerBy = await createUser();
    signedInAs(passerBy);

    const response = await callRoute(
      listProjectMembers,
      apiRequest(membersUrl(scenario.project.id)),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
  });

  it('hides pending invitations from a COMMENTATOR and shows them to an ADMIN', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    const admin = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    await addProjectMember({ projectId: scenario.project.id, userId: admin.id, role: 'ADMIN' });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'PROJECT',
      projectId: scenario.project.id,
      email: 'pending@example.com',
    });

    signedInAs(commentator);
    const asCommentator = await readData<MembersPayload>(
      await callRoute(listProjectMembers, apiRequest(membersUrl(scenario.project.id)), {
        projectId: scenario.project.id,
      })
    );

    signedInAs(admin);
    const asAdmin = await readData<MembersPayload>(
      await callRoute(listProjectMembers, apiRequest(membersUrl(scenario.project.id)), {
        projectId: scenario.project.id,
      })
    );

    expect(asCommentator.pendingInvitations).toEqual([]);
    expect(asAdmin.pendingInvitations.map((entry) => entry.id)).toEqual([invitation.id]);
    expect(asCommentator.members).toHaveLength(2);
    expect(asCommentator.owner?.id).toBe(scenario.owner.id);
  });

  it('omits an expired pending invitation', async () => {
    const scenario = await seedProject();
    await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'PROJECT',
      projectId: scenario.project.id,
      expiresAt: new Date(Date.now() - 60_000),
    });
    signedInAs(scenario.owner);

    const payload = await readData<MembersPayload>(
      await callRoute(listProjectMembers, apiRequest(membersUrl(scenario.project.id)), {
        projectId: scenario.project.id,
      })
    );

    expect(payload.pendingInvitations).toEqual([]);
  });
});

describe('POST /api/projects/[projectId]/members', () => {
  it('returns 401 without a session', async () => {
    const scenario = await seedProject();
    signedOut();

    const response = await callRoute(
      inviteProjectMember,
      apiRequest(membersUrl(scenario.project.id), { body: { email: 'x@example.com' } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(401);
    expect(await db.invitation.count()).toBe(0);
  });

  // A COMMENTATOR is the "viewer" of this product. It must not be able to grow
  // the project's membership.
  it('returns 403 for a project COMMENTATOR and writes no invitation', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      inviteProjectMember,
      apiRequest(membersUrl(scenario.project.id), {
        body: { email: 'newcomer@example.com', role: 'ADMIN' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.invitation.count()).toBe(0);
    expect(sentMail()).toEqual([]);
  });

  it('returns 403 for a stranger', async () => {
    const scenario = await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      inviteProjectMember,
      apiRequest(membersUrl(scenario.project.id), { body: { email: 'x@example.com' } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.invitation.count()).toBe(0);
  });

  // Documents current behaviour. A workspace ADMIN has canEdit on the project
  // (so it can rename it) but the route additionally demands project ownership
  // or project ADMIN membership, so it cannot invite. Flagged in the report as
  // an inconsistency rather than a security hole.
  it('returns 403 for a workspace ADMIN who is not a project member', async () => {
    const scenario = await seedProject();
    const workspaceAdmin = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: workspaceAdmin.id,
      role: 'ADMIN',
    });
    signedInAs(workspaceAdmin);

    const response = await callRoute(
      inviteProjectMember,
      apiRequest(membersUrl(scenario.project.id), { body: { email: 'x@example.com' } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
  });

  it('returns 400 when the email is missing', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      inviteProjectMember,
      apiRequest(membersUrl(scenario.project.id), { body: { role: 'ADMIN' } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(400);
  });

  it.each([['not-an-email'], ['no@domain'], ['two@@example.com'], ['@example.com']])(
    'returns 422 for the malformed address %s',
    async (email) => {
      const scenario = await seedProject();
      signedInAs(scenario.owner);

      const response = await callRoute(
        inviteProjectMember,
        apiRequest(membersUrl(scenario.project.id), { body: { email } }),
        { projectId: scenario.project.id }
      );

      expect(response.status).toBe(422);
      expect(await db.invitation.count()).toBe(0);
    }
  );

  it('returns 400 when invited address is the project owner', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      inviteProjectMember,
      apiRequest(membersUrl(scenario.project.id), { body: { email: scenario.owner.email! } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(400);
    expect(await db.invitation.count()).toBe(0);
  });

  it('returns 409 when the address already belongs to a member', async () => {
    const scenario = await seedProject();
    const existing = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: existing.id });
    signedInAs(scenario.owner);

    const response = await callRoute(
      inviteProjectMember,
      apiRequest(membersUrl(scenario.project.id), { body: { email: existing.email! } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(409);
    expect(await db.invitation.count()).toBe(0);
  });

  it('creates a PROJECT-scoped invitation and sends the mail', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      inviteProjectMember,
      apiRequest(membersUrl(scenario.project.id), {
        body: { email: '  NewComer@Example.COM  ', role: 'ADMIN' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);

    const invitation = await db.invitation.findFirstOrThrow();
    expect(invitation.email).toBe('newcomer@example.com');
    expect(invitation.scope).toBe('PROJECT');
    expect(invitation.role).toBe('ADMIN');
    expect(invitation.status).toBe('PENDING');
    expect(invitation.projectId).toBe(scenario.project.id);
    expect(invitation.workspaceId).toBeNull();
    expect(invitation.invitedById).toBe(scenario.owner.id);
    expect(invitation.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(invitation.token.length).toBeGreaterThanOrEqual(32);

    // No membership yet: the invitation has to be accepted first.
    expect(await db.projectMember.count()).toBe(0);

    const mails = mailTo('newcomer@example.com');
    expect(mails).toHaveLength(1);
    expect(mails[0].html).toContain(invitation.token);
  });

  it('falls back to COMMENTATOR for an unrecognised role', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      inviteProjectMember,
      apiRequest(membersUrl(scenario.project.id), {
        body: { email: 'newcomer@example.com', role: 'SUPERADMIN' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);
    expect((await db.invitation.findFirstOrThrow()).role).toBe('COMMENTATOR');
  });

  it('lets a project ADMIN invite, and reuses the row on a repeat invite', async () => {
    const scenario = await seedProject();
    const admin = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: admin.id, role: 'ADMIN' });
    signedInAs(admin);

    const first = await callRoute(
      inviteProjectMember,
      apiRequest(membersUrl(scenario.project.id), {
        body: { email: 'repeat@example.com', role: 'COMMENTATOR' },
      }),
      { projectId: scenario.project.id }
    );
    const firstToken = (await db.invitation.findFirstOrThrow()).token;

    const second = await callRoute(
      inviteProjectMember,
      apiRequest(membersUrl(scenario.project.id), {
        body: { email: 'repeat@example.com', role: 'ADMIN' },
      }),
      { projectId: scenario.project.id }
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await db.invitation.count()).toBe(1);

    const invitation = await db.invitation.findFirstOrThrow();
    expect(invitation.role).toBe('ADMIN');
    expect(invitation.token).toBe(firstToken);
  });
});

describe('PATCH /api/projects/[projectId]/members/[memberId]', () => {
  it('returns 401 without a session', async () => {
    const scenario = await seedProject();
    const target = await createUser();
    const member = await addProjectMember({
      projectId: scenario.project.id,
      userId: target.id,
    });
    signedOut();

    const response = await callRoute(
      patchProjectMember,
      apiRequest(`${membersUrl(scenario.project.id)}/${member.id}`, {
        method: 'PATCH',
        body: { role: 'ADMIN' },
      }),
      { projectId: scenario.project.id, memberId: member.id }
    );

    expect(response.status).toBe(401);
    expect((await db.projectMember.findUniqueOrThrow({ where: { id: member.id } })).role).toBe(
      'COMMENTATOR'
    );
  });

  // The escalation that matters: a COMMENTATOR promoting itself to ADMIN.
  it('returns 403 when a COMMENTATOR tries to promote itself', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    const member = await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      patchProjectMember,
      apiRequest(`${membersUrl(scenario.project.id)}/${member.id}`, {
        method: 'PATCH',
        body: { role: 'ADMIN' },
      }),
      { projectId: scenario.project.id, memberId: member.id }
    );

    expect(response.status).toBe(403);
    expect((await db.projectMember.findUniqueOrThrow({ where: { id: member.id } })).role).toBe(
      'COMMENTATOR'
    );
  });

  it.each([['OWNER'], ['SUPERADMIN'], ['']])('returns 400 for the role %s', async (role) => {
    const scenario = await seedProject();
    const target = await createUser();
    const member = await addProjectMember({
      projectId: scenario.project.id,
      userId: target.id,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchProjectMember,
      apiRequest(`${membersUrl(scenario.project.id)}/${member.id}`, {
        method: 'PATCH',
        body: { role },
      }),
      { projectId: scenario.project.id, memberId: member.id }
    );

    expect(response.status).toBe(400);
    expect((await db.projectMember.findUniqueOrThrow({ where: { id: member.id } })).role).toBe(
      'COMMENTATOR'
    );
  });

  // The membership row id is a global identifier, so the route has to scope the
  // lookup by projectId or an admin of one project could re-role a member of
  // another.
  it('returns 404 for a membership row that belongs to a different project', async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    const victim = await createUser();
    const foreignMember = await addProjectMember({
      projectId: theirs.project.id,
      userId: victim.id,
      role: 'COMMENTATOR',
    });
    signedInAs(mine.owner);

    const response = await callRoute(
      patchProjectMember,
      apiRequest(`${membersUrl(mine.project.id)}/${foreignMember.id}`, {
        method: 'PATCH',
        body: { role: 'ADMIN' },
      }),
      { projectId: mine.project.id, memberId: foreignMember.id }
    );

    expect(response.status).toBe(404);
    expect(
      (await db.projectMember.findUniqueOrThrow({ where: { id: foreignMember.id } })).role
    ).toBe('COMMENTATOR');
  });

  it('lets the owner promote a COMMENTATOR to ADMIN', async () => {
    const scenario = await seedProject();
    const target = await createUser();
    const member = await addProjectMember({
      projectId: scenario.project.id,
      userId: target.id,
      role: 'COMMENTATOR',
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchProjectMember,
      apiRequest(`${membersUrl(scenario.project.id)}/${member.id}`, {
        method: 'PATCH',
        body: { role: 'ADMIN' },
      }),
      { projectId: scenario.project.id, memberId: member.id }
    );

    expect(response.status).toBe(200);
    expect((await db.projectMember.findUniqueOrThrow({ where: { id: member.id } })).role).toBe(
      'ADMIN'
    );
  });
});

describe('DELETE /api/projects/[projectId]/members/[memberId]', () => {
  it('returns 401 without a session', async () => {
    const scenario = await seedProject();
    const target = await createUser();
    const member = await addProjectMember({
      projectId: scenario.project.id,
      userId: target.id,
    });
    signedOut();

    const response = await callRoute(
      removeProjectMember,
      apiRequest(`${membersUrl(scenario.project.id)}/${member.id}`, { method: 'DELETE' }),
      { projectId: scenario.project.id, memberId: member.id }
    );

    expect(response.status).toBe(401);
    expect(await db.projectMember.count()).toBe(1);
  });

  it('returns 403 when a COMMENTATOR tries to remove somebody else', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    const victim = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    const victimMember = await addProjectMember({
      projectId: scenario.project.id,
      userId: victim.id,
    });
    signedInAs(commentator);

    const response = await callRoute(
      removeProjectMember,
      apiRequest(`${membersUrl(scenario.project.id)}/${victimMember.id}`, { method: 'DELETE' }),
      { projectId: scenario.project.id, memberId: victimMember.id }
    );

    expect(response.status).toBe(403);
    expect(await db.projectMember.count()).toBe(2);
  });

  it('lets a COMMENTATOR remove itself', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    const member = await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      removeProjectMember,
      apiRequest(`${membersUrl(scenario.project.id)}/${member.id}`, { method: 'DELETE' }),
      { projectId: scenario.project.id, memberId: member.id }
    );

    expect(response.status).toBe(200);
    expect(await db.projectMember.count()).toBe(0);
  });

  // The owner is not a ProjectMember row at all, so there is nothing to delete
  // and no path that can orphan a project. Pinning it here so a future refactor
  // that starts materialising the owner as a member has to think about it.
  it('cannot remove the project owner, who has no membership row', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const byUserId = await callRoute(
      removeProjectMember,
      apiRequest(`${membersUrl(scenario.project.id)}/${scenario.owner.id}`, { method: 'DELETE' }),
      { projectId: scenario.project.id, memberId: scenario.owner.id }
    );

    expect(byUserId.status).toBe(404);
    expect(
      await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } })
    ).toMatchObject({ ownerId: scenario.owner.id });
  });

  it('lets a project ADMIN remove a COMMENTATOR', async () => {
    const scenario = await seedProject();
    const admin = await createUser();
    const victim = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: admin.id, role: 'ADMIN' });
    const victimMember = await addProjectMember({
      projectId: scenario.project.id,
      userId: victim.id,
    });
    signedInAs(admin);

    const response = await callRoute(
      removeProjectMember,
      apiRequest(`${membersUrl(scenario.project.id)}/${victimMember.id}`, { method: 'DELETE' }),
      { projectId: scenario.project.id, memberId: victimMember.id }
    );

    expect(response.status).toBe(200);
    expect(await db.projectMember.findUnique({ where: { id: victimMember.id } })).toBeNull();
  });
});

describe('project ADMIN scope', () => {
  // The escalation to actually worry about: project ADMIN is a role inside one
  // project, and it must not reach the workspace roster, which controls every
  // project in the workspace.
  it('cannot change a workspace member role', async () => {
    const scenario = await seedProject();
    const projectAdmin = await createUser();
    const workspaceVictim = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: projectAdmin.id,
      role: 'ADMIN',
    });
    const workspaceMember = await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: workspaceVictim.id,
      role: 'COMMENTATOR',
    });
    signedInAs(projectAdmin);

    const response = await callRoute(
      patchWorkspaceMember,
      apiRequest(`/api/workspaces/${scenario.workspace.id}/members/${workspaceMember.id}`, {
        method: 'PATCH',
        body: { role: 'ADMIN' },
      }),
      { workspaceId: scenario.workspace.id, memberId: workspaceMember.id }
    );

    expect(response.status).toBe(403);
    expect(
      (await db.workspaceMember.findUniqueOrThrow({ where: { id: workspaceMember.id } })).role
    ).toBe('COMMENTATOR');
  });

  it('cannot invite into the workspace', async () => {
    const scenario = await seedProject();
    const projectAdmin = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: projectAdmin.id,
      role: 'ADMIN',
    });
    signedInAs(projectAdmin);

    const { POST: inviteWorkspaceMember } =
      await import('@/app/api/workspaces/[workspaceId]/members/route');
    const response = await callRoute(
      inviteWorkspaceMember,
      apiRequest(`/api/workspaces/${scenario.workspace.id}/members`, {
        body: { email: 'outsider@example.com', role: 'ADMIN' },
      }),
      { workspaceId: scenario.workspace.id }
    );

    expect(response.status).toBe(403);
    expect(await db.invitation.count()).toBe(0);
  });
});

describe('DELETE /api/projects/[projectId]/members/invitations/[invitationId]', () => {
  it('returns 403 for a COMMENTATOR', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'PROJECT',
      projectId: scenario.project.id,
    });
    signedInAs(commentator);

    const response = await callRoute(
      cancelProjectInvitation,
      apiRequest(`${membersUrl(scenario.project.id)}/invitations/${invitation.id}`, {
        method: 'DELETE',
      }),
      { projectId: scenario.project.id, invitationId: invitation.id }
    );

    expect(response.status).toBe(403);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'PENDING'
    );
  });

  it('returns 404 for an invitation scoped to another project', async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    const invitation = await createInvitation({
      invitedById: theirs.owner.id,
      scope: 'PROJECT',
      projectId: theirs.project.id,
    });
    signedInAs(mine.owner);

    const response = await callRoute(
      cancelProjectInvitation,
      apiRequest(`${membersUrl(mine.project.id)}/invitations/${invitation.id}`, {
        method: 'DELETE',
      }),
      { projectId: mine.project.id, invitationId: invitation.id }
    );

    expect(response.status).toBe(404);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'PENDING'
    );
  });

  it('returns 409 for an already accepted invitation', async () => {
    const scenario = await seedProject();
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'PROJECT',
      projectId: scenario.project.id,
      status: 'ACCEPTED',
      acceptedAt: new Date(),
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      cancelProjectInvitation,
      apiRequest(`${membersUrl(scenario.project.id)}/invitations/${invitation.id}`, {
        method: 'DELETE',
      }),
      { projectId: scenario.project.id, invitationId: invitation.id }
    );

    expect(response.status).toBe(409);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'ACCEPTED'
    );
  });

  it('marks a pending invitation CANCELED for the owner', async () => {
    const scenario = await seedProject();
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'PROJECT',
      projectId: scenario.project.id,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      cancelProjectInvitation,
      apiRequest(`${membersUrl(scenario.project.id)}/invitations/${invitation.id}`, {
        method: 'DELETE',
      }),
      { projectId: scenario.project.id, invitationId: invitation.id }
    );

    expect(response.status).toBe(200);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'CANCELED'
    );
  });
});
