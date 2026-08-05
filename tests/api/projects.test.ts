import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { DEFAULT_COMMENT_TAGS } from '@/lib/comment-tags';
import { GET as listProjects, POST as createProjectRoute } from '@/app/api/projects/route';
import {
  DELETE as deleteProject,
  GET as getProject,
  PATCH as patchProject,
} from '@/app/api/projects/[projectId]/route';
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

interface ListedProject {
  id: string;
  name: string;
}

async function listFor(userId: string, query = ''): Promise<Response> {
  signedInAs({ id: userId });
  return callRoute(listProjects, apiRequest(`/api/projects${query}`));
}

describe('GET /api/projects', () => {
  it('returns 401 without a session', async () => {
    signedOut();

    const response = await callRoute(listProjects, apiRequest('/api/projects'));

    expect(response.status).toBe(401);
  });

  it.each([
    ['page=0', 'page 0 is below the minimum'],
    ['page=1001', 'page 1001 is past MAX_PAGE'],
    ['page=1.5', 'a non-integer page'],
    ['page=abc', 'an unparseable page'],
    ['limit=0', 'limit 0 is below the minimum'],
    ['limit=101', 'limit 101 is past MAX_LIMIT'],
    ['page=1000&limit=100', 'an offset of 99900 is past MAX_OFFSET'],
  ])('rejects ?%s with 400 (%s)', async (query, label) => {
    const user = await createUser();

    const response = await listFor(user.id, `?${query}`);

    expect(response.status, label).toBe(400);
  });

  it('accepts the boundary values page=1000&limit=10 and limit=100', async () => {
    const user = await createUser();

    expect((await listFor(user.id, '?page=1000&limit=10')).status).toBe(200);
    expect((await listFor(user.id, '?limit=100')).status).toBe(200);
  });

  it('lists projects the caller owns, with pagination metadata', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    await createProject({ ownerId: owner.id, workspaceId: workspace.id, name: 'First' });
    await createProject({ ownerId: owner.id, workspaceId: workspace.id, name: 'Second' });
    await createProject({ ownerId: owner.id, workspaceId: workspace.id, name: 'Third' });

    const response = await listFor(owner.id, '?page=2&limit=2');
    const payload = await readJson<{
      data: { projects: ListedProject[] };
      meta: { page: number; limit: number; total: number; totalPages: number };
    }>(response);

    expect(response.status).toBe(200);
    expect(payload.data.projects).toHaveLength(1);
    expect(payload.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
  });

  it('does not list projects belonging to another user', async () => {
    const stranger = await seedProject();
    const caller = await createUser();

    const projects = await readData<{ projects: ListedProject[] }>(await listFor(caller.id));

    expect(projects.projects).toEqual([]);
    // Sanity check that the arrangement was real and the empty result is about
    // the filter rather than about an empty database.
    expect(await db.project.count()).toBe(1);
    expect(stranger.project.id).toBeTruthy();
  });

  // This is the buildBillingAccessWhereInput() guard in the list filter. Both
  // halves are here on purpose: without the positive control, deleting the
  // clause entirely would still leave the negative test passing for the wrong
  // reason.
  it('hides a project whose workspace owner has lost billing access, even from its owner', async () => {
    const expiredOwner = await createExpiredUser();
    const workspace = await createWorkspace({ ownerId: expiredOwner.id });
    await createProject({ ownerId: expiredOwner.id, workspaceId: workspace.id });

    const payload = await readJson<{
      data: { projects: ListedProject[] };
      meta: { total: number };
    }>(await listFor(expiredOwner.id));

    expect(payload.data.projects).toEqual([]);
    expect(payload.meta.total).toBe(0);
  });

  it('lists the same project once the owner has billing access again', async () => {
    const owner = await createExpiredUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const project = await createProject({ ownerId: owner.id, workspaceId: workspace.id });

    await db.user.update({
      where: { id: owner.id },
      data: { trialEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });

    const projects = await readData<{ projects: ListedProject[] }>(await listFor(owner.id));

    expect(projects.projects.map((entry) => entry.id)).toEqual([project.id]);
  });

  it('hides a project from a member when the workspace owner has lost billing access', async () => {
    const expiredOwner = await createExpiredUser();
    const workspace = await createWorkspace({ ownerId: expiredOwner.id });
    const project = await createProject({
      ownerId: expiredOwner.id,
      workspaceId: workspace.id,
    });
    const member = await createUser();
    await addProjectMember({ projectId: project.id, userId: member.id });

    const projects = await readData<{ projects: ListedProject[] }>(await listFor(member.id));

    expect(projects.projects).toEqual([]);
  });

  it('lists a workspace member the projects of that workspace', async () => {
    const scenario = await seedProject();
    const member = await createUser();
    await addWorkspaceMember({ workspaceId: scenario.workspace.id, userId: member.id });

    const projects = await readData<{ projects: ListedProject[] }>(await listFor(member.id));

    expect(projects.projects.map((entry) => entry.id)).toEqual([scenario.project.id]);
  });

  // The workspace-membership branch of the OR used to be dropped as soon as ?workspaceId
  // was supplied, so filtering by their own workspace showed a member an empty list while
  // the unfiltered call returned the same project.
  it('still lists workspace-member projects when ?workspaceId is supplied', async () => {
    const scenario = await seedProject();
    const member = await createUser();
    await addWorkspaceMember({ workspaceId: scenario.workspace.id, userId: member.id });

    const unfiltered = await readData<{ projects: ListedProject[] }>(await listFor(member.id));
    const filtered = await readData<{ projects: ListedProject[] }>(
      await listFor(member.id, `?workspaceId=${scenario.workspace.id}`)
    );

    expect(unfiltered.projects.map((entry) => entry.id)).toEqual([scenario.project.id]);
    expect(filtered.projects.map((entry) => entry.id)).toEqual([scenario.project.id]);
  });

  it('scopes ?workspaceId to that workspace for an owner of several', async () => {
    const owner = await createUser();
    const first = await createWorkspace({ ownerId: owner.id });
    const second = await createWorkspace({ ownerId: owner.id });
    const wanted = await createProject({ ownerId: owner.id, workspaceId: first.id });
    await createProject({ ownerId: owner.id, workspaceId: second.id });

    const projects = await readData<{ projects: ListedProject[] }>(
      await listFor(owner.id, `?workspaceId=${first.id}`)
    );

    expect(projects.projects.map((entry) => entry.id)).toEqual([wanted.id]);
  });
});

describe('POST /api/projects', () => {
  it('returns 401 without a session', async () => {
    signedOut();

    const response = await callRoute(
      createProjectRoute,
      apiRequest('/api/projects', { body: { name: 'X', workspaceId: 'y' } })
    );

    expect(response.status).toBe(401);
    expect(await db.project.count()).toBe(0);
  });

  it.each([
    [{ workspaceId: 'w' }, 'a missing name'],
    [{ name: '   ', workspaceId: 'w' }, 'a blank name'],
    [{ name: 42, workspaceId: 'w' }, 'a non-string name'],
    [{ name: 'Valid' }, 'a missing workspaceId'],
    [{ name: 'Valid', workspaceId: 17 }, 'a non-string workspaceId'],
  ])('rejects %j with 400 (%s)', async (body, label) => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(createProjectRoute, apiRequest('/api/projects', { body }));

    expect(response.status, label).toBe(400);
    expect(await db.project.count()).toBe(0);
  });

  it('returns 404 for a workspace that does not exist', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(
      createProjectRoute,
      apiRequest('/api/projects', { body: { name: 'Orphan', workspaceId: 'no-such-workspace' } })
    );

    expect(response.status).toBe(404);
  });

  it('returns 403 for a workspace COMMENTATOR', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      createProjectRoute,
      apiRequest('/api/projects', {
        body: { name: 'Sneaky', workspaceId: scenario.workspace.id },
      })
    );

    expect(response.status).toBe(403);
    expect(await db.project.count()).toBe(1);
  });

  it('returns 403 when the workspace owner has lost billing access', async () => {
    const expiredOwner = await createExpiredUser();
    const workspace = await createWorkspace({ ownerId: expiredOwner.id });
    signedInAs(expiredOwner);

    const response = await callRoute(
      createProjectRoute,
      apiRequest('/api/projects', { body: { name: 'Blocked', workspaceId: workspace.id } })
    );

    expect(response.status).toBe(403);
    expect(await db.project.count()).toBe(0);
  });

  it('creates the project with the five default comment tags', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    signedInAs(owner);

    const response = await callRoute(
      createProjectRoute,
      apiRequest('/api/projects', {
        body: { name: 'My Project', description: '  spaced  ', workspaceId: workspace.id },
      })
    );

    expect(response.status).toBe(201);

    const stored = await db.project.findFirstOrThrow({ include: { commentTags: true } });
    expect(stored.name).toBe('My Project');
    expect(stored.description).toBe('spaced');
    expect(stored.slug).toBe('my-project');
    expect(stored.visibility).toBe('PRIVATE');
    expect(stored.allowDownloads).toBe(false);
    expect(stored.workspaceId).toBe(workspace.id);
    expect(stored.commentTags.map((tag) => tag.name).sort()).toEqual(
      DEFAULT_COMMENT_TAGS.map((tag) => tag.name).sort()
    );
    expect(stored.commentTags.map((tag) => tag.color).sort()).toEqual(
      DEFAULT_COMMENT_TAGS.map((tag) => tag.color).sort()
    );
  });

  // The row's owner is the workspace owner, never the caller: ownership drives
  // billing, and a workspace admin creating a project must not shift the bill.
  it('assigns the workspace owner as project owner when a workspace ADMIN creates it', async () => {
    const workspaceOwner = await createUser();
    const workspace = await createWorkspace({ ownerId: workspaceOwner.id });
    const admin = await createUser();
    await addWorkspaceMember({ workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' });
    signedInAs(admin);

    const response = await callRoute(
      createProjectRoute,
      apiRequest('/api/projects', {
        body: { name: 'Admin Project', workspaceId: workspace.id },
      })
    );

    expect(response.status).toBe(201);
    const stored = await db.project.findFirstOrThrow();
    expect(stored.ownerId).toBe(workspaceOwner.id);
    expect(stored.ownerId).not.toBe(admin.id);
  });

  it('ignores an ownerId, slug and id supplied by the caller', async () => {
    const owner = await createUser();
    const impostor = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    signedInAs(owner);

    const response = await callRoute(
      createProjectRoute,
      apiRequest('/api/projects', {
        body: {
          name: 'Clean Slate',
          workspaceId: workspace.id,
          id: 'attacker-chosen-id',
          ownerId: impostor.id,
          slug: 'attacker-chosen-slug',
          allowDownloads: true,
        },
      })
    );

    expect(response.status).toBe(201);
    const stored = await db.project.findFirstOrThrow();
    expect(stored.id).not.toBe('attacker-chosen-id');
    expect(stored.ownerId).toBe(owner.id);
    expect(stored.slug).toBe('clean-slate');
    expect(stored.allowDownloads).toBe(false);
  });

  // Subscribed rather than the default trial user: three projects is past the
  // trial's ceiling, and this test is about slugs, not about billing.
  it('gives two projects with the same name distinct slugs', async () => {
    const owner = await createSubscribedUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    signedInAs(owner);

    for (let index = 0; index < 3; index += 1) {
      const response = await callRoute(
        createProjectRoute,
        apiRequest('/api/projects', { body: { name: 'Same Name', workspaceId: workspace.id } })
      );
      expect(response.status).toBe(201);
    }

    const slugs = (await db.project.findMany({ select: { slug: true } })).map((row) => row.slug);
    expect(slugs.sort()).toEqual(['same-name', 'same-name-1', 'same-name-2']);
  });

  it('refuses a second project while the owner is on a free trial', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    await createProject({ ownerId: owner.id, workspaceId: workspace.id, name: 'First' });
    signedInAs(owner);

    const response = await callRoute(
      createProjectRoute,
      apiRequest('/api/projects', { body: { name: 'Second', workspaceId: workspace.id } })
    );

    expect(response.status).toBe(403);
    expect(await db.project.count()).toBe(1);
  });

  it('lets a paying owner past that ceiling', async () => {
    const owner = await createSubscribedUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    await createProject({ ownerId: owner.id, workspaceId: workspace.id, name: 'First' });
    signedInAs(owner);

    const response = await callRoute(
      createProjectRoute,
      apiRequest('/api/projects', { body: { name: 'Second', workspaceId: workspace.id } })
    );

    expect(response.status).toBe(201);
    expect(await db.project.count()).toBe(2);
  });

  // The ceiling belongs to the account being billed, so a workspace admin cannot
  // spend somebody else's trial allowance either.
  it('counts the ceiling against the workspace owner, not the caller', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    await createProject({ ownerId: owner.id, workspaceId: workspace.id, name: 'First' });
    const admin = await createUser();
    await addWorkspaceMember({ workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' });
    signedInAs(admin);

    const response = await callRoute(
      createProjectRoute,
      apiRequest('/api/projects', { body: { name: 'Second', workspaceId: workspace.id } })
    );

    expect(response.status).toBe(403);
    expect(await db.project.count()).toBe(1);
  });

  it('honours an explicit PUBLIC visibility', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    signedInAs(owner);

    const response = await callRoute(
      createProjectRoute,
      apiRequest('/api/projects', {
        body: { name: 'Open', workspaceId: workspace.id, visibility: 'PUBLIC' },
      })
    );

    expect(response.status).toBe(201);
    expect((await db.project.findFirstOrThrow()).visibility).toBe('PUBLIC');
  });
});

