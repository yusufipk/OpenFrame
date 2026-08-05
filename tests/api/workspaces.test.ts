import { describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { GET as listWorkspaces, POST as createWorkspaceRoute } from '@/app/api/workspaces/route';
import {
  DELETE as deleteWorkspace,
  GET as getWorkspace,
  PATCH as patchWorkspace,
} from '@/app/api/workspaces/[workspaceId]/route';
import {
  GET as listWorkspaceMembers,
  POST as inviteWorkspaceMember,
} from '@/app/api/workspaces/[workspaceId]/members/route';
import {
  DELETE as removeWorkspaceMember,
  PATCH as patchWorkspaceMember,
} from '@/app/api/workspaces/[workspaceId]/members/[memberId]/route';
import { apiRequest, callRoute, readData, readJson } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createExpiredUser,
  createProject,
  createSubscribedUser,
  createUser,
  createVideo,
  createWorkspace,
  seedProject,
} from '../factories';

describe('GET /api/workspaces', () => {
  it('returns 401 without a session', async () => {
    signedOut();

    const response = await callRoute(listWorkspaces, apiRequest('/api/workspaces'));

    expect(response.status).toBe(401);
  });

  it.each([['page=0'], ['page=1001'], ['limit=0'], ['limit=101'], ['page=1000&limit=100']])(
    'rejects ?%s with 400',
    async (query) => {
      const user = await createUser();
      signedInAs(user);

      const response = await callRoute(listWorkspaces, apiRequest(`/api/workspaces?${query}`));

      expect(response.status).toBe(400);
    }
  );

  it('lists owned and joined workspaces with pagination metadata', async () => {
    const user = await createUser();
    const owned = await createWorkspace({ ownerId: user.id });
    const host = await createUser();
    const joined = await createWorkspace({ ownerId: host.id });
    await addWorkspaceMember({ workspaceId: joined.id, userId: user.id });
    await createWorkspace({ ownerId: host.id });
    signedInAs(user);

    const payload = await readJson<{
      data: { workspaces: Array<{ id: string }> };
      meta: { total: number; totalPages: number };
    }>(await callRoute(listWorkspaces, apiRequest('/api/workspaces')));

    expect(payload.data.workspaces.map((entry) => entry.id).sort()).toEqual(
      [owned.id, joined.id].sort()
    );
    expect(payload.meta.total).toBe(2);
    expect(payload.meta.totalPages).toBe(1);
  });

  it('hides a joined workspace whose owner has lost billing access', async () => {
    const expiredHost = await createExpiredUser();
    const workspace = await createWorkspace({ ownerId: expiredHost.id });
    const member = await createUser();
    await addWorkspaceMember({ workspaceId: workspace.id, userId: member.id });
    signedInAs(member);

    const payload = await readData<{ workspaces: Array<{ id: string }> }>(
      await callRoute(listWorkspaces, apiRequest('/api/workspaces'))
    );

    expect(payload.workspaces).toEqual([]);
  });

  it('hides an owned workspace from an owner who has lost billing access', async () => {
    const expiredOwner = await createExpiredUser();
    await createWorkspace({ ownerId: expiredOwner.id });
    signedInAs(expiredOwner);

    const payload = await readData<{ workspaces: Array<{ id: string }> }>(
      await callRoute(listWorkspaces, apiRequest('/api/workspaces'))
    );

    expect(payload.workspaces).toEqual([]);
  });
});

