// Personal access tokens: the settings routes that manage them, the scopes that
// decide what a token may do, and the routes that accept one in place of a
// browser session.
//
// Tokens are inserted with a hash computed here, independently of
// lib/api-tokens.ts, so a change to how the library hashes shows up as a
// refused token rather than agreeing with itself.

import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getSession, withApiToken } from '@/lib/api-tokens';
import { GET as listTokens, POST as createToken } from '@/app/api/settings/api-tokens/route';
import { DELETE as revokeToken } from '@/app/api/settings/api-tokens/[tokenId]/route';
import { GET as listProjects, POST as createProject } from '@/app/api/projects/route';
import {
  DELETE as cancelBunnyUpload,
  POST as initBunnyUpload,
} from '@/app/api/projects/[projectId]/videos/bunny-init/route';
import { POST as initR2Upload } from '@/app/api/projects/[projectId]/videos/r2-init/route';
import { POST as completeR2Upload } from '@/app/api/projects/[projectId]/videos/r2-complete/route';
import { GET as listVideos, POST as addVideo } from '@/app/api/projects/[projectId]/videos/route';
import {
  GET as listVersions,
  POST as addVersion,
} from '@/app/api/projects/[projectId]/videos/[videoId]/versions/route';
import { GET as getBilling } from '@/app/api/billing/route';
import { GET as getProject, PATCH as updateProject } from '@/app/api/projects/[projectId]/route';
import {
  DELETE as deleteVideo,
  GET as getVideo,
} from '@/app/api/projects/[projectId]/videos/[videoId]/route';
import { POST as moveVideos } from '@/app/api/projects/[projectId]/videos/move/route';
import { GET as watchVideo } from '@/app/api/watch/[videoId]/route';
import { PATCH as updateComment } from '@/app/api/comments/[commentId]/route';
import {
  GET as listComments,
  POST as addComment,
} from '@/app/api/versions/[versionId]/comments/route';
import { GET as listAssets } from '@/app/api/videos/[videoId]/assets/route';
import { GET as listProjectMembers } from '@/app/api/projects/[projectId]/members/route';
import { GET as listApprovalCandidates } from '@/app/api/projects/[projectId]/approval-candidates/route';
import { GET as downloadVersion } from '@/app/api/versions/[versionId]/download/route';
import { POST as folderAction } from '@/app/api/projects/[projectId]/folders/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createComment,
  createExpiredUser,
  createSubscribedUser,
  createUser,
  createVideo,
  seedProject,
  seedVersion,
} from '../factories';

const ORIGIN = { origin: 'http://localhost:3000' };

// Written out rather than imported from lib/api-token-scopes.ts, so that
// dropping a scope from the library fails here instead of agreeing with itself.
const ALL_SCOPES = [
  'read',
  'upload',
  'manage',
  'delete',
  'comments:read',
  'comments:write',
  'approvals',
  'share',
  'download',
] as const;

/** A well-formed token: the prefix plus 43 base64url characters. */
function tokenLiteral(fill: string): string {
  return `of_pat_${fill.repeat(43)}`;
}

