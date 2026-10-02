import { describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { GET } from '@/app/api/versions/[versionId]/comments/export/route';
import { createComment, createUser, seedVersion } from '../factories';
import { apiRequest, callRoute } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { parseMarkerEdl, parseMarkerXml } from '../helpers/nle-parser';

const settings = '&fps=30000%2F1001&origin=01%3A00%3A00%3B00&dropFrame=true';
function request(versionId: string, query: string) {
  return callRoute(GET, apiRequest(`/api/versions/${versionId}/comments/export?${query}`), {
    versionId,
  });
}

describe('NLE comment exports', () => {
  it.each(['edl', 'xml'])('protects %s behind authentication and video access', async (format) => {
    const scenario = await seedVersion();
    const comment = await createComment({
      versionId: scenario.version.id,
      content: 'Private marker',
    });
    signedOut();
    expect((await request(scenario.version.id, `format=${format}${settings}`)).status).toBe(401);
    signedInAs(await createUser());
    const denied = await request(scenario.version.id, `format=${format}${settings}`);
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain('Private marker');
    expect(await db.comment.findUnique({ where: { id: comment.id } })).not.toBeNull();
    signedInAs(scenario.owner);
    const allowed = await request(scenario.version.id, `format=${format}${settings}`);
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('Private marker');
  });

  it.each(['edl', 'xml'])(
    'downloads %s preserving same-frame comments, ranges and replies',
    async (format) => {
      const scenario = await seedVersion();
      const parent = await createComment({
        versionId: scenario.version.id,
        content: '中文 & <marker>\n|D:999',
        timestamp: 1001,
        timestampEnd: 1002,
      });
      const reply = await createComment({
        versionId: scenario.version.id,
        parentId: parent.id,
        content: 'Resolved reply',
        timestamp: 1001,
        isResolved: true,
      });
      const nested = await createComment({
        versionId: scenario.version.id,
        parentId: reply.id,
        content: 'Nested reply',
        timestamp: 1001,
      });
      await createComment({
        versionId: scenario.version.id,
        content: 'Hidden resolved root',
        timestamp: 9,
        isResolved: true,
      });
      signedInAs(scenario.owner);
      const response = await request(
        scenario.version.id,
        `format=${format}&includeResolved=false${settings}`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('content-disposition')).toMatch(
        new RegExp(`attachment; filename=".*\\.${format}"`)
      );
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      const text = await response.text();
      const markers = format === 'edl' ? parseMarkerEdl(text) : parseMarkerXml(text).markers;
      expect(markers).toHaveLength(1);
      expect(markers[0].entries).toEqual([
        expect.objectContaining({
          commentId: parent.id,
          content: parent.content,
          timestampEnd: 1002,
        }),
        expect.objectContaining({
          commentId: reply.id,
          parentCommentId: parent.id,
          isResolved: true,
        }),
        expect.objectContaining({
          commentId: nested.id,
          parentCommentId: reply.id,
          content: nested.content,
        }),
      ]);
      expect(text).not.toContain('Hidden resolved root');
    }
  );

  it('requires explicit valid timing and refuses images', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    for (const query of [
      'format=xml',
      'format=edl&fps=29.97&origin=00:00:00:00&dropFrame=false',
      'format=xml&fps=24&origin=00:00:00:00&dropFrame=bad',
    ]) {
      expect((await request(scenario.version.id, query)).status).toBe(400);
    }
    await db.video.update({ where: { id: scenario.video.id }, data: { mediaType: 'IMAGE' } });
    expect((await request(scenario.version.id, `format=xml${settings}`)).status).toBe(400);
    expect((await request(scenario.version.id, 'format=csv')).status).toBe(200);
    expect((await request(scenario.version.id, 'format=pdf')).status).toBe(200);
  });

  it('enforces the 5000 row cap including resolved replies of unresolved parents', async () => {
    const scenario = await seedVersion();
    const parent = await createComment({ versionId: scenario.version.id });
    await db.comment.createMany({
      data: Array.from({ length: 5000 }, (_, i) => ({
        versionId: scenario.version.id,
        parentId: parent.id,
        content: `Reply ${i}`,
        timestamp: 0,
        isResolved: true,
      })),
    });
    signedInAs(scenario.owner);
    const response = await request(
      scenario.version.id,
      `format=xml&includeResolved=false${settings}`
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('5000');
    expect(await db.comment.count({ where: { versionId: scenario.version.id } })).toBe(5001);
  });
});

it('bounds the database read if comments grow after the preflight count', async () => {
  const scenario = await seedVersion();
  await db.comment.createMany({
    data: Array.from({ length: 5001 }, (_, i) => ({
      versionId: scenario.version.id,
      content: `Comment ${i}`,
      timestamp: 0,
    })),
  });
  signedInAs(scenario.owner);
  // Simulate a count taken before a concurrent insertion. The real findMany
  // still hits Postgres; the query bound is the resource guarantee under test.
  const count = vi.spyOn(db.comment, 'count').mockResolvedValueOnce(0);
  const read = vi.spyOn(db.comment, 'findMany');
  try {
    const response = await request(scenario.version.id, `format=xml${settings}`);
    expect(response.status).toBe(400);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ take: 5001 }));
    expect(await response.text()).toContain('5000');
  } finally {
    count.mockRestore();
    read.mockRestore();
  }
});