describe('POST /api/workspaces', () => {
  it('returns 401 without a session', async () => {
    signedOut();

    const response = await callRoute(
      createWorkspaceRoute,
      apiRequest('/api/workspaces', { body: { name: 'X' } })
    );

    expect(response.status).toBe(401);
    expect(await db.workspace.count()).toBe(0);
  });

  it.each([[{}], [{ name: '' }], [{ name: '   ' }], [{ name: 99 }]])(
    'rejects %j with 400',
    async (body) => {
      const user = await createUser();
      signedInAs(user);

      const response = await callRoute(
        createWorkspaceRoute,
        apiRequest('/api/workspaces', { body })
      );

      expect(response.status).toBe(400);
      expect(await db.workspace.count()).toBe(0);
    }
  );

  it('creates the workspace owned by the caller with a derived slug', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(
      createWorkspaceRoute,
      apiRequest('/api/workspaces', {
        body: { name: '  My Studio!  ', description: '  a place  ', ownerId: 'someone-else' },
      })
    );

    expect(response.status).toBe(201);
    const stored = await db.workspace.findFirstOrThrow();
    expect(stored.name).toBe('My Studio!');
    expect(stored.slug).toBe('my-studio');
    expect(stored.description).toBe('a place');
    // ownerId in the body is ignored: it decides who pays.
    expect(stored.ownerId).toBe(user.id);
  });

  // Subscribed rather than the default trial user: three workspaces is past the
  // trial's ceiling, and this test is about slugs, not about billing.
  it('gives same-named workspaces distinct slugs', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);

    for (let index = 0; index < 3; index += 1) {
      const response = await callRoute(
        createWorkspaceRoute,
        apiRequest('/api/workspaces', { body: { name: 'Studio' } })
      );
      expect(response.status).toBe(201);
    }

    expect(
      (await db.workspace.findMany({ select: { slug: true } })).map((row) => row.slug).sort()
    ).toEqual(['studio', 'studio-1', 'studio-2']);
  });

  // getWorkspaceCreationEligibility lets a brand-new, unbilled user create their
  // very first workspace so that signup is not a dead end.
  it('lets an expired user create their first workspace', async () => {
    const expired = await createExpiredUser();
    signedInAs(expired);

    const response = await callRoute(
      createWorkspaceRoute,
      apiRequest('/api/workspaces', { body: { name: 'First Try' } })
    );

    expect(response.status).toBe(201);
    expect(await db.workspace.count()).toBe(1);
  });

  it('refuses a second workspace for an expired user', async () => {
    const expired = await createExpiredUser();
    await createWorkspace({ ownerId: expired.id });
    signedInAs(expired);

    const response = await callRoute(
      createWorkspaceRoute,
      apiRequest('/api/workspaces', { body: { name: 'Second Try' } })
    );

    expect(response.status).toBe(403);
    expect(await db.workspace.count()).toBe(1);
  });

  it('refuses a first workspace for an expired user who is collaborating elsewhere', async () => {
    const host = await seedProject();
    const expired = await createExpiredUser();
    await addWorkspaceMember({ workspaceId: host.workspace.id, userId: expired.id });
    signedInAs(expired);

    const response = await callRoute(
      createWorkspaceRoute,
      apiRequest('/api/workspaces', { body: { name: 'Freeloader' } })
    );

    expect(response.status).toBe(403);
    expect(await db.workspace.count()).toBe(1);
  });

  it('refuses a first workspace for an expired user who is a project-only collaborator', async () => {
    const host = await seedProject();
    const expired = await createExpiredUser();
    await addProjectMember({ projectId: host.project.id, userId: expired.id });
    signedInAs(expired);

    const response = await callRoute(
      createWorkspaceRoute,
      apiRequest('/api/workspaces', { body: { name: 'Freeloader' } })
    );

    expect(response.status).toBe(403);
    expect(await db.workspace.count()).toBe(1);
  });

  // The name has always promised a subscriber; it used to be handed a trial user,
  // which passed only because nothing distinguished the two.
  it('lets a subscribed user create any number of workspaces', async () => {
    const user = await createSubscribedUser();
    await createWorkspace({ ownerId: user.id });
    await createWorkspace({ ownerId: user.id });
    signedInAs(user);

    const response = await callRoute(
      createWorkspaceRoute,
      apiRequest('/api/workspaces', { body: { name: 'Third' } })
    );

    expect(response.status).toBe(201);
    expect(await db.workspace.count()).toBe(3);
  });

  it('refuses a second workspace while the owner is on a free trial', async () => {
    const user = await createUser();
    await createWorkspace({ ownerId: user.id });
    signedInAs(user);

    const response = await callRoute(
      createWorkspaceRoute,
      apiRequest('/api/workspaces', { body: { name: 'Second' } })
    );

    expect(response.status).toBe(403);
    expect(await db.workspace.count()).toBe(1);
  });

  it('lets a self-hosted instance with billing disabled create freely', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');
    const expired = await createExpiredUser();
    await createWorkspace({ ownerId: expired.id });
    signedInAs(expired);

    const response = await callRoute(
      createWorkspaceRoute,
      apiRequest('/api/workspaces', { body: { name: 'Self Hosted' } })
    );

    expect(response.status).toBe(201);
  });
});

