import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { notifyProjectOwner } from '@/lib/notifications';
import { POST } from '@/app/api/versions/[versionId]/comments/import/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createComment,
  createUser,
  createVersion,
  seedVersion,
} from '../factories';

interface ImportResult {
  created: number;
  duplicates: number;
  skipped: { empty: number; tooLong: number; outOfRange: number };
  accepted: number[];
  pluginVersions: { premiere: string; resolve: string };
}

function send(versionId: string, body: unknown, headers?: Record<string, string>) {
  return callRoute(
    POST,
    apiRequest(`/api/versions/${versionId}/comments/import`, { body, headers }),
    { versionId }
  );
}

function rows(versionId: string) {
  return db.comment.findMany({
    where: { versionId },
    orderBy: { timestamp: 'asc' },
    select: { content: true, timestamp: true, timestampEnd: true, authorId: true, parentId: true },
  });
}

const timeline = {
  fps: '25',
  markers: [
    { startFrame: 250, durationFrames: 0, name: 'Color', comments: 'Too warm' },
    { startFrame: 500, durationFrames: 50, name: '', comments: 'Trim this' },
  ],
};

async function insertToken(userId: string, scopes: string[]) {
  const token = `of_pat_${'t'.repeat(43)}`;
  await db.apiToken.create({
    data: {
      userId,
      name: 'Premiere',
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      prefix: token.slice(0, 13),
      scopes,
    },
  });
  return { authorization: `Bearer ${token}` };
}