describe('GET /api/projects/[projectId]', () => {
  it('returns 404 for an unknown project', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(getProject, apiRequest('/api/projects/nope'), {
      projectId: 'nope',
    });

    expect(response.status).toBe(404);
  });

  it('returns 403 for a signed-in non-member on a PRIVATE project', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE' });
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      getProject,
      apiRequest(`/api/projects/${scenario.project.id}`),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
  });

  it('returns 403 for a signed-in non-member on an INVITE project', async () => {
    const scenario = await seedProject({ visibility: 'INVITE' });
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      getProject,
      apiRequest(`/api/projects/${scenario.project.id}`),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
  });

  it('returns 200 to an anonymous caller on a PUBLIC project', async () => {
    const scenario = await seedProject({ visibility: 'PUBLIC' });
    signedOut();

    const response = await callRoute(
      getProject,
      apiRequest(`/api/projects/${scenario.project.id}`),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);
  });

  it('returns 403 to the owner once their own billing access has lapsed', async () => {
    const expiredOwner = await createExpiredUser();
    const workspace = await createWorkspace({ ownerId: expiredOwner.id });
    const project = await createProject({ ownerId: expiredOwner.id, workspaceId: workspace.id });
    signedInAs(expiredOwner);

    const response = await callRoute(getProject, apiRequest(`/api/projects/${project.id}`), {
      projectId: project.id,
    });

    expect(response.status).toBe(403);
  });

  it.each([['limit=0'], ['limit=101'], ['offset=-1'], ['offset=10001'], ['offset=abc']])(
    'rejects ?%s with 400',
    async (query) => {
      const scenario = await seedProject();
      signedInAs(scenario.owner);

      const response = await callRoute(
        getProject,
        apiRequest(`/api/projects/${scenario.project.id}?${query}`),
        { projectId: scenario.project.id }
      );

      expect(response.status).toBe(400);
    }
  );

  it('paginates the embedded video list with limit and offset', async () => {
    const scenario = await seedProject();
    for (let position = 0; position < 3; position += 1) {
      await createVideo({ projectId: scenario.project.id, position });
    }
    signedInAs(scenario.owner);

    const response = await callRoute(
      getProject,
      apiRequest(`/api/projects/${scenario.project.id}?limit=2&offset=2`),
      { projectId: scenario.project.id }
    );
    const project = await readData<{ videos: Array<{ id: string }>; _count: { videos: number } }>(
      response
    );

    expect(response.status).toBe(200);
    expect(project.videos).toHaveLength(1);
    expect(project._count.videos).toBe(3);
  });
});