describe('GET /api/workspaces/[workspaceId]', () => {
  it('returns 401 without a session', async () => {
    const scenario = await seedProject();
    signedOut();

    const response = await callRoute(
      getWorkspace,
      apiRequest(`/api/workspaces/${scenario.workspace.id}`),
      { workspaceId: scenario.workspace.id }
    );

    expect(response.status).toBe(401);
  });

  it('returns 404 for an unknown workspace', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(getWorkspace, apiRequest('/api/workspaces/nope'), {
      workspaceId: 'nope',
    });

    expect(response.status).toBe(404);
  });

  it('returns 403 for a signed-in stranger', async () => {
    const scenario = await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      getWorkspace,
      apiRequest(`/api/workspaces/${scenario.workspace.id}`),
      { workspaceId: scenario.workspace.id }
    );

    expect(response.status).toBe(403);
  });

  it.each([['limit=0'], ['limit=101'], ['offset=-1'], ['offset=10001']])(
    'rejects ?%s with 400',
    async (query) => {
      const scenario = await seedProject();
      signedInAs(scenario.owner);

      const response = await callRoute(
        getWorkspace,
        apiRequest(`/api/workspaces/${scenario.workspace.id}?${query}`),
        { workspaceId: scenario.workspace.id }
      );

      expect(response.status).toBe(400);
    }
  );

  it('serves a COMMENTATOR member the workspace with its projects', async () => {
    const scenario = await seedProject();
    const member = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: member.id,
      role: 'COMMENTATOR',
    });
    signedInAs(member);

    const payload = await readData<{
      id: string;
      projects: Array<{ id: string }>;
      members: Array<{ userId: string }>;
      _count: { projects: number; members: number };
    }>(
      await callRoute(getWorkspace, apiRequest(`/api/workspaces/${scenario.workspace.id}`), {
        workspaceId: scenario.workspace.id,
      })
    );

    expect(payload.id).toBe(scenario.workspace.id);
    expect(payload.projects.map((entry) => entry.id)).toEqual([scenario.project.id]);
    expect(payload._count).toEqual({ projects: 1, members: 1 });
  });
});

describe('PATCH /api/workspaces/[workspaceId]', () => {
  it('returns 403 for a COMMENTATOR member', async () => {
    const scenario = await seedProject();
    const member = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: member.id,
      role: 'COMMENTATOR',
    });
    signedInAs(member);

    const response = await callRoute(
      patchWorkspace,
      apiRequest(`/api/workspaces/${scenario.workspace.id}`, {
        method: 'PATCH',
        body: { name: 'Renamed' },
      }),
      { workspaceId: scenario.workspace.id }
    );

    expect(response.status).toBe(403);
    expect(
      (await db.workspace.findUniqueOrThrow({ where: { id: scenario.workspace.id } })).name
    ).toBe(scenario.workspace.name);
  });

  it.each([
    [{ name: '' }],
    [{ name: 'x'.repeat(101) }],
    [{ description: 'x'.repeat(1001) }],
    [{ description: 7 }],
  ])('rejects %j with 400', async (body) => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchWorkspace,
      apiRequest(`/api/workspaces/${scenario.workspace.id}`, { method: 'PATCH', body }),
      { workspaceId: scenario.workspace.id }
    );

    expect(response.status).toBe(400);
  });

  it('lets a workspace ADMIN rename it, ignoring an ownerId in the body', async () => {
    const scenario = await seedProject();
    const admin = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: admin.id,
      role: 'ADMIN',
    });
    signedInAs(admin);

    const response = await callRoute(
      patchWorkspace,
      apiRequest(`/api/workspaces/${scenario.workspace.id}`, {
        method: 'PATCH',
        body: { name: '  Renamed  ', description: null, ownerId: admin.id },
      }),
      { workspaceId: scenario.workspace.id }
    );

    expect(response.status).toBe(200);
    const stored = await db.workspace.findUniqueOrThrow({
      where: { id: scenario.workspace.id },
    });
    expect(stored.name).toBe('Renamed');
    expect(stored.description).toBeNull();
    expect(stored.ownerId).toBe(scenario.owner.id);
  });
});

