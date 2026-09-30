// Which route handlers a personal access token can reach, and with which
// permission. The table below is the reviewable record of that decision: every
// exported handler under app/api is found on disk and compared against it, so
// opening a route to tokens, changing the permission it asks for, or adding a
// route without deciding is a failing test and a visible diff.
//
// Anything not in the table must stay closed to tokens. That covers billing,
// settings, token management, admin, auth, onboarding and the internal and
// live review routes on purpose.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_TOKEN_SCOPES_KEY } from '@/lib/api-tokens';
import { REPO_ROOT } from '../helpers/env';

const UPLOAD_OR_COMMENT = ['upload', 'comments:write'];

const TOKEN_SCOPES: Record<string, Record<string, string[]>> = {
  'approvals/[requestId]/cancel': { POST: ['approvals'] },
  'approvals/[requestId]/decision': { POST: ['approvals'] },
  'comments/[commentId]': {
    GET: ['comments:read'],
    PATCH: ['comments:write'],
    DELETE: ['comments:write'],
  },
  projects: { GET: ['read'], POST: ['manage'] },
  'projects/[projectId]': { GET: ['read'], PATCH: ['manage'], DELETE: ['delete'] },
  'projects/[projectId]/approval-candidates': { GET: ['approvals'] },
  'projects/[projectId]/branding': { POST: ['manage'], DELETE: ['manage'] },
  'projects/[projectId]/branding/[filename]': { GET: ['read'] },
  'projects/[projectId]/download': { GET: ['download'] },
  // POST narrows further by action; see the folders test in api-tokens.test.ts.
  'projects/[projectId]/folders': { GET: ['read'], POST: ['manage', 'share', 'delete'] },
  'projects/[projectId]/members': { GET: ['share'], POST: ['share'] },
  'projects/[projectId]/members/[memberId]': { PATCH: ['share'], DELETE: ['share'] },
  'projects/[projectId]/members/invitations/[invitationId]': { DELETE: ['share'] },
  'projects/[projectId]/tags': { GET: ['comments:read'], POST: ['comments:write'] },
  'projects/[projectId]/tags/[tagId]': { PATCH: ['comments:write'], DELETE: ['comments:write'] },
  'projects/[projectId]/videos': { GET: ['read'], POST: ['upload'] },
  'projects/[projectId]/videos/bulk-delete': { POST: ['delete'] },
  'projects/[projectId]/videos/bunny-init': { POST: ['upload'], DELETE: ['upload'] },
  'projects/[projectId]/videos/images': { POST: ['upload'] },
  'projects/[projectId]/videos/move': { GET: ['read'], POST: ['manage'] },
  'projects/[projectId]/videos/r2-complete': { POST: ['upload'] },
  'projects/[projectId]/videos/r2-init': { POST: ['upload'], DELETE: ['upload'] },
  'projects/[projectId]/videos/[videoId]': { GET: ['read'], PATCH: ['manage'], DELETE: ['delete'] },
  'projects/[projectId]/videos/[videoId]/share': {
    GET: ['share'],
    POST: ['share'],
    PATCH: ['share'],
    DELETE: ['share'],
  },
  'projects/[projectId]/videos/[videoId]/versions': { GET: ['read'], POST: ['upload'] },
  'projects/[projectId]/videos/[videoId]/versions/[versionId]': {
    PATCH: ['manage'],
    DELETE: ['delete'],
  },
  search: { GET: ['read'] },
  'upload/audio': { POST: UPLOAD_OR_COMMENT },
  'upload/audio/[filename]': { GET: ['read'] },
  'upload/image': { POST: UPLOAD_OR_COMMENT },
  'upload/image/[filename]': { GET: ['read'] },
  'upload/subtitle/[filename]': { GET: ['read'] },
  'upload/video/[filename]': { GET: ['read'] },
  'versions/[versionId]/approvals': { GET: ['approvals'], POST: ['approvals'] },
  'versions/[versionId]/comments': { GET: ['comments:read'], POST: ['comments:write'] },
  'versions/[versionId]/comments/export': { GET: ['comments:read'] },
  'versions/[versionId]/download': { GET: ['download'] },
  'videos/[videoId]/assets': { GET: ['read'], POST: ['upload'] },
  'videos/[videoId]/assets/[assetId]': { DELETE: ['delete'] },
  'videos/[videoId]/assets/[assetId]/download': { GET: ['download'] },
  'videos/[videoId]/assets/bunny-init': { POST: ['upload'], DELETE: ['upload'] },
  'videos/[videoId]/assets/r2-init': { POST: ['upload'], DELETE: ['upload'] },
  'videos/[videoId]/attachment-comments': { GET: ['comments:read'], POST: ['comments:write'] },
  'videos/[videoId]/attachment-comments/[attachmentCommentId]': { DELETE: ['comments:write'] },
  'videos/[videoId]/subtitles': { GET: ['read'], POST: ['upload'] },
  'videos/[videoId]/subtitles/[subtitleId]': { DELETE: ['delete'] },
  'watch/[videoId]': { GET: ['read'] },
  workspaces: { GET: ['read'], POST: ['manage'] },
  'workspaces/[workspaceId]': { GET: ['read'], PATCH: ['manage'], DELETE: ['delete'] },
  'workspaces/[workspaceId]/members': { GET: ['share'], POST: ['share'] },
  'workspaces/[workspaceId]/members/[memberId]': { PATCH: ['share'], DELETE: ['share'] },
  'workspaces/[workspaceId]/members/invitations/[invitationId]': { DELETE: ['share'] },
};