describe('POST /api/versions/[versionId]/comments/import', () => {
  it('refuses a caller with no session and writes nothing', async () => {
    const scenario = await seedVersion();
    signedOut();
    const response = await send(scenario.version.id, timeline);
    expect(response.status).toBe(401);
    expect(await rows(scenario.version.id)).toEqual([]);
  });

  it('refuses a signed-in stranger and writes nothing', async () => {
    const scenario = await seedVersion();
    signedInAs(await createUser());
    const response = await send(scenario.version.id, timeline);
    expect(response.status).toBe(404);
    expect(await rows(scenario.version.id)).toEqual([]);
  });

  it('adds each marker as a comment by the caller', async () => {
    const scenario = await seedVersion({ duration: 120 });
    signedInAs(scenario.owner);
    const response = await send(scenario.version.id, timeline);
    expect(response.status).toBe(201);
    expect(await readData<ImportResult>(response)).toMatchObject({
      created: 2,
      duplicates: 0,
      skipped: { empty: 0, tooLong: 0, outOfRange: 0 },
      accepted: [0, 1],
    });
    expect(await rows(scenario.version.id)).toEqual([
      {
        content: 'Color\nToo warm',
        timestamp: 10,
        timestampEnd: null,
        authorId: scenario.owner.id,
        parentId: null,
      },
      {
        content: 'Trim this',
        timestamp: 20,
        timestampEnd: 22,
        authorId: scenario.owner.id,
        parentId: null,
      },
    ]);
  });

  it('adds nothing the second time the same timeline is sent', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    expect((await send(scenario.version.id, timeline)).status).toBe(201);
    const again = await send(scenario.version.id, {
      fps: '25',
      markers: [...timeline.markers, { startFrame: 750, name: 'New', comments: '' }],
    });
    expect(again.status).toBe(201);
    expect(await readData<ImportResult>(again)).toMatchObject({
      created: 1,
      duplicates: 2,
      accepted: [0, 1, 2],
    });
    expect(await db.comment.count({ where: { versionId: scenario.version.id } })).toBe(3);
  });

  it('does not count somebody else’s identical comment as a duplicate', async () => {
    const scenario = await seedVersion();
    const editor = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: editor.id });
    signedInAs(scenario.owner);
    await send(scenario.version.id, timeline);
    signedInAs(editor);
    const response = await send(scenario.version.id, timeline);
    expect(await readData<ImportResult>(response)).toMatchObject({ created: 2, duplicates: 0 });
    expect(await db.comment.count({ where: { versionId: scenario.version.id } })).toBe(4);
  });

  it('sends the same timeline to the next version as new comments there', async () => {
    const scenario = await seedVersion();
    const next = await createVersion({ videoParentId: scenario.video.id, versionNumber: 2 });
    signedInAs(scenario.owner);
    await send(scenario.version.id, timeline);
    const response = await send(next.id, timeline);
    expect(await readData<ImportResult>(response)).toMatchObject({ created: 2, duplicates: 0 });
    expect(await db.comment.count({ where: { versionId: next.id } })).toBe(2);
  });

  it('does not count a reply with the same text and time as a duplicate', async () => {
    const scenario = await seedVersion();
    const root = await createComment({ versionId: scenario.version.id, content: 'Other' });
    await createComment({
      versionId: scenario.version.id,
      parentId: root.id,
      authorId: scenario.owner.id,
      content: 'Trim this',
      timestamp: 20,
    });
    signedInAs(scenario.owner);
    const response = await send(scenario.version.id, timeline);
    expect(await readData<ImportResult>(response)).toMatchObject({ created: 2, duplicates: 0 });
  });

  // Parallel requests rarely interleave in a test run (see the token lock test in
  // api-tokens.test.ts), so the lock is held from an independent connection: the
  // request must be seen waiting on it, and must read the existing comments only
  // after it is released, by which time a matching one is there.
  it('reads the existing comments under a lock, so one added meanwhile is a duplicate', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const connection = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 715))', [
        `comment-import:${scenario.version.id}:${scenario.owner.id}`,
      ]);
      pending = send(scenario.version.id, timeline);
      void pending.catch(() => {});
      await vi.waitFor(
        async () => {
          const waiting = await db.$queryRaw<{ waiting: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
            ) AS waiting
          `;
          expect(waiting).toEqual([{ waiting: true }]);
        },
        { timeout: 2_000, interval: 20 }
      );
      await createComment({
        versionId: scenario.version.id,
        authorId: scenario.owner.id,
        content: 'Trim this',
        timestamp: 20,
      });
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await pool.end();
    }
    const response = await pending!;
    expect(await readData<ImportResult>(response)).toMatchObject({
      created: 1,
      duplicates: 1,
      accepted: [0, 1],
    });
    expect(await db.comment.count({ where: { versionId: scenario.version.id } })).toBe(2);
  });

  it('leaves out empty markers and markers past the end of the version', async () => {
    const scenario = await seedVersion({ duration: 15 });
    signedInAs(scenario.owner);
    const response = await send(scenario.version.id, {
      fps: '25',
      markers: [
        { startFrame: 250, comments: 'In range' },
        { startFrame: 300, name: ' ', comments: '' },
        { startFrame: 400, comments: 'Past the end' },
      ],
    });
    expect(await readData<ImportResult>(response)).toMatchObject({
      created: 1,
      skipped: { empty: 1, tooLong: 0, outOfRange: 1 },
      accepted: [0],
    });
    expect((await rows(scenario.version.id)).map((row) => row.content)).toEqual(['In range']);
  });

  it('refuses a malformed request without writing any of it', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    const response = await send(scenario.version.id, {
      fps: '25',
      markers: [
        { startFrame: 10, comments: 'Fine' },
        { startFrame: -1, comments: 'Bad' },
      ],
    });
    expect(response.status).toBe(400);
    expect(await rows(scenario.version.id)).toEqual([]);
  });

  it('refuses markers on an image, and a stranger before saying so', async () => {
    const scenario = await seedVersion();
    await db.video.update({ where: { id: scenario.video.id }, data: { mediaType: 'IMAGE' } });
    signedInAs(await createUser());
    expect((await send(scenario.version.id, timeline)).status).toBe(404);
    signedInAs(scenario.owner);
    expect((await send(scenario.version.id, timeline)).status).toBe(400);
    expect(await rows(scenario.version.id)).toEqual([]);
  });

  it('needs the Send timeline markers or Write comments permission on an API token', async () => {
    const scenario = await seedVersion();
    signedOut();
    const readOnly = await insertToken(scenario.owner.id, ['read', 'comments:read']);
    const refused = await send(scenario.version.id, timeline, readOnly);
    expect(refused.status).toBe(403);
    expect(await rows(scenario.version.id)).toEqual([]);

    await db.apiToken.updateMany({
      where: { userId: scenario.owner.id },
      data: { scopes: ['read', 'comments:read', 'comments:import'] },
    });
    const allowed = await send(scenario.version.id, timeline, readOnly);
    expect(allowed.status).toBe(201);
    expect(
      (await rows(scenario.version.id)).every((row) => row.authorId === scenario.owner.id)
    ).toBe(true);
    expect(await db.comment.count({ where: { versionId: scenario.version.id } })).toBe(2);
  });

  it('notifies the owner once for a collaborator’s whole timeline, and not for their own', async () => {
    const scenario = await seedVersion();
    const editor = await createUser({ name: 'Editor' });
    await addProjectMember({ projectId: scenario.project.id, userId: editor.id });

    signedInAs(scenario.owner);
    vi.mocked(notifyProjectOwner).mockClear();
    await send(scenario.version.id, timeline);
    expect(notifyProjectOwner).not.toHaveBeenCalled();

    signedInAs(editor);
    await send(scenario.version.id, timeline);
    expect(notifyProjectOwner).toHaveBeenCalledTimes(1);
    const [ownerId, event] = vi.mocked(notifyProjectOwner).mock.calls[0];
    expect(ownerId).toBe(scenario.owner.id);
    expect(event).toMatchObject({
      type: 'new_comment',
      commentAuthor: 'Editor',
      commentText: '2 comments from their editing timeline, starting with: Color\nToo warm',
      timestamp: '0:10',
    });

    // Sending the unchanged timeline again adds nothing and tells nobody.
    const again = await send(scenario.version.id, timeline);
    expect(again.status).toBe(200);
    expect(notifyProjectOwner).toHaveBeenCalledTimes(1);
  });

  it('quotes a single marker as it is in the notification', async () => {
    const scenario = await seedVersion();
    const editor = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: editor.id });
    signedInAs(editor);
    vi.mocked(notifyProjectOwner).mockClear();
    await send(scenario.version.id, { fps: '25', markers: [timeline.markers[1]] });
    expect(vi.mocked(notifyProjectOwner).mock.calls[0][1]).toMatchObject({
      commentText: 'Trim this',
      timestamp: '0:20',
    });
  });
});