describe('DELETE /api/workspaces/[workspaceId]', () => {
  it('returns 403 for a workspace ADMIN, who may edit but not destroy', async () => {
    const scenario = await seedProject();
    const admin = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: admin.id,
      role: 'ADMIN',
    });
    signedInAs(admin);

    const response = await callRoute(
      deleteWorkspace,
      apiRequest(`/api/workspaces/${scenario.workspace.id}`, { method: 'DELETE' }),
      { workspaceId: scenario.workspace.id }
    );

    expect(response.status).toBe(403);
    expect(await db.workspace.count()).toBe(1);
  });

  it('deletes the workspace and cascades to projects and videos for the owner', async () => {
    const scenario = await seedProject();
    await createVideo({ projectId: scenario.project.id });
    signedInAs(scenario.owner);

    const response = await callRoute(
      deleteWorkspace,
      apiRequest(`/api/workspaces/${scenario.workspace.id}`, { method: 'DELETE' }),
      { workspaceId: scenario.workspace.id }
    );

    expect(response.status).toBe(200);
    expect(await db.workspace.count()).toBe(0);
    expect(await db.project.count()).toBe(0);
    expect(await db.video.count()).toBe(0);
  });
});

describe('workspace members', () => {
  it('returns 403 to a stranger listing the roster', async () => {
    const scenario = await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      listWorkspaceMembers,
      apiRequest(`/api/workspaces/${scenario.workspace.id}/members`),
      { workspaceId: scenario.workspace.id }
    );

    expect(response.status).toBe(403);
  });

  it('returns 403 when a COMMENTATOR tries to invite', async () => {
    const scenario = await seedProject();
    const member = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: member.id,
      role: 'COMMENTATOR',
    });
    signedInAs(member);

    const response = await callRoute(
      inviteWorkspaceMember,
      apiRequest(`/api/workspaces/${scenario.workspace.id}/members`, {
        body: { email: 'newcomer@example.com', role: 'ADMIN' },
      }),
      { workspaceId: scenario.workspace.id }
    );

    expect(response.status).toBe(403);
    expect(await db.invitation.count()).toBe(0);
  });

  it('returns 400 when inviting the workspace owner', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      inviteWorkspaceMember,
      apiRequest(`/api/workspaces/${scenario.workspace.id}/members`, {
        body: { email: scenario.owner.email! },
      }),
      { workspaceId: scenario.workspace.id }
    );

    expect(response.status).toBe(400);
    expect(await db.invitation.count()).toBe(0);
  });

  it('returns 409 when inviting an existing member', async () => {
    const scenario = await seedProject();
    const member = await createUser();
    await addWorkspaceMember({ workspaceId: scenario.workspace.id, userId: member.id });
    signedInAs(scenario.owner);

    const response = await callRoute(
      inviteWorkspaceMember,
      apiRequest(`/api/workspaces/${scenario.workspace.id}/members`, {
        body: { email: member.email! },
      }),
      { workspaceId: scenario.workspace.id }
    );

    expect(response.status).toBe(409);
    expect(await db.invitation.count()).toBe(0);
  });

  it('creates a WORKSPACE-scoped invitation for an ADMIN', async () => {
    const scenario = await seedProject();
    const admin = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: admin.id,
      role: 'ADMIN',
    });
    signedInAs(admin);

    const response = await callRoute(
      inviteWorkspaceMember,
      apiRequest(`/api/workspaces/${scenario.workspace.id}/members`, {
        body: { email: 'NewComer@Example.com', role: 'ADMIN' },
      }),
      { workspaceId: scenario.workspace.id }
    );

    expect(response.status).toBe(200);
    const invitation = await db.invitation.findFirstOrThrow();
    expect(invitation.email).toBe('newcomer@example.com');
    expect(invitation.scope).toBe('WORKSPACE');
    expect(invitation.role).toBe('ADMIN');
    expect(invitation.workspaceId).toBe(scenario.workspace.id);
    expect(invitation.projectId).toBeNull();
    expect(await db.workspaceMember.count()).toBe(1);
  });

  it('returns 404 when the membership row belongs to another workspace', async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    const victim = await createUser();
    const foreign = await addWorkspaceMember({
      workspaceId: theirs.workspace.id,
      userId: victim.id,
      role: 'COMMENTATOR',
    });
    signedInAs(mine.owner);

    const response = await callRoute(
      patchWorkspaceMember,
      apiRequest(`/api/workspaces/${mine.workspace.id}/members/${foreign.id}`, {
        method: 'PATCH',
        body: { role: 'ADMIN' },
      }),
      { workspaceId: mine.workspace.id, memberId: foreign.id }
    );

    expect(response.status).toBe(404);
    expect((await db.workspaceMember.findUniqueOrThrow({ where: { id: foreign.id } })).role).toBe(
      'COMMENTATOR'
    );
  });

  // The owner is not a WorkspaceMember row, so there is no id that could remove
  // them and no way to leave a workspace unowned.
  it('cannot remove the workspace owner', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      removeWorkspaceMember,
      apiRequest(`/api/workspaces/${scenario.workspace.id}/members/${scenario.owner.id}`, {
        method: 'DELETE',
      }),
      { workspaceId: scenario.workspace.id, memberId: scenario.owner.id }
    );

    expect(response.status).toBe(404);
    expect(
      (await db.workspace.findUniqueOrThrow({ where: { id: scenario.workspace.id } })).ownerId
    ).toBe(scenario.owner.id);
  });

  it('returns 403 when a COMMENTATOR removes somebody else', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    const victim = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    const victimMember = await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: victim.id,
    });
    signedInAs(commentator);

    const response = await callRoute(
      removeWorkspaceMember,
      apiRequest(`/api/workspaces/${scenario.workspace.id}/members/${victimMember.id}`, {
        method: 'DELETE',
      }),
      { workspaceId: scenario.workspace.id, memberId: victimMember.id }
    );

    expect(response.status).toBe(403);
    expect(await db.workspaceMember.count()).toBe(2);
  });

  // Removing somebody has to leave the workspace's projects intact: their
  // project memberships go, and any project they owned reverts to the workspace
  // owner rather than being orphaned.
  it('reassigns the projects of a removed member to the workspace owner', async () => {
    const scenario = await seedProject();
    const leaver = await createUser();
    const membership = await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: leaver.id,
      role: 'ADMIN',
    });
    const theirProject = await createProject({
      ownerId: leaver.id,
      workspaceId: scenario.workspace.id,
    });
    await addProjectMember({ projectId: scenario.project.id, userId: leaver.id });
    signedInAs(scenario.owner);

    const response = await callRoute(
      removeWorkspaceMember,
      apiRequest(`/api/workspaces/${scenario.workspace.id}/members/${membership.id}`, {
        method: 'DELETE',
      }),
      { workspaceId: scenario.workspace.id, memberId: membership.id }
    );

    expect(response.status).toBe(200);
    expect(await db.workspaceMember.count()).toBe(0);
    expect(await db.projectMember.count()).toBe(0);
    expect((await db.project.findUniqueOrThrow({ where: { id: theirProject.id } })).ownerId).toBe(
      scenario.owner.id
    );
  });

  it('lets a member remove itself', async () => {
    const scenario = await seedProject();
    const member = await createUser();
    const membership = await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: member.id,
      role: 'COMMENTATOR',
    });
    signedInAs(member);

    const response = await callRoute(
      removeWorkspaceMember,
      apiRequest(`/api/workspaces/${scenario.workspace.id}/members/${membership.id}`, {
        method: 'DELETE',
      }),
      { workspaceId: scenario.workspace.id, memberId: membership.id }
    );

    expect(response.status).toBe(200);
    expect(await db.workspaceMember.count()).toBe(0);
  });
});
