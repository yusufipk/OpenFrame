import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { POST, GET } from '@/app/api/versions/[versionId]/comments/route';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import { createShareLink, createUser, createVersion, seedVersion } from '../factories';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';

async function imageScenario() {
  const scenario = await seedVersion({ visibility: 'PRIVATE' });
  await db.video.update({ where: { id: scenario.video.id }, data: { mediaType: 'IMAGE' } });
  await db.videoVersion.update({
    where: { id: scenario.version.id },
    data: { providerId: 'r2-image', duration: null },
  });
  return scenario;
}

function commentRequest(versionId: string, body: Record<string, unknown>) {
  return apiRequest(`/api/versions/${versionId}/comments`, { body });
}

describe('still image comments', () => {
  it.each(['anonymous', 'outsider'])('refuses an %s without writing a comment', async (caller) => {
    const { version } = await imageScenario();
    if (caller === 'anonymous') signedOut();
    else signedInAs(await createUser());
    const response = await callRoute(POST, commentRequest(version.id, { content: 'Refused' }), {
      versionId: version.id,
    });
    expect(response.status).toBe(403);
    expect(await db.comment.count()).toBe(0);
  });

  it('stores an annotation without requiring playback time and keeps it on its version', async () => {
    const { owner, video, version } = await imageScenario();
    signedInAs(owner);
    const strokes = [
      {
        points: [
          { x: 0.2, y: 0.3 },
          { x: 0.4, y: 0.5 },
        ],
        color: '#FF3B30',
        width: 3,
      },
    ];
    const response = await callRoute(
      POST,
      commentRequest(version.id, {
        content: 'Reduce the reflection',
        annotationData: strokes,
      }),
      { versionId: version.id }
    );
    expect(response.status).toBe(201);
    const stored = await db.comment.findFirstOrThrow();
    expect(stored).toMatchObject({
      versionId: version.id,
      timestamp: 0,
      timestampEnd: null,
      content: 'Reduce the reflection',
    });
    expect(JSON.parse(stored.annotationData!)).toEqual(strokes);

    const second = await createVersion({
      videoParentId: video.id,
      versionNumber: 2,
      providerId: 'r2-image',
    });
    const listed = await readData<{ comments: unknown[] }>(
      await callRoute(GET, apiRequest(`/api/versions/${second.id}/comments`), {
        versionId: second.id,
      })
    );
    expect(listed.comments).toEqual([]);
    expect(await db.comment.findUnique({ where: { id: stored.id } })).toMatchObject({
      versionId: version.id,
    });
  });

  it.each([{ timestamp: 4 }, { timestamp: -1 }, { timestamp: 'invalid' }, { timestampEnd: 0 }])(
    'refuses playback coordinates %j on a still image',
    async (position) => {
      const { owner, version } = await imageScenario();
      signedInAs(owner);
      const response = await callRoute(
        POST,
        commentRequest(version.id, {
          content: 'Invalid coordinates',
          ...position,
        }),
        { versionId: version.id }
      );
      expect(response.status).toBe(400);
      expect(await db.comment.count()).toBe(0);
    }
  );

  it('allows a guest with a comment share session to comment without a timestamp', async () => {
    const { project, video, version } = await imageScenario();
    const link = await createShareLink({
      projectId: project.id,
      videoId: video.id,
      permission: 'COMMENT',
      allowGuests: true,
    });
    signedOut();
    const response = await callRoute(
      POST,
      apiRequest(`/api/versions/${version.id}/comments`, {
        body: { content: 'Approved composition', guestName: 'Reviewer' },
        cookies: {
          [getShareSessionCookieName(video.id)]: createShareSessionValue(
            link.token,
            video.id,
            false
          ),
        },
      }),
      { versionId: version.id }
    );
    expect(response.status).toBe(201);
    expect(await db.comment.findFirstOrThrow()).toMatchObject({
      versionId: version.id,
      guestName: 'Reviewer',
      authorId: null,
      timestamp: 0,
    });
  });
});