describe('PATCH /api/projects/[projectId]', () => {
  it('returns 401 without a session', async () => {
    const scenario = await seedProject();
    signedOut();

    const response = await callRoute(
      patchProject,
      apiRequest(`/api/projects/${scenario.project.id}`, {
        method: 'PATCH',
        body: { name: 'Renamed' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(401);
    expect((await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } })).name).toBe(
      scenario.project.name
    );
  });

  it('returns 403 for a project COMMENTATOR', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      patchProject,
      apiRequest(`/api/projects/${scenario.project.id}`, {
        method: 'PATCH',
        body: { name: 'Renamed by a commentator' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect((await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } })).name).toBe(
      scenario.project.name
    );
  });

  it('returns 403 for an unknown project rather than 404', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(
      patchProject,
      apiRequest('/api/projects/nope', { method: 'PATCH', body: { name: 'X' } }),
      { projectId: 'nope' }
    );

    expect(response.status).toBe(403);
  });

  it('lets a project ADMIN rename the project', async () => {
    const scenario = await seedProject();
    const admin = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: admin.id,
      role: 'ADMIN',
    });
    signedInAs(admin);

    const response = await callRoute(
      patchProject,
      apiRequest(`/api/projects/${scenario.project.id}`, {
        method: 'PATCH',
        body: { name: '  Renamed  ', description: '  new description  ', allowDownloads: true },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);
    const stored = await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } });
    expect(stored.name).toBe('Renamed');
    expect(stored.description).toBe('new description');
    expect(stored.allowDownloads).toBe(true);
  });

  it('lets a workspace ADMIN edit a project they are not a member of', async () => {
    const scenario = await seedProject();
    const workspaceAdmin = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: workspaceAdmin.id,
      role: 'ADMIN',
    });
    signedInAs(workspaceAdmin);

    const response = await callRoute(
      patchProject,
      apiRequest(`/api/projects/${scenario.project.id}`, {
        method: 'PATCH',
        body: { visibility: 'PUBLIC' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);
    expect(
      (await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } })).visibility
    ).toBe('PUBLIC');
  });

  it.each([
    [{ name: '' }, 'an empty name'],
    [{ name: 'x'.repeat(101) }, 'a name over 100 characters'],
    [{ description: 'x'.repeat(1001) }, 'a description over 1000 characters'],
    [{ description: 5 }, 'a non-string description'],
    [{ visibility: 'SEMI_PRIVATE' }, 'an unknown visibility'],
    [{ allowDownloads: 'yes' }, 'a non-boolean allowDownloads'],
  ])('rejects %j with 400 (%s)', async (body, label) => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchProject,
      apiRequest(`/api/projects/${scenario.project.id}`, { method: 'PATCH', body }),
      { projectId: scenario.project.id }
    );

    expect(response.status, label).toBe(400);
    const stored = await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } });
    expect(stored.name).toBe(scenario.project.name);
    expect(stored.visibility).toBe(scenario.project.visibility);
  });

  it('ignores an ownerId and a workspaceId in the body', async () => {
    const scenario = await seedProject();
    const other = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchProject,
      apiRequest(`/api/projects/${scenario.project.id}`, {
        method: 'PATCH',
        body: {
          name: 'Still Mine',
          ownerId: other.owner.id,
          workspaceId: other.workspace.id,
        },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);
    const stored = await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } });
    expect(stored.ownerId).toBe(scenario.owner.id);
    expect(stored.workspaceId).toBe(scenario.workspace.id);
  });
});