async function insertToken(userId: string, token: string, scopes: string[] = ['read', 'upload']) {
  return db.apiToken.create({
    data: {
      userId,
      name: 'Script',
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      prefix: token.slice(0, 13),
      scopes,
    },
  });
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function versionRequest(projectId: string, videoId: string, token: string, body?: unknown) {
  return apiRequest(`/api/projects/${projectId}/videos/${videoId}/versions`, {
    headers: bearer(token),
    body: body ?? {
      videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      versionLabel: 'From a script',
      setActive: true,
    },
  });
}

describe('POST /api/settings/api-tokens', () => {
  it('refuses a caller with no session', async () => {
    signedOut();

    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: ORIGIN,
        body: { scopes: ['read'], name: 'CI' },
      })
    );

    expect(response.status).toBe(401);
    expect(await db.apiToken.count()).toBe(0);
  });

  it('cannot be called with a token instead of a session', async () => {
    const user = await createSubscribedUser();
    const token = tokenLiteral('a');
    await insertToken(user.id, token);
    signedOut();

    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: { ...ORIGIN, ...bearer(token) },
        body: { scopes: ['read'], name: 'Minted by a token' },
      })
    );

    expect(response.status).toBe(401);
    expect(await db.apiToken.count()).toBe(1);
  });

  it('refuses a cross-origin request', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);

    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: { origin: 'https://evil.example' },
        body: { scopes: ['read'], name: 'CI' },
      })
    );

    expect(response.status).toBe(403);
    expect(await db.apiToken.count()).toBe(0);
  });

  it('lets an account on a free trial create a token', async () => {
    const user = await createUser({ trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) });
    signedInAs(user);

    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: ORIGIN,
        body: { scopes: ['read'], name: 'CI' },
      })
    );

    expect(response.status).toBe(201);
    expect(await db.apiToken.count({ where: { userId: user.id } })).toBe(1);
  });

  it('refuses a subscription whose first payment never went through', async () => {
    const user = await createSubscribedUser({ subscriptionStatus: 'INCOMPLETE' });
    signedInAs(user);

    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: ORIGIN,
        body: { scopes: ['read'], name: 'CI' },
      })
    );

    expect(response.status).toBe(403);
    expect(await db.apiToken.count()).toBe(0);
  });

  it('refuses an account whose billing access has ended, but still lets it list and revoke', async () => {
    const user = await createExpiredUser();
    const existing = await insertToken(user.id, tokenLiteral('e'));
    signedInAs(user);

    const created = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: ORIGIN,
        body: { scopes: ['read'], name: 'CI' },
      })
    );
    expect(created.status).toBe(403);
    expect(await db.apiToken.count({ where: { userId: user.id } })).toBe(1);

    const listed = await callRoute(listTokens, apiRequest('/api/settings/api-tokens'));
    expect(listed.status).toBe(200);
    const { tokens, canCreate } = await readData<{ tokens: { id: string }[]; canCreate: boolean }>(
      listed
    );
    expect(tokens.map((token) => token.id)).toEqual([existing.id]);
    expect(canCreate).toBe(false);

    const revoked = await callRoute(
      revokeToken,
      apiRequest(`/api/settings/api-tokens/${existing.id}`, { method: 'DELETE', headers: ORIGIN }),
      { tokenId: existing.id }
    );
    expect(revoked.status).toBe(200);
    expect(await db.apiToken.count({ where: { userId: user.id } })).toBe(0);
  });

  describe('an editor without a plan of their own', () => {
    // The owner is on Studio because that is where a team of editors lives. The rule
    // itself reads the owner's billing access, not the plan: a non-founding Solo
    // account has no editor but its owner, so nobody else can qualify through it.
    async function studioTeam(ownerInput: Parameters<typeof createSubscribedUser>[0] = {}) {
      const owner = await createSubscribedUser(ownerInput);
      await db.user.update({ where: { id: owner.id }, data: { billingPlan: 'STUDIO' } });
      const scenario = await seedProject({ ownerUser: owner });
      const folder = await db.projectFolder.create({
        data: { projectId: scenario.project.id, name: 'Cuts' },
      });
      const video = await createVideo({ projectId: scenario.project.id });
      const member = await createExpiredUser();
      return { ...scenario, folder, video, member };
    }

    type Team = Awaited<ReturnType<typeof studioTeam>>;
    type Level = 'workspace' | 'project' | 'folder' | 'video';

    async function join(team: Team, level: Level, role: 'ADMIN' | 'COMMENTATOR') {
      const userId = team.member.id;
      if (level === 'workspace') {
        await addWorkspaceMember({ workspaceId: team.workspace.id, userId, role });
      } else if (level === 'project') {
        await addProjectMember({ projectId: team.project.id, userId, role });
      } else if (level === 'folder') {
        await db.projectFolderMember.create({ data: { folderId: team.folder.id, userId, role } });
      } else {
        await db.videoMember.create({ data: { videoId: team.video.id, userId, role } });
      }
    }

    function create() {
      return callRoute(
        createToken,
        apiRequest('/api/settings/api-tokens', {
          headers: ORIGIN,
          body: { scopes: ['read', 'upload'], name: 'Team agent' },
        })
      );
    }

    async function listCanCreate() {
      const response = await callRoute(listTokens, apiRequest('/api/settings/api-tokens'));
      expect(response.status).toBe(200);
      return (await readData<{ canCreate: boolean }>(response)).canCreate;
    }

    for (const level of ['workspace', 'project', 'folder', 'video'] as const) {
      it(`can create a token as a ${level} editor on a paying account`, async () => {
        const team = await studioTeam();
        await join(team, level, 'ADMIN');
        signedInAs(team.member);

        expect(await listCanCreate()).toBe(true);
        const response = await create();

        expect(response.status).toBe(201);
        expect(await db.apiToken.count({ where: { userId: team.member.id } })).toBe(1);
      });

      it(`cannot as a ${level} reviewer on that same paying account`, async () => {
        const team = await studioTeam();
        await join(team, level, 'COMMENTATOR');
        signedInAs(team.member);

        expect(await listCanCreate()).toBe(false);
        const response = await create();

        expect(response.status).toBe(403);
        expect(await db.apiToken.count({ where: { userId: team.member.id } })).toBe(0);
      });
    }

    it('can create a token as the owner of a project in a paying workspace', async () => {
      const team = await studioTeam();
      await db.project.update({
        where: { id: team.project.id },
        data: { ownerId: team.member.id },
      });
      signedInAs(team.member);

      expect(await listCanCreate()).toBe(true);
      const response = await create();

      expect(response.status).toBe(201);
      expect(await db.apiToken.count({ where: { userId: team.member.id } })).toBe(1);
    });

    it('cannot once the account they edit for has lapsed', async () => {
      const team = await studioTeam({
        subscriptionStatus: 'CANCELED',
        stripeCurrentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
      await join(team, 'workspace', 'ADMIN');
      signedInAs(team.member);

      expect(await listCanCreate()).toBe(false);
      const response = await create();

      expect(response.status).toBe(403);
      expect(await db.apiToken.count({ where: { userId: team.member.id } })).toBe(0);
    });
  });

  it('lets anyone create a token when this host runs without billing', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');
    const user = await createExpiredUser();
    signedInAs(user);

    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: ORIGIN,
        body: { scopes: ['read'], name: 'Self-hosted' },
      })
    );

    expect(response.status).toBe(201);
    expect(await db.apiToken.count({ where: { userId: user.id } })).toBe(1);
  });

  it('returns the plaintext once and stores only its SHA-256', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);

    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: ORIGIN,
        body: { scopes: ['read'], name: '  Render box  ' },
      })
    );

    expect(response.status).toBe(201);
    const data = await readData<Record<string, string>>(response);
    expect(data.token).toMatch(/^of_pat_[A-Za-z0-9_-]{43}$/);
    expect(data).not.toHaveProperty('tokenHash');

    const row = await db.apiToken.findUniqueOrThrow({ where: { id: data.id } });
    expect(row.userId).toBe(user.id);
    expect(row.name).toBe('Render box');
    expect(row.tokenHash).toBe(createHash('sha256').update(data.token, 'utf8').digest('hex'));
    expect(row.prefix).toBe(data.token.slice(0, 13));
  });

  it('refuses a token with no permissions', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);

    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: ORIGIN,
        body: { name: 'Bare', scopes: [] },
      })
    );

    expect(response.status).toBe(400);
    expect(await db.apiToken.count()).toBe(0);
  });

  it('refuses a permission that does not exist, such as billing', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);

    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: ORIGIN,
        body: { name: 'Greedy', scopes: ['read', 'billing'] },
      })
    );

    expect(response.status).toBe(400);
    expect(await db.apiToken.count()).toBe(0);
  });

  it('stores the chosen permissions once each, in a fixed order', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);

    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: ORIGIN,
        body: { name: 'Agent', scopes: ['download', 'read', 'comments:write', 'read'] },
      })
    );

    expect(response.status).toBe(201);
    const row = await db.apiToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.scopes).toEqual(['read', 'comments:write', 'download']);
  });

  it('refuses an empty name', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);

    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: ORIGIN,
        body: { scopes: ['read'], name: '   ' },
      })
    );

    expect(response.status).toBe(400);
    expect(await db.apiToken.count()).toBe(0);
  });

  it('refuses a name longer than 60 characters', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);

    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: ORIGIN,
        body: { scopes: ['read'], name: 'n'.repeat(61) },
      })
    );

    expect(response.status).toBe(400);
    expect(await db.apiToken.count()).toBe(0);
  });

  it('counts the cap per user, not across the whole instance', async () => {
    const busy = await createSubscribedUser();
    for (let i = 0; i < 10; i += 1) {
      await insertToken(busy.id, tokenLiteral(String.fromCharCode(98 + i)));
    }
    const fresh = await createSubscribedUser();
    signedInAs(fresh);

    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: ORIGIN,
        body: { scopes: ['read'], name: 'First' },
      })
    );

    expect(response.status).toBe(201);
    expect(await db.apiToken.count({ where: { userId: fresh.id } })).toBe(1);
  });

  // Firing parallel requests does not prove the lock: they rarely interleave in
  // a test run, and the version of this test that did passed with the lock
  // deleted. Holding the lock from an independent connection does. The request
  // has to be seen waiting on it, and has to read the count only after it is
  // released, by which time the tenth token already exists.
  it('counts under a per-user lock, so a token added meanwhile is seen', async () => {
    const user = await createSubscribedUser();
    for (let i = 0; i < 9; i += 1) {
      await insertToken(user.id, tokenLiteral(String.fromCharCode(98 + i)));
    }
    signedInAs(user);

    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const connection = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `api-tokens:${user.id}`,
      ]);
      pending = callRoute(
        createToken,
        apiRequest('/api/settings/api-tokens', {
          headers: ORIGIN,
          body: { scopes: ['read'], name: 'Racer' },
        })
      );
      void pending.catch(() => {});
      await vi.waitFor(
        async () => {
          const rows = await db.$queryRaw<{ waiting: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
            ) AS waiting
          `;
          expect(rows).toEqual([{ waiting: true }]);
        },
        { timeout: 2_000, interval: 20 }
      );
      await insertToken(user.id, tokenLiteral('z'));
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await pool.end();
    }

    const response = await pending!;
    expect(response.status).toBe(400);
    expect(await db.apiToken.count({ where: { userId: user.id } })).toBe(10);
  });

  it('stops at ten tokens per user', async () => {
    const user = await createSubscribedUser();
    for (let i = 0; i < 10; i += 1) {
      await insertToken(user.id, tokenLiteral(String.fromCharCode(98 + i)));
    }
    signedInAs(user);

    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', {
        headers: ORIGIN,
        body: { scopes: ['read'], name: 'Eleventh' },
      })
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('at most 10');
    expect(await db.apiToken.count({ where: { userId: user.id } })).toBe(10);
  });
});

describe('GET /api/settings/api-tokens', () => {
  it("lists the caller's own tokens without their hashes", async () => {
    const user = await createUser();
    const other = await createUser();
    const mine = await insertToken(user.id, tokenLiteral('m'));
    await insertToken(other.id, tokenLiteral('o'));
    signedInAs(user);

    const data = await readData<{ tokens: Array<Record<string, unknown>>; canCreate: boolean }>(
      await callRoute(listTokens, apiRequest('/api/settings/api-tokens'))
    );

    expect(data.tokens.map((token) => token.id)).toEqual([mine.id]);
    expect(data.canCreate).toBe(true);
    expect(data.tokens[0]).not.toHaveProperty('tokenHash');
  });
});

describe('token management is session-only', () => {
  it('will not list tokens for a caller holding only a token', async () => {
    const user = await createUser();
    const token = tokenLiteral('l');
    await insertToken(user.id, token);
    signedOut();

    const response = await callRoute(
      listTokens,
      apiRequest('/api/settings/api-tokens', { headers: bearer(token) })
    );

    expect(response.status).toBe(401);
  });

  it('will not revoke a token for a caller holding only that token', async () => {
    const user = await createUser();
    const token = tokenLiteral('k');
    const row = await insertToken(user.id, token);
    signedOut();

    const response = await callRoute(
      revokeToken,
      apiRequest(`/api/settings/api-tokens/${row.id}`, {
        method: 'DELETE',
        headers: { ...ORIGIN, ...bearer(token) },
      }),
      { tokenId: row.id }
    );

    expect(response.status).toBe(401);
    expect(await db.apiToken.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
});

describe('DELETE /api/settings/api-tokens/[tokenId]', () => {
  it("answers 404 for someone else's token and leaves it in place", async () => {
    const owner = await createUser();
    const intruder = await createUser();
    const row = await insertToken(owner.id, tokenLiteral('d'));
    signedInAs(intruder);

    const response = await callRoute(
      revokeToken,
      apiRequest(`/api/settings/api-tokens/${row.id}`, { method: 'DELETE', headers: ORIGIN }),
      { tokenId: row.id }
    );

    expect(response.status).toBe(404);
    expect(await db.apiToken.findUnique({ where: { id: row.id } })).not.toBeNull();
  });

  it('revokes the caller’s own token', async () => {
    const owner = await createUser();
    const row = await insertToken(owner.id, tokenLiteral('e'));
    signedInAs(owner);

    const response = await callRoute(
      revokeToken,
      apiRequest(`/api/settings/api-tokens/${row.id}`, { method: 'DELETE', headers: ORIGIN }),
      { tokenId: row.id }
    );

    expect(response.status).toBe(200);
    expect(await db.apiToken.findUnique({ where: { id: row.id } })).toBeNull();
  });
});

describe('a token on the version upload routes', () => {
  it('adds a version as the token owner, with no session at all', async () => {
    const scenario = await seedVersion();
    const token = tokenLiteral('v');
    const row = await insertToken(scenario.owner.id, token);
    signedOut();

    const response = await callRoute(
      addVersion,
      versionRequest(scenario.project.id, scenario.video.id, token),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(response.status).toBe(201);
    const versions = await db.videoVersion.findMany({
      where: { videoParentId: scenario.video.id },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2]);
    expect(versions[1].versionLabel).toBe('From a script');
    expect(versions[1].isActive).toBe(true);
    // The write is fire-and-forget, so wait for it rather than racing it.
    const firstUse = await vi.waitFor(async () => {
      const used = await db.apiToken.findUniqueOrThrow({ where: { id: row.id } });
      expect(used.lastUsedAt).not.toBeNull();
      return used.lastUsedAt!;
    });

    // A second call inside the minute leaves the timestamp alone.
    await callRoute(listProjects, apiRequest('/api/projects', { headers: bearer(token) }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await db.apiToken.findUniqueOrThrow({ where: { id: row.id } });
    expect(again.lastUsedAt?.getTime()).toBe(firstUse.getTime());
  });

  it('refuses a token held by a COMMENTATOR, who can view but not edit, and adds nothing', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const viewer = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: viewer.id,
      role: 'COMMENTATOR',
    });
    const token = tokenLiteral('x');
    await insertToken(viewer.id, token);
    signedOut();

    const response = await callRoute(
      addVersion,
      versionRequest(scenario.project.id, scenario.video.id, token),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.videoVersion.count({ where: { videoParentId: scenario.video.id } })).toBe(1);
  });

  it('refuses a revoked token even while the owner is signed in on the same machine', async () => {
    const scenario = await seedVersion();
    const token = tokenLiteral('r');
    const row = await insertToken(scenario.owner.id, token);
    await db.apiToken.delete({ where: { id: row.id } });
    signedInAs(scenario.owner);

    const response = await callRoute(
      addVersion,
      versionRequest(scenario.project.id, scenario.video.id, token),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(response.status).toBe(401);
    expect(await db.videoVersion.count({ where: { videoParentId: scenario.video.id } })).toBe(1);
  });

  it('refuses a malformed OpenFrame token rather than using the session', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      addVersion,
      apiRequest(`/api/projects/${scenario.project.id}/videos/${scenario.video.id}/versions`, {
        headers: { authorization: 'Bearer of_pat_too-short' },
        body: { videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(response.status).toBe(401);
    expect(await db.videoVersion.count({ where: { videoParentId: scenario.video.id } })).toBe(1);
  });

  it('leaves a signed-in browser alone behind a basic-auth proxy', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      addVersion,
      apiRequest(`/api/projects/${scenario.project.id}/videos/${scenario.video.id}/versions`, {
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
        body: { videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(response.status).toBe(201);
    expect(await db.videoVersion.count({ where: { videoParentId: scenario.video.id } })).toBe(2);
  });

  it("lists the token owner's projects and nobody else's", async () => {
    const scenario = await seedVersion();
    await seedProject();
    const token = tokenLiteral('p');
    await insertToken(scenario.owner.id, token);
    signedOut();

    const data = await readData<{ projects: Array<{ id: string }> }>(
      await callRoute(listProjects, apiRequest('/api/projects', { headers: bearer(token) }))
    );

    expect(data.projects.map((project) => project.id)).toEqual([scenario.project.id]);
  });

  it('lists the videos and versions of a PRIVATE project the owner can see', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const token = tokenLiteral('q');
    await insertToken(scenario.owner.id, token);
    signedOut();

    const videos = await readData<{ videos: Array<{ id: string }> }>(
      await callRoute(
        listVideos,
        apiRequest(`/api/projects/${scenario.project.id}/videos`, { headers: bearer(token) }),
        { projectId: scenario.project.id }
      )
    );
    const versions = await readData<{ versions: Array<{ id: string }> }>(
      await callRoute(
        listVersions,
        apiRequest(`/api/projects/${scenario.project.id}/videos/${scenario.video.id}/versions`, {
          headers: bearer(token),
        }),
        { projectId: scenario.project.id, videoId: scenario.video.id }
      )
    );

    expect(videos.videos.map((video) => video.id)).toEqual([scenario.video.id]);
    expect(versions.versions.map((version) => version.id)).toEqual([scenario.version.id]);
  });

  it('answers 401 to a revoked token on a PUBLIC listing instead of treating it as anonymous', async () => {
    const scenario = await seedVersion({ visibility: 'PUBLIC' });
    const token = tokenLiteral('g');
    const row = await insertToken(scenario.owner.id, token);
    await db.apiToken.delete({ where: { id: row.id } });
    signedOut();

    const videos = await callRoute(
      listVideos,
      apiRequest(`/api/projects/${scenario.project.id}/videos`, { headers: bearer(token) }),
      { projectId: scenario.project.id }
    );
    const versions = await callRoute(
      listVersions,
      apiRequest(`/api/projects/${scenario.project.id}/videos/${scenario.video.id}/versions`, {
        headers: bearer(token),
      }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(videos.status).toBe(401);
    expect(versions.status).toBe(401);
  });

  it('gets a 401 from billing, which only ever reads the browser session', async () => {
    const user = await createUser();
    const token = tokenLiteral('z');
    await insertToken(user.id, token, [...ALL_SCOPES]);
    signedOut();

    const response = await callRoute(
      getBilling,
      apiRequest('/api/billing', { headers: bearer(token) })
    );

    expect(response.status).toBe(401);
  });
});

describe('a token through the whole Bunny upload', () => {
  beforeEach(() => {
    vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'true');
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'false');
    vi.stubEnv('BUNNY_STREAM_API_KEY', 'test-bunny-key');
    vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '424242');
    vi.stubEnv('BUNNY_UPLOAD_TOKEN_SECRET', 'test-bunny-upload-token-secret');
    vi.stubEnv('BUNNY_CDN_URL', 'https://cdn.bunny.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ guid: 'bunny-guid-from-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function bunnyInit(projectId: string, token: string, body: Record<string, unknown>) {
    return callRoute(
      initBunnyUpload,
      apiRequest(`/api/projects/${projectId}/videos/bunny-init`, { headers: bearer(token), body }),
      { projectId }
    );
  }

  it('lets the token that started an upload abandon it and release the storage', async () => {
    const scenario = await seedVersion();
    const token = tokenLiteral('u');
    await insertToken(scenario.owner.id, token);
    signedOut();

    const init = await readData<{ videoId: string; uploadToken: string }>(
      await bunnyInit(scenario.project.id, token, {
        targetVideoId: scenario.video.id,
        title: 'abandoned.mp4',
        sizeBytes: '4096',
      })
    );
    expect(await db.uploadReservation.count()).toBe(1);

    const response = await callRoute(
      cancelBunnyUpload,
      apiRequest(`/api/projects/${scenario.project.id}/videos/bunny-init`, {
        method: 'DELETE',
        headers: bearer(token),
        body: { videoId: init.videoId, uploadToken: init.uploadToken },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('hands back ready-made URLs and a grant the version route accepts', async () => {
    const scenario = await seedVersion();
    const token = tokenLiteral('b');
    await insertToken(scenario.owner.id, token);
    signedOut();

    const initResponse = await callRoute(
      initBunnyUpload,
      apiRequest(`/api/projects/${scenario.project.id}/videos/bunny-init`, {
        headers: bearer(token),
        body: { targetVideoId: scenario.video.id, title: 'cut-v2.mp4', sizeBytes: '4096' },
      }),
      { projectId: scenario.project.id }
    );
    expect(initResponse.status).toBe(200);
    const init = await readData<{
      videoId: string;
      uploadToken: string;
      videoUrl: string;
      thumbnailUrl: string | null;
    }>(initResponse);
    expect(init.videoUrl).toBe(
      'https://iframe.mediadelivery.net/embed/424242/bunny-guid-from-token'
    );
    expect(init.thumbnailUrl).toBe('https://cdn.bunny.test/bunny-guid-from-token/thumbnail.jpg');

    const versionResponse = await callRoute(
      addVersion,
      versionRequest(scenario.project.id, scenario.video.id, token, {
        videoUrl: init.videoUrl,
        thumbnailUrl: init.thumbnailUrl,
        providerId: 'bunny',
        providerVideoId: init.videoId,
        uploadToken: init.uploadToken,
        setActive: true,
      }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(versionResponse.status).toBe(201);
    const created = await db.videoVersion.findFirstOrThrow({
      where: { videoParentId: scenario.video.id, versionNumber: 2 },
    });
    expect(created.providerId).toBe('bunny');
    expect(created.videoId).toBe('bunny-guid-from-token');
    expect(created.sizeBytes).toBe(BigInt(4096));
    expect(await db.uploadReservation.count()).toBe(0);
  });
});

describe('a token through the whole multipart S3/R2 upload', () => {
  beforeEach(() => {
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'true');
    vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'false');
    vi.stubEnv('R2_ACCESS_KEY_ID', 'test-access-key');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test-secret-key');
    vi.stubEnv('R2_BUCKET_NAME', 'openframe-test');
    vi.stubEnv('R2_ACCOUNT_ID', 'test-account');
    vi.stubEnv('OPENFRAME_R2_MULTIPART_THRESHOLD_BYTES', '512');
    vi.stubEnv('OPENFRAME_R2_MULTIPART_PART_SIZE_BYTES', String(5 * 1024 * 1024));
  });

  it('inits, completes and registers a version with nothing but the token', async () => {
    const scenario = await seedVersion();
    const token = tokenLiteral('s');
    await insertToken(scenario.owner.id, token);
    signedOut();

    const initResponse = await callRoute(
      initR2Upload,
      apiRequest(`/api/projects/${scenario.project.id}/videos/r2-init`, {
        headers: bearer(token),
        body: {
          targetVideoId: scenario.video.id,
          fileName: 'cut-v2.mp4',
          sizeBytes: '2048',
          contentType: 'video/mp4',
        },
      }),
      { projectId: scenario.project.id }
    );
    expect(initResponse.status).toBe(200);
    const init = await readData<{
      objectKey: string;
      proxyUrl: string;
      uploadToken: string;
      multipart: { parts: Array<{ partNumber: number }> };
    }>(initResponse);
    expect(init.multipart.parts.map((part) => part.partNumber)).toEqual([1]);

    const completeResponse = await callRoute(
      completeR2Upload,
      apiRequest(`/api/projects/${scenario.project.id}/videos/r2-complete`, {
        headers: bearer(token),
        body: {
          objectKey: init.objectKey,
          uploadToken: init.uploadToken,
          parts: [{ partNumber: 1, etag: 'etag-1' }],
        },
      }),
      { projectId: scenario.project.id }
    );
    expect(completeResponse.status).toBe(200);

    const versionResponse = await callRoute(
      addVersion,
      versionRequest(scenario.project.id, scenario.video.id, token, {
        videoUrl: init.proxyUrl,
        providerId: 'r2',
        objectKey: init.objectKey,
        uploadToken: init.uploadToken,
        setActive: true,
      }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(versionResponse.status).toBe(201);
    const created = await db.videoVersion.findFirstOrThrow({
      where: { videoParentId: scenario.video.id, versionNumber: 2 },
    });
    expect(created.providerId).toBe('r2');
    expect(created.videoId).toBe(init.objectKey);
    const session = await db.videoUploadSession.findFirstOrThrow();
    expect(session.status).toBe('FINALIZED');
    expect(session.userId).toBe(scenario.owner.id);
  });
});

describe('what each permission opens, and what it leaves shut', () => {
  it('read: opens a PRIVATE project, and nothing without it', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE' });
    const reader = tokenLiteral('R');
    const uploader = tokenLiteral('U');
    await insertToken(scenario.owner.id, reader, ['read']);
    await insertToken(scenario.owner.id, uploader, ['upload']);
    signedOut();

    const call = (token: string) =>
      callRoute(
        getProject,
        apiRequest(`/api/projects/${scenario.project.id}`, { headers: bearer(token) }),
        { projectId: scenario.project.id }
      );
    const allowed = await call(reader);
    const refused = await call(uploader);

    expect(allowed.status).toBe(200);
    expect((await readData<{ id: string }>(allowed)).id).toBe(scenario.project.id);
    expect(refused.status).toBe(403);
    expect(await readError(refused)).toContain('"read"');
  });

  it('read: carries the token owner into helpers that read the session themselves', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const token = tokenLiteral('A');
    await insertToken(scenario.owner.id, token, ['read']);
    signedOut();

    const response = await callRoute(
      listAssets,
      apiRequest(`/api/videos/${scenario.video.id}/assets`, { headers: bearer(token) }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(200);
  });

  it('manage: creates a project, and a read-only token cannot', async () => {
    // A paying owner, because a trial account is held to one project at a time.
    const scenario = await seedProject({ ownerUser: await createSubscribedUser() });
    const manager = tokenLiteral('M');
    const reader = tokenLiteral('N');
    await insertToken(scenario.owner.id, manager, ['manage']);
    await insertToken(scenario.owner.id, reader, ['read']);
    signedOut();

    const create = (token: string, name: string) =>
      callRoute(
        createProject,
        apiRequest('/api/projects', {
          headers: bearer(token),
          body: { name, workspaceId: scenario.workspace.id },
        })
      );
    const refused = await create(reader, 'Refused project');
    const allowed = await create(manager, 'Scripted project');

    expect(refused.status).toBe(403);
    expect(allowed.status).toBe(201);
    const names = (await db.project.findMany({ select: { name: true } })).map((p) => p.name);
    expect(names.sort()).toEqual([scenario.project.name, 'Scripted project'].sort());
  });

  it('upload: creates a new video, and a manage token cannot', async () => {
    const scenario = await seedProject();
    const uploader = tokenLiteral('V');
    const manager = tokenLiteral('W');
    await insertToken(scenario.owner.id, uploader, ['upload']);
    await insertToken(scenario.owner.id, manager, ['manage']);
    signedOut();

    const add = (token: string) =>
      callRoute(
        addVideo,
        apiRequest(`/api/projects/${scenario.project.id}/videos`, {
          headers: bearer(token),
          body: {
            title: 'Scripted video',
            videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          },
        }),
        { projectId: scenario.project.id }
      );
    const refused = await add(manager);
    const allowed = await add(uploader);

    expect(refused.status).toBe(403);
    expect(allowed.status).toBe(201);
    expect(await db.video.count({ where: { projectId: scenario.project.id } })).toBe(1);
  });

  it('delete: removes a video, and a token with every other permission cannot', async () => {
    const scenario = await seedVersion();
    const deleter = tokenLiteral('D');
    const everythingElse = tokenLiteral('E');
    await insertToken(scenario.owner.id, deleter, ['delete']);
    await insertToken(
      scenario.owner.id,
      everythingElse,
      ALL_SCOPES.filter((scope) => scope !== 'delete')
    );
    signedOut();

    const remove = (token: string) =>
      callRoute(
        deleteVideo,
        apiRequest(`/api/projects/${scenario.project.id}/videos/${scenario.video.id}`, {
          method: 'DELETE',
          headers: bearer(token),
        }),
        { projectId: scenario.project.id, videoId: scenario.video.id }
      );

    const refused = await remove(everythingElse);
    expect(refused.status).toBe(403);
    expect(await db.video.findUnique({ where: { id: scenario.video.id } })).not.toBeNull();

    const allowed = await remove(deleter);
    expect(allowed.status).toBe(200);
    expect(await db.video.findUnique({ where: { id: scenario.video.id } })).toBeNull();
  });

  it('delete: still stops at what the owner may do', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    const token = tokenLiteral('F');
    await insertToken(commentator.id, token, [...ALL_SCOPES]);
    signedOut();

    const response = await callRoute(
      deleteVideo,
      apiRequest(`/api/projects/${scenario.project.id}/videos/${scenario.video.id}`, {
        method: 'DELETE',
        headers: bearer(token),
      }),
      { projectId: scenario.project.id, videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.video.findUnique({ where: { id: scenario.video.id } })).not.toBeNull();
  });

  it('comments: reading, writing and resolving each need their own permission', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const existing = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      content: 'Tighten the intro',
    });
    const reader = tokenLiteral('C');
    const writer = tokenLiteral('B');
    await insertToken(scenario.owner.id, reader, ['comments:read']);
    await insertToken(scenario.owner.id, writer, ['comments:write']);
    signedOut();

    const read = (token: string) =>
      callRoute(
        listComments,
        apiRequest(`/api/versions/${scenario.version.id}/comments`, { headers: bearer(token) }),
        { versionId: scenario.version.id }
      );
    const readAllowed = await read(reader);
    expect(readAllowed.status).toBe(200);
    expect(JSON.stringify(await readData(readAllowed))).toContain('Tighten the intro');
    expect((await read(writer)).status).toBe(403);

    const post = (token: string) =>
      callRoute(
        addComment,
        apiRequest(`/api/versions/${scenario.version.id}/comments`, {
          headers: bearer(token),
          body: { content: 'Scripted note', timestamp: 3 },
        }),
        { versionId: scenario.version.id }
      );
    expect((await post(reader)).status).toBe(403);
    expect((await post(writer)).status).toBe(201);
    expect(await db.comment.count({ where: { content: 'Scripted note' } })).toBe(1);

    const resolve = (token: string) =>
      callRoute(
        updateComment,
        apiRequest(`/api/comments/${existing.id}`, {
          method: 'PATCH',
          headers: bearer(token),
          body: { isResolved: true },
        }),
        { commentId: existing.id }
      );
    expect((await resolve(reader)).status).toBe(403);
    expect((await db.comment.findUniqueOrThrow({ where: { id: existing.id } })).isResolved).toBe(
      false
    );
    expect((await resolve(writer)).status).toBe(200);
    expect((await db.comment.findUniqueOrThrow({ where: { id: existing.id } })).isResolved).toBe(
      true
    );
  });

  it('share, approvals and download each refuse a token without them', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const sharer = tokenLiteral('S');
    const approver = tokenLiteral('P');
    const reader = tokenLiteral('Q');
    await insertToken(scenario.owner.id, sharer, ['share']);
    await insertToken(scenario.owner.id, approver, ['approvals']);
    await insertToken(scenario.owner.id, reader, ['read']);
    signedOut();

    const members = (token: string) =>
      callRoute(
        listProjectMembers,
        apiRequest(`/api/projects/${scenario.project.id}/members`, { headers: bearer(token) }),
        { projectId: scenario.project.id }
      );
    const candidates = (token: string) =>
      callRoute(
        listApprovalCandidates,
        apiRequest(`/api/projects/${scenario.project.id}/approval-candidates`, {
          headers: bearer(token),
        }),
        { projectId: scenario.project.id }
      );
    const download = (token: string) =>
      callRoute(
        downloadVersion,
        apiRequest(`/api/versions/${scenario.version.id}/download`, { headers: bearer(token) }),
        { versionId: scenario.version.id }
      );

    expect((await members(sharer)).status).toBe(200);
    expect((await members(reader)).status).toBe(403);
    expect((await candidates(approver)).status).toBe(200);
    expect((await candidates(reader)).status).toBe(403);
    const refusedDownload = await download(reader);
    expect(refusedDownload.status).toBe(403);
    expect(await readError(refusedDownload)).toContain('"download"');
  });

  it('folders: one POST, but inviting needs share and deleting needs delete', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE' });
    const folder = await db.projectFolder.create({
      data: { projectId: scenario.project.id, name: 'Deliverables' },
    });
    const manager = tokenLiteral('G');
    const sharer = tokenLiteral('H');
    await insertToken(scenario.owner.id, manager, ['manage']);
    await insertToken(scenario.owner.id, sharer, ['share']);
    signedOut();

    const act = (token: string, body: Record<string, unknown>) =>
      callRoute(
        folderAction,
        apiRequest(`/api/projects/${scenario.project.id}/folders`, {
          headers: bearer(token),
          body: { folderId: folder.id, ...body },
        }),
        { projectId: scenario.project.id }
      );
    const invite = { action: 'invite', email: 'client@example.com', role: 'COMMENTATOR' };

    const inviteRefused = await act(manager, invite);
    expect(inviteRefused.status).toBe(403);
    expect(await readError(inviteRefused)).toContain('"share"');
    expect(await db.invitation.count({ where: { folderId: folder.id } })).toBe(0);

    const deleteRefused = await act(manager, { action: 'delete' });
    expect(deleteRefused.status).toBe(403);
    expect(await db.projectFolder.findUnique({ where: { id: folder.id } })).not.toBeNull();

    const renamed = await act(manager, { action: 'rename', name: 'Final deliverables' });
    expect(renamed.status).toBe(200);
    expect((await db.projectFolder.findUniqueOrThrow({ where: { id: folder.id } })).name).toBe(
      'Final deliverables'
    );

    const invited = await act(sharer, invite);
    expect(invited.status).toBe(200);
    expect(await db.invitation.count({ where: { folderId: folder.id } })).toBe(1);
  });

  it('folders: every action asks for its own permissions', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE' });
    const folder = await db.projectFolder.create({
      data: { projectId: scenario.project.id, name: 'Untouched' },
    });
    signedOut();

    // Written out by hand: for each action, a token holding everything except
    // the named permission must be refused with a message naming it.
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['create', 'manage', { name: 'New' }],
      ['rename', 'manage', { name: 'Renamed' }],
      ['move', 'manage', { parentId: null }],
      ['move', 'share', { parentId: null }],
      ['moveVideos', 'manage', { videoIds: ['x'] }],
      ['moveVideos', 'share', { videoIds: ['x'] }],
      ['members', 'share', {}],
      ['invite', 'share', { email: 'someone@example.com', role: 'COMMENTATOR' }],
      ['revokeMember', 'share', { memberId: 'x' }],
      ['revokeInvitation', 'share', { invitationId: 'x' }],
      ['access', 'share', { accessMode: 'RESTRICTED' }],
      ['delete', 'delete', {}],
      ['somethingUnknown', 'manage', {}],
    ];

    for (const [index, [action, missing, extra]] of cases.entries()) {
      const token = tokenLiteral(String.fromCharCode(97 + index));
      await insertToken(
        scenario.owner.id,
        token,
        ALL_SCOPES.filter((scope) => scope !== missing)
      );
      const response = await callRoute(
        folderAction,
        apiRequest(`/api/projects/${scenario.project.id}/folders`, {
          headers: bearer(token),
          body: { action, folderId: folder.id, ...extra },
        }),
        { projectId: scenario.project.id }
      );
      expect(response.status, `${action} without ${missing}`).toBe(403);
      expect(await readError(response)).toBe(
        `This API token does not have the "${missing}" permission`
      );
    }

    const after = await db.projectFolder.findUniqueOrThrow({ where: { id: folder.id } });
    expect([after.name, after.accessMode, after.parentId]).toEqual(['Untouched', 'INHERIT', null]);
    expect(await db.projectFolder.count()).toBe(1);
    expect(await db.invitation.count()).toBe(0);
  });

  it('manage cannot change who sees a project, share can', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE' });
    const manager = tokenLiteral('m');
    const sharer = tokenLiteral('n');
    await insertToken(scenario.owner.id, manager, ['manage']);
    await insertToken(scenario.owner.id, sharer, ['manage', 'share']);
    signedOut();

    const patch = (token: string, body: Record<string, unknown>) =>
      callRoute(
        updateProject,
        apiRequest(`/api/projects/${scenario.project.id}`, {
          method: 'PATCH',
          headers: bearer(token),
          body,
        }),
        { projectId: scenario.project.id }
      );

    expect((await patch(manager, { visibility: 'PUBLIC' })).status).toBe(403);
    expect((await patch(manager, { allowDownloads: true })).status).toBe(403);
    const unchanged = await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } });
    expect([unchanged.visibility, unchanged.allowDownloads]).toEqual(['PRIVATE', false]);

    expect((await patch(manager, { name: 'Renamed by a script' })).status).toBe(200);
    expect((await patch(sharer, { visibility: 'PUBLIC' })).status).toBe(200);
    const after = await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } });
    expect([after.name, after.visibility]).toEqual(['Renamed by a script', 'PUBLIC']);

    const createdPublic = await callRoute(
      createProject,
      apiRequest('/api/projects', {
        headers: bearer(manager),
        body: {
          name: 'Public from a token',
          workspaceId: scenario.workspace.id,
          visibility: 'PUBLIC',
        },
      })
    );
    expect(createdPublic.status).toBe(403);
    expect(await db.project.count()).toBe(1);
  });

  it('moving videos between projects needs share as well as manage', async () => {
    const scenario = await seedVersion();
    const token = tokenLiteral('o');
    await insertToken(scenario.owner.id, token, ['manage']);
    signedOut();

    const response = await callRoute(
      moveVideos,
      apiRequest(`/api/projects/${scenario.project.id}/videos/move`, {
        headers: bearer(token),
        body: { videoIds: [scenario.video.id], targetProjectId: scenario.project.id },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await readError(response)).toContain('"share"');
  });

  it('read: a video comes back without its comments unless the token has comments:read', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      content: 'Private review note',
    });
    const reader = tokenLiteral('r');
    const commentReader = tokenLiteral('s');
    await insertToken(scenario.owner.id, reader, ['read']);
    await insertToken(scenario.owner.id, commentReader, ['read', 'comments:read']);
    signedOut();

    const fetchVideo = async (token: string) => {
      const response = await callRoute(
        getVideo,
        apiRequest(`/api/projects/${scenario.project.id}/videos/${scenario.video.id}`, {
          headers: bearer(token),
        }),
        { projectId: scenario.project.id, videoId: scenario.video.id }
      );
      expect(response.status).toBe(200);
      return JSON.stringify(await readData(response));
    };

    expect(await fetchVideo(reader)).not.toContain('Private review note');
    expect(await fetchVideo(commentReader)).toContain('Private review note');
  });

  it('read: the watch payload drops comments too without comments:read', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      content: 'Watch page note',
    });
    const reader = tokenLiteral('t');
    const commentReader = tokenLiteral('u');
    await insertToken(scenario.owner.id, reader, ['read']);
    await insertToken(scenario.owner.id, commentReader, ['read', 'comments:read']);
    signedOut();

    const watch = async (token: string) => {
      const response = await callRoute(
        watchVideo,
        apiRequest(`/api/watch/${scenario.video.id}`, {
          headers: bearer(token),
          searchParams: { includeComments: 'true' },
        }),
        { videoId: scenario.video.id }
      );
      expect(response.status).toBe(200);
      return JSON.stringify(await readData(response));
    };

    expect(await watch(reader)).not.toContain('Watch page note');
    expect(await watch(commentReader)).toContain('Watch page note');
  });
});

describe('withApiToken itself', () => {
  const echo = withApiToken(['upload', 'comments:write'], async (request: Request) => {
    expect(request.url).toContain('/api/echo');
    const session = await getSession();
    return Response.json({ userId: session?.user?.id ?? null, isAdmin: session?.user?.isAdmin });
  });

  it('accepts any one of several permissions and runs as the token owner', async () => {
    const owner = await createUser();
    const token = tokenLiteral('w');
    await insertToken(owner.id, token, ['comments:write']);
    signedOut();

    const response = await echo(apiRequest('/api/echo', { headers: bearer(token) }));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ userId: owner.id, isAdmin: false });
  });

  it('runs as the token owner even when someone else is signed in on the same machine', async () => {
    const owner = await createUser();
    const bystander = await createUser();
    const token = tokenLiteral('x');
    await insertToken(owner.id, token, ['upload']);
    signedInAs({ ...bystander, isAdmin: true });

    const response = await echo(apiRequest('/api/echo', { headers: bearer(token) }));

    expect(await response?.json()).toEqual({ userId: owner.id, isAdmin: false });
  });

  it('refuses a token that has none of them', async () => {
    const owner = await createUser();
    const token = tokenLiteral('y');
    await insertToken(owner.id, token, ['read', 'delete']);
    signedOut();

    const response = await echo(apiRequest('/api/echo', { headers: bearer(token) }));

    expect(response?.status).toBe(403);
    expect(await readError(response!)).toBe(
      'This API token does not have the "upload" or "comments:write" permission'
    );
  });

  it('refuses a token that shares a display prefix with a real one but not its secret', async () => {
    const owner = await createUser();
    const real = tokenLiteral('q');
    await insertToken(owner.id, real, ['upload']);
    signedOut();
    const impostor = `of_pat_${'q'.repeat(42)}r`;

    const response = await echo(apiRequest('/api/echo', { headers: bearer(impostor) }));

    expect(response?.status).toBe(401);
  });

  it('answers a JSON 500 when the token lookup itself fails', async () => {
    const spy = vi.spyOn(db.apiToken, 'findUnique').mockRejectedValueOnce(new Error('pool gone'));
    try {
      const response = await echo(apiRequest('/api/echo', { headers: bearer(tokenLiteral('z')) }));
      expect(response?.status).toBe(500);
      expect(await readError(response!)).toBe('Failed to check the API token');
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves a request without a token to the browser session', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await echo(apiRequest('/api/echo'));

    expect(await response?.json()).toEqual({ userId: user.id, isAdmin: false });
  });
});