// Never reachable with a token, whatever it carries. Listed separately from
// "not in the table" so that the reason is on record for the ones that matter.
const NEVER_FOR_TOKENS = [
  'billing',
  'billing/cancel',
  'billing/checkout',
  'billing/portal',
  'billing/trial',
  'settings/api-tokens',
  'settings/api-tokens/[tokenId]',
  'settings/notifications',
  'settings/preferences',
  'settings/storage',
  'admin/feedback/[feedbackId]',
  'admin/growth',
  'admin/stats/refresh-r2',
];

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const API_DIR = path.join(REPO_ROOT, 'app', 'api');

function discoverRoutes(dir = API_DIR): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return discoverRoutes(full);
    return entry.name === 'route.ts' ? [path.relative(API_DIR, dir)] : [];
  });
}

async function scopesOf(route: string): Promise<Record<string, string[] | null>> {
  const mod = (await import(path.join(API_DIR, route, 'route.ts'))) as Record<string, unknown>;
  const result: Record<string, string[] | null> = {};
  for (const method of METHODS) {
    const handler = mod[method] as ({ [API_TOKEN_SCOPES_KEY]?: string[] } & object) | undefined;
    if (typeof handler !== 'function') continue;
    const scopes = handler[API_TOKEN_SCOPES_KEY];
    result[method] = scopes ? [...scopes] : null;
  }
  return result;
}

describe('API token route classification', () => {
  const routes = discoverRoutes().sort();

  it('lists only routes that still exist', () => {
    for (const route of [...Object.keys(TOKEN_SCOPES), ...NEVER_FOR_TOKENS]) {
      expect(routes, `${route} is classified but not on disk`).toContain(route);
    }
  });

  it.each(routes)('%s asks tokens for exactly the permissions in the table', async (route) => {
    const actual = await scopesOf(route);
    const expected: Record<string, string[] | null> = {};
    for (const method of Object.keys(actual)) {
      expected[method] = TOKEN_SCOPES[route]?.[method] ?? null;
    }
    expect(actual).toEqual(expected);
    // And no table entry for a method the route no longer exports.
    for (const method of Object.keys(TOKEN_SCOPES[route] ?? {})) {
      expect(Object.keys(actual), `${route} ${method} is in the table`).toContain(method);
    }
    if (NEVER_FOR_TOKENS.includes(route)) {
      expect(Object.values(actual).every((scopes) => scopes === null)).toBe(true);
    }
  });

  // A handler that a token can reach but that reads the session with auth()
  // would never see the token owner: a token-only call turns anonymous, and a
  // call that also carries a cookie passes the token's scope check and then
  // runs as whoever the cookie belongs to. getSession() is the only safe read.
  it.each(Object.keys(TOKEN_SCOPES))('%s reads the session through getSession()', (route) => {
    const source = fs.readFileSync(path.join(API_DIR, route, 'route.ts'), 'utf8');
    expect(source).not.toMatch(/(?<![\w.])auth\(/);
  });

  // The same, for every helper those handlers might call. Only lib/auth.ts
  // (where auth() lives) and lib/api-tokens.ts (where getSession() wraps it)
  // may call it.
  it('no helper under lib/ reads the session with auth()', () => {
    const libDir = path.join(REPO_ROOT, 'lib');
    const offenders = fs
      .readdirSync(libDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => path.relative(libDir, path.join(entry.parentPath, entry.name)))
      .filter((file) => file !== 'auth.ts' && file !== 'api-tokens.ts')
      .filter((file) =>
        /(?<![\w.])auth\(\)/.test(fs.readFileSync(path.join(libDir, file), 'utf8'))
      );
    expect(offenders).toEqual([]);
  });
});