describe('DELETE /api/projects/[projectId]', () => {
  beforeEach(() => {
    signedOut();
  });

  it('returns 401 without a session', async () => {
    const scenario = await seedProject();

    const response = await callRoute(
      deleteProject,
      apiRequest(`/api/projects/${scenario.project.id}`, { method: 'DELETE' }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(401);
    expect(await db.project.count()).toBe(1);
  });

  it('returns 404 for an unknown project', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(
      deleteProject,
      apiRequest('/api/projects/nope', { method: 'DELETE' }),
      { projectId: 'nope' }
    );

    expect(response.status).toBe(404);
  });

  // canDelete is deliberately narrower than canEdit: a project ADMIN may rename
  // and configure the project but may not destroy it.
  it('returns 403 for a project ADMIN', async () => {
    const scenario = await seedProject();
    const admin = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: admin.id, role: 'ADMIN' });
    signedInAs(admin);

    const response = await callRoute(
      deleteProject,
      apiRequest(`/api/projects/${scenario.project.id}`, { method: 'DELETE' }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.project.count()).toBe(1);
  });

  it('returns 403 for a workspace ADMIN who is not the workspace owner', async () => {
    const scenario = await seedProject();
    const workspaceAdmin = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: workspaceAdmin.id,
      role: 'ADMIN',
    });
    signedInAs(workspaceAdmin);

    const response = await callRoute(
      deleteProject,
      apiRequest(`/api/projects/${scenario.project.id}`, { method: 'DELETE' }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.project.count()).toBe(1);
  });

  it('deletes the project and cascades to its videos for the owner', async () => {
    const scenario = await seedProject();
    await createVideo({ projectId: scenario.project.id });
    signedInAs(scenario.owner);

    const response = await callRoute(
      deleteProject,
      apiRequest(`/api/projects/${scenario.project.id}`, { method: 'DELETE' }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);
    expect(await db.project.count()).toBe(0);
    expect(await db.video.count()).toBe(0);
  });

  it('lets the workspace owner delete a project owned by someone else', async () => {
    const workspaceOwner = await createUser();
    const workspace = await createWorkspace({ ownerId: workspaceOwner.id });
    const projectOwner = await createUser();
    const project = await createProject({
      ownerId: projectOwner.id,
      workspaceId: workspace.id,
    });
    signedInAs(workspaceOwner);

    const response = await callRoute(
      deleteProject,
      apiRequest(`/api/projects/${project.id}`, { method: 'DELETE' }),
      { projectId: project.id }
    );

    expect(response.status).toBe(200);
    expect(await db.project.count()).toBe(0);
  });
});
