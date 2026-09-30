import { describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { notifyProjectOwner } from '@/lib/notifications';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import {
  GET as listComments,
  POST as createCommentRoute,
} from '@/app/api/versions/[versionId]/comments/route';
import {
  DELETE as deleteCommentRoute,
  GET as getCommentRoute,
  PATCH as patchCommentRoute,
} from '@/app/api/comments/[commentId]/route';
import { isFreshAttachment } from '@/lib/upload-freshness';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createComment,
  createCommentTag,
  createExpiredUser,
  createProject,
  createShareLink,
  createUser,
  createVersion,
  createVideo,
  createWorkspace,
  seedVersion,
} from '../factories';

// The real check heads the object in R2. Standing in for it lets these tests
// drive the attachment paths; a suite that wants a stale upload overrides it.
vi.mock('@/lib/upload-freshness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/upload-freshness')>();
  return {
    ...actual,
    isFreshAttachment: vi.fn(async () => ({ isFresh: true, sizeBytes: BigInt(1024) })),
  };
});

const IMAGE_A = '/api/upload/image/11111111-2222-3333-4444-555555555555.png';
const IMAGE_B = '/api/upload/image/66666666-7777-8888-9999-aaaaaaaaaaaa.png';
const IMAGE_C = '/api/upload/image/bbbbbbbb-cccc-dddd-eeee-ffffffffffff.png';
const IMAGE_D = '/api/upload/image/12121212-3434-5656-7878-909090909090.png';
const IMAGE_E = '/api/upload/image/abababab-cdcd-efef-0101-232323232323.png';
const IMAGE_F = '/api/upload/image/45454545-6767-8989-0a0a-1b1b1b1b1b1b.png';

async function imageUrlsOf(commentId: string): Promise<string[]> {
  const images = await db.commentImage.findMany({
    where: { commentId },
    orderBy: { position: 'asc' },
    select: { url: true },
  });
  return images.map((image) => image.url);
}

const VALID_STROKE = {
  points: [
    { x: 0.1, y: 0.2 },
    { x: 0.3, y: 0.4 },
  ],
  color: '#FF3B30',
  width: 4,
};

function commentsUrl(versionId: string): string {
  return `/api/versions/${versionId}/comments`;
}

describe('GET /api/versions/[versionId]/comments', () => {
  it('returns 404 for an unknown version', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(listComments, apiRequest(commentsUrl('nope')), {
      versionId: 'nope',
    });

    expect(response.status).toBe(404);
  });

  it('returns 403 to an anonymous caller on a PRIVATE project', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    await createComment({ versionId: scenario.version.id, authorId: scenario.owner.id });
    signedOut();

    const response = await callRoute(listComments, apiRequest(commentsUrl(scenario.version.id)), {
      versionId: scenario.version.id,
    });

    expect(response.status).toBe(403);
  });

  it('returns only top-level comments, with replies nested', async () => {
    const scenario = await seedVersion();
    const parent = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      timestamp: 5,
    });
    await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      parentId: parent.id,
      timestamp: 5,
    });
    await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      timestamp: 1,
    });
    signedInAs(scenario.owner);

    const payload = await readData<{
      comments: Array<{ id: string; timestamp: number; replies: Array<{ id: string }> }>;
      total: number;
      hasMore: boolean;
    }>(
      await callRoute(listComments, apiRequest(commentsUrl(scenario.version.id)), {
        versionId: scenario.version.id,
      })
    );

    expect(payload.comments).toHaveLength(2);
    expect(payload.comments.map((entry) => entry.timestamp)).toEqual([1, 5]);
    expect(payload.comments.find((entry) => entry.id === parent.id)?.replies).toHaveLength(1);
    expect(payload.total).toBe(2);
    expect(payload.hasMore).toBe(false);
  });

  it('omits resolved comments when includeResolved=false', async () => {
    const scenario = await seedVersion();
    const open = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
    });
    await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      isResolved: true,
      resolvedAt: new Date(),
    });
    signedInAs(scenario.owner);

    const payload = await readData<{ comments: Array<{ id: string }> }>(
      await callRoute(
        listComments,
        apiRequest(`${commentsUrl(scenario.version.id)}?includeResolved=false`),
        { versionId: scenario.version.id }
      )
    );

    expect(payload.comments.map((entry) => entry.id)).toEqual([open.id]);
  });

  it('answers 304 when the caller presents the current ETag', async () => {
    const scenario = await seedVersion();
    await createComment({ versionId: scenario.version.id, authorId: scenario.owner.id });
    signedInAs(scenario.owner);

    const first = await callRoute(listComments, apiRequest(commentsUrl(scenario.version.id)), {
      versionId: scenario.version.id,
    });
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await callRoute(
      listComments,
      apiRequest(commentsUrl(scenario.version.id), { headers: { 'if-none-match': etag! } }),
      { versionId: scenario.version.id }
    );

    expect(second.status).toBe(304);
  });

  it('lets a guest with a VIEW share session read the comments', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'VIEW',
    });
    await createComment({ versionId: scenario.version.id, authorId: scenario.owner.id });
    signedOut();

    const response = await callRoute(
      listComments,
      apiRequest(commentsUrl(scenario.version.id), {
        cookies: {
          [getShareSessionCookieName(scenario.video.id)]: createShareSessionValue(
            link.token,
            scenario.video.id,
            false
          ),
        },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(200);
  });

  it('refuses a share session signed for a different video', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const otherVideo = await createVideo({ projectId: scenario.project.id });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: otherVideo.id,
      permission: 'VIEW',
    });
    signedOut();

    const response = await callRoute(
      listComments,
      apiRequest(commentsUrl(scenario.version.id), {
        cookies: {
          [getShareSessionCookieName(scenario.video.id)]: createShareSessionValue(
            link.token,
            otherVideo.id,
            false
          ),
        },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(403);
  });
});

describe('POST /api/versions/[versionId]/comments', () => {
  it('returns 403 to an anonymous caller with no share session', async () => {
    const scenario = await seedVersion();
    signedOut();

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { content: 'hi', timestamp: 1, guestName: 'Anon' },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.comment.count()).toBe(0);
  });

  it('returns 403 to a signed-in stranger', async () => {
    const scenario = await seedVersion();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), { body: { content: 'hi', timestamp: 1 } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.comment.count()).toBe(0);
  });

  it('returns 403 once the workspace owner has lost billing access', async () => {
    const expiredOwner = await createExpiredUser();
    const workspace = await createWorkspace({ ownerId: expiredOwner.id });
    const project = await createProject({ ownerId: expiredOwner.id, workspaceId: workspace.id });
    const video = await createVideo({ projectId: project.id });
    const version = await createVersion({ videoParentId: video.id });
    signedInAs(expiredOwner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(version.id), { body: { content: 'hi', timestamp: 1 } }),
      { versionId: version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.comment.count()).toBe(0);
  });

  it('returns 400 when the timestamp is missing', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), { body: { content: 'hi' } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
  });

  it.each([
    [-1, 'a negative timestamp'],
    ['not-a-number', 'an unparseable timestamp'],
    [Number.POSITIVE_INFINITY, 'a non-finite timestamp'],
    [121, 'a timestamp past the version duration of 120'],
  ])('rejects the timestamp %s with 400 (%s)', async (timestamp, label) => {
    const scenario = await seedVersion({ duration: 120 });
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), { body: { content: 'hi', timestamp } }),
      { versionId: scenario.version.id }
    );

    expect(response.status, label).toBe(400);
    expect(await db.comment.count()).toBe(0);
  });

  // The "do not email somebody about their own comment" rule lives in the route
  // (`const isOwnProject = session?.user?.id === project.ownerId`), not in
  // lib/notifications.ts: notifyUsers() takes no actor argument and has no way
  // to know. So it cannot be covered by a unit test of the notification module,
  // and until these two it was covered nowhere: deleting the guard turned
  // nothing red. They are written as a pair on purpose, because the negative one
  // alone would also pass if notifications stopped firing altogether.
  it('does not notify the project owner about the owner’s own comment', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    vi.mocked(notifyProjectOwner).mockClear();

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), { body: { content: 'hi', timestamp: 1 } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    expect(notifyProjectOwner).not.toHaveBeenCalled();
  });

  it('notifies the project owner about a collaborator’s comment', async () => {
    const scenario = await seedVersion();
    const collaborator = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: collaborator.id });
    signedInAs(collaborator);
    vi.mocked(notifyProjectOwner).mockClear();

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), { body: { content: 'hi', timestamp: 1 } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    expect(notifyProjectOwner).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyProjectOwner).mock.calls[0][0]).toBe(scenario.owner.id);
  });

  it('accepts a timestamp exactly equal to the duration', async () => {
    const scenario = await seedVersion({ duration: 120 });
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), { body: { content: 'hi', timestamp: 120 } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    expect((await db.comment.findFirstOrThrow()).timestamp).toBe(120);
  });

  it('rejects a timestampEnd below the timestamp', async () => {
    const scenario = await seedVersion({ duration: 120 });
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { content: 'hi', timestamp: 10, timestampEnd: 5 },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toMatch(/greater than or equal/i);
  });

  it('rejects a comment with no content, voice, image or annotation', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), { body: { timestamp: 1 } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
  });

  it('rejects content longer than 10000 characters', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { content: 'x'.repeat(10_001), timestamp: 1 },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await db.comment.count()).toBe(0);
  });

  it.each([
    ['a bare object', { color: '#FF3B30', width: 4, points: [] }],
    ['a stroke with a 3-digit colour', [{ ...VALID_STROKE, color: '#f00' }]],
    ['a stroke with a named colour', [{ ...VALID_STROKE, color: 'red' }]],
    ['a stroke with width 0', [{ ...VALID_STROKE, width: 0 }]],
    ['a stroke with width 21', [{ ...VALID_STROKE, width: 21 }]],
    ['a stroke with a NaN coordinate', [{ ...VALID_STROKE, points: [{ x: 0, y: null }] }]],
    ['a stroke whose points are not an array', [{ ...VALID_STROKE, points: 'nope' }]],
    ['a double-encoded JSON string', JSON.stringify([VALID_STROKE])],
    ['an array of arrays', [[VALID_STROKE]]],
    ['an array containing null', [null]],
    ['a stroke with an unknown shape', [{ ...VALID_STROKE, shape: 'triangle' }]],
    [
      'a rectangle with three points',
      [{ ...VALID_STROKE, shape: 'rectangle', points: [...VALID_STROKE.points, { x: 1, y: 1 }] }],
    ],
  ])('rejects annotationData given as %s', async (_label, annotationData) => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { timestamp: 1, annotationData },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await db.comment.count()).toBe(0);
  });

  // Written as raw JSON on purpose. `{ __proto__: ... }` in an object literal
  // sets the prototype rather than creating an own property, so JSON.stringify
  // would silently drop it and the test would prove nothing. JSON.parse, by
  // contrast, does create a real own "__proto__" property.
  it('does not let a __proto__ key in annotationData reach the database or Object.prototype', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const rawBody = JSON.stringify({
      timestamp: 1,
      annotationData: [
        JSON.parse(
          '{"points":[{"x":0,"y":0}],"color":"#FF3B30","width":4,' +
            '"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}'
        ),
      ],
    });

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        method: 'POST',
        rawBody,
        headers: { 'content-type': 'application/json' },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    const stored = await db.comment.findFirstOrThrow();
    expect(stored.annotationData).toBe(
      JSON.stringify([{ points: [{ x: 0, y: 0 }], color: '#FF3B30', width: 4 }])
    );
    expect(stored.annotationData).not.toContain('polluted');
    expect(stored.annotationData).not.toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('re-serialises accepted annotation strokes into canonical form', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: {
          timestamp: 1,
          annotationData: [{ ...VALID_STROKE, extraneous: 'dropped', tool: '<script>' }],
        },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    const stored = await db.comment.findFirstOrThrow();
    expect(stored.annotationData).toBe(JSON.stringify([VALID_STROKE]));
    expect(stored.annotationData).not.toContain('extraneous');
    expect(stored.annotationData).not.toContain('script');
  });

  // The validator rebuilds each stroke field by field, so a field it does not know about is
  // dropped without an error. A rectangle saved that way comes back as a freehand diagonal.
  it('keeps the shape of rectangle, ellipse, line and arrow strokes when creating a comment', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    const drawing = [
      {
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.3 },
        ],
        color: '#FF3B30',
        width: 4,
        shape: 'rectangle',
      },
      {
        points: [
          { x: 0.2, y: 0.6 },
          { x: 0.3, y: 0.8 },
        ],
        color: '#AF52DE',
        width: 6,
        shape: 'ellipse',
      },
      {
        points: [
          { x: 0.5, y: 0.5 },
          { x: 0.6, y: 0.9 },
        ],
        color: '#007AFF',
        width: 2,
        shape: 'line',
      },
      {
        points: [
          { x: 0.9, y: 0.1 },
          { x: 0.7, y: 0.2 },
        ],
        color: '#FFCC00',
        width: 3,
        shape: 'arrow',
      },
      VALID_STROKE,
    ];

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { timestamp: 1, annotationData: drawing },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    const stored = await db.comment.findFirstOrThrow();
    expect(stored.annotationData).toBe(JSON.stringify(drawing));
  });

  it('keeps a shape when an edit replaces the drawing', async () => {
    const scenario = await seedVersion();
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      annotationData: JSON.stringify([VALID_STROKE]),
    });
    signedInAs(scenario.owner);
    const drawing = [
      {
        points: [
          { x: 0.2, y: 0.2 },
          { x: 0.8, y: 0.6 },
        ],
        color: '#34C759',
        width: 5,
        shape: 'rectangle',
      },
    ];

    const response = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { annotationData: drawing },
      }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(200);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).annotationData).toBe(
      JSON.stringify(drawing)
    );
  });

  it('rejects a parentId from another version', async () => {
    const scenario = await seedVersion();
    const otherVersion = await createVersion({
      videoParentId: scenario.video.id,
      versionNumber: 2,
    });
    const foreignParent = await createComment({
      versionId: otherVersion.id,
      authorId: scenario.owner.id,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { content: 'reply', timestamp: 1, parentId: foreignParent.id },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await db.comment.count()).toBe(1);
  });

  // IDOR: tags are per project, so a tag id from another project must not
  // attach.
  it('rejects a tagId that belongs to another project', async () => {
    const scenario = await seedVersion();
    const other = await seedVersion();
    const foreignTag = await createCommentTag({ projectId: other.project.id });
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { content: 'tagged', timestamp: 1, tagId: foreignTag.id },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await db.comment.count()).toBe(0);
  });

  it.each([
    ['/etc/passwd'],
    ['https://evil.example.com/x.png'],
    ['/api/upload/image/../../secret.png'],
    ['/api/upload/image/not-a-uuid.png'],
  ])('rejects the imageUrl %s', async (imageUrl) => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { content: 'attached', timestamp: 1, imageUrl },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await db.comment.count()).toBe(0);
  });

  it('stores an authenticated comment with the author, trimmed content and no guest fields', async () => {
    const scenario = await seedVersion();
    const tag = await createCommentTag({ projectId: scenario.project.id });
    const member = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: member.id });
    signedInAs(member);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: {
          content: '  needs a tighter cut  ',
          timestamp: 12.5,
          timestampEnd: 15,
          tagId: tag.id,
          guestName: 'Should Be Ignored',
          guestEmail: 'ignored@example.com',
        },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    const stored = await db.comment.findFirstOrThrow();
    expect(stored.content).toBe('needs a tighter cut');
    expect(stored.timestamp).toBe(12.5);
    expect(stored.timestampEnd).toBe(15);
    expect(stored.authorId).toBe(member.id);
    expect(stored.tagId).toBe(tag.id);
    // guestName/guestEmail must not be honoured for a signed-in author, or the
    // author could masquerade as a guest.
    expect(stored.guestName).toBeNull();
    expect(stored.guestEmail).toBeNull();
    expect(stored.guestIdentityId).toBeNull();
  });

  it('never leaks guestIdentityId in the response body', async () => {
    const scenario = await seedVersion();
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
      allowGuests: true,
    });
    signedOut();

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { content: 'from a guest', timestamp: 1, guestName: 'Casey' },
        cookies: {
          [getShareSessionCookieName(scenario.video.id)]: createShareSessionValue(
            link.token,
            scenario.video.id,
            false
          ),
        },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    const body = await readData<Record<string, unknown>>(response);
    expect(body).not.toHaveProperty('guestIdentityId');

    const stored = await db.comment.findFirstOrThrow();
    expect(stored.authorId).toBeNull();
    expect(stored.guestName).toBe('Casey');
    expect(stored.guestIdentityId).toBeTruthy();
    // The guest identity cookie is minted on the response so the guest can edit
    // their own comment later.
    expect(response.headers.get('set-cookie')).toContain('openframe_guest');
  });

  it('requires a guest name from an unauthenticated commenter', async () => {
    const scenario = await seedVersion();
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
      allowGuests: true,
    });
    signedOut();

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { content: 'nameless', timestamp: 1 },
        cookies: {
          [getShareSessionCookieName(scenario.video.id)]: createShareSessionValue(
            link.token,
            scenario.video.id,
            false
          ),
        },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await db.comment.count()).toBe(0);
  });

  it('refuses a guest on a share link with allowGuests false', async () => {
    const scenario = await seedVersion();
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
      allowGuests: false,
    });
    signedOut();

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { content: 'from a guest', timestamp: 1, guestName: 'Casey' },
        cookies: {
          [getShareSessionCookieName(scenario.video.id)]: createShareSessionValue(
            link.token,
            scenario.video.id,
            false
          ),
        },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.comment.count()).toBe(0);
  });

  it('refuses a guest holding a VIEW-only share session', async () => {
    const scenario = await seedVersion();
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'VIEW',
    });
    signedOut();

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { content: 'from a guest', timestamp: 1, guestName: 'Casey' },
        cookies: {
          [getShareSessionCookieName(scenario.video.id)]: createShareSessionValue(
            link.token,
            scenario.video.id,
            false
          ),
        },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.comment.count()).toBe(0);
  });

  it('rejects a malformed guest email', async () => {
    const scenario = await seedVersion();
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
    });
    signedOut();

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: {
          content: 'hi',
          timestamp: 1,
          guestName: 'Casey',
          guestEmail: 'not-an-email',
        },
        cookies: {
          [getShareSessionCookieName(scenario.video.id)]: createShareSessionValue(
            link.token,
            scenario.video.id,
            false
          ),
        },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await db.comment.count()).toBe(0);
  });
});

// A comment used to carry a single image. Screenshots arrive in batches, so the
// list is the contract now and the old `imageUrl` column follows its first entry.
describe('comment image attachments', () => {
  it('stores every image in order, points imageUrl at the first, and lists them all as assets', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { content: 'three shots', timestamp: 1, imageUrls: [IMAGE_A, IMAGE_B, IMAGE_C] },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    const created = await readData<{ id: string; images: { url: string }[] }>(response);
    expect(created.images.map((image) => image.url)).toEqual([IMAGE_A, IMAGE_B, IMAGE_C]);

    const stored = await db.comment.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.imageUrl).toBe(IMAGE_A);
    expect(await imageUrlsOf(created.id)).toEqual([IMAGE_A, IMAGE_B, IMAGE_C]);

    const assets = await db.videoAsset.findMany({
      where: { videoId: scenario.video.id, provider: 'R2_IMAGE' },
      select: { sourceUrl: true },
    });
    expect(assets.map((asset) => asset.sourceUrl).sort()).toEqual(
      [IMAGE_A, IMAGE_B, IMAGE_C].sort()
    );
  });

  it('still accepts the legacy single imageUrl', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { content: 'one shot', timestamp: 1, imageUrl: IMAGE_A },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    const created = await readData<{ id: string }>(response);
    expect(await imageUrlsOf(created.id)).toEqual([IMAGE_A]);
  });

  it('accepts a comment that is nothing but images', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { timestamp: 1, imageUrls: [IMAGE_A] },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
  });

  it('refuses more images than a comment may hold, and writes nothing', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: {
          content: 'too many',
          timestamp: 1,
          imageUrls: [IMAGE_A, IMAGE_B, IMAGE_C, IMAGE_D, IMAGE_E, IMAGE_F],
        },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe('A comment can have at most 5 images');
    expect(await db.comment.count()).toBe(0);
    expect(await db.commentImage.count()).toBe(0);
  });

  it('refuses the whole comment when one of the uploads has expired', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    vi.mocked(isFreshAttachment).mockImplementation(async (url: string) => ({
      isFresh: url !== IMAGE_B,
      sizeBytes: BigInt(1024),
    }));

    const response = await callRoute(
      createCommentRoute,
      apiRequest(commentsUrl(scenario.version.id), {
        body: { content: 'stale', timestamp: 1, imageUrls: [IMAGE_A, IMAGE_B] },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await db.comment.count()).toBe(0);
    expect(await db.commentImage.count()).toBe(0);
    vi.mocked(isFreshAttachment).mockResolvedValue({ isFresh: true, sizeBytes: BigInt(1024) });
  });

  it('replaces the list on edit: keeps one, drops one, adds one', async () => {
    const scenario = await seedVersion();
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      imageUrls: [IMAGE_A, IMAGE_B],
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { content: 'reworded', imageUrls: [IMAGE_B, IMAGE_C] },
      }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(200);
    expect(await imageUrlsOf(comment.id)).toEqual([IMAGE_B, IMAGE_C]);
    // The legacy column follows the new first image.
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).imageUrl).toBe(
      IMAGE_B
    );
    // The image added while editing shows up in the assets pane like any other.
    expect(await db.videoAsset.count({ where: { sourceUrl: IMAGE_C } })).toBe(1);
    // The detached file is not deleted here: the assets pane owns its lifetime.
    expect(await db.commentImage.count({ where: { url: IMAGE_A } })).toBe(0);
  });

  it('clears every image when the edit sends an empty list', async () => {
    const scenario = await seedVersion();
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      imageUrls: [IMAGE_A, IMAGE_B],
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { content: 'text only now', imageUrls: [] },
      }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(200);
    expect(await imageUrlsOf(comment.id)).toEqual([]);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).imageUrl).toBeNull();
  });

  it('leaves the images alone when the edit does not mention them', async () => {
    const scenario = await seedVersion();
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      imageUrls: [IMAGE_A],
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { content: 'only the words changed' },
      }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(200);
    expect(await imageUrlsOf(comment.id)).toEqual([IMAGE_A]);
  });

  it('returns 403 when somebody other than the author changes the images', async () => {
    const scenario = await seedVersion();
    const author = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: author.id });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: author.id,
      imageUrls: [IMAGE_A],
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { imageUrls: [IMAGE_A, IMAGE_B] },
      }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(403);
    expect(await imageUrlsOf(comment.id)).toEqual([IMAGE_A]);
  });

  it('refuses to steal an image that already hangs off another comment', async () => {
    const scenario = await seedVersion();
    const other = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      imageUrls: [IMAGE_A],
    });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      imageUrls: [IMAGE_B],
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { imageUrls: [IMAGE_B, IMAGE_A] },
      }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(400);
    expect(await imageUrlsOf(comment.id)).toEqual([IMAGE_B]);
    expect(await imageUrlsOf(other.id)).toEqual([IMAGE_A]);
  });

  it('refuses an edit that would carry more images than the cap', async () => {
    const scenario = await seedVersion();
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      imageUrls: [IMAGE_A],
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { imageUrls: [IMAGE_A, IMAGE_B, IMAGE_C, IMAGE_D, IMAGE_E, IMAGE_F] },
      }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(400);
    expect(await imageUrlsOf(comment.id)).toEqual([IMAGE_A]);
  });
});

describe('GET /api/comments/[commentId]', () => {
  it('returns 403 to a stranger and never exposes the project row', async () => {
    const scenario = await seedVersion();
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
    });
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(getCommentRoute, apiRequest(`/api/comments/${comment.id}`), {
      commentId: comment.id,
    });

    expect(response.status).toBe(403);
  });

  it('strips the joined version and project data for an authorised reader', async () => {
    const scenario = await seedVersion();
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
    });
    signedInAs(scenario.owner);

    const body = await readData<Record<string, unknown>>(
      await callRoute(getCommentRoute, apiRequest(`/api/comments/${comment.id}`), {
        commentId: comment.id,
      })
    );

    expect(body.id).toBe(comment.id);
    expect(body).not.toHaveProperty('version');
  });
});

describe('PATCH /api/comments/[commentId]', () => {
  it('returns 403 when a project member who is not the author edits the content', async () => {
    const scenario = await seedVersion();
    const author = await createUser();
    const other = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: author.id });
    await addProjectMember({ projectId: scenario.project.id, userId: other.id });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: author.id,
      content: 'original',
    });
    signedInAs(other);

    const response = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { content: 'hijacked' },
      }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(403);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).content).toBe(
      'original'
    );
  });

  // Even the project owner cannot rewrite somebody else's words: only resolve.
  it('returns 403 when the project owner edits another author content', async () => {
    const scenario = await seedVersion();
    const author = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: author.id });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: author.id,
      content: 'original',
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { content: 'rewritten by the owner' },
      }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(403);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).content).toBe(
      'original'
    );
  });

  it('returns 403 when a COMMENTATOR tries to resolve a comment', async () => {
    const scenario = await seedVersion();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: commentator.id,
    });
    signedInAs(commentator);

    const response = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { isResolved: true },
      }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(403);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).isResolved).toBe(
      false
    );
  });

  it('lets the author edit their own content', async () => {
    const scenario = await seedVersion();
    const author = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: author.id });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: author.id,
      content: 'original',
    });
    signedInAs(author);

    const response = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { content: '  corrected  ' },
      }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(200);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).content).toBe(
      'corrected'
    );
  });

  it('lets a workspace ADMIN resolve a comment and records resolvedAt', async () => {
    const scenario = await seedVersion();
    const workspaceAdmin = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: workspaceAdmin.id,
      role: 'ADMIN',
    });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
    });
    signedInAs(workspaceAdmin);

    const resolved = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { isResolved: true },
      }),
      { commentId: comment.id }
    );

    expect(resolved.status).toBe(200);
    const afterResolve = await db.comment.findUniqueOrThrow({ where: { id: comment.id } });
    expect(afterResolve.isResolved).toBe(true);
    expect(afterResolve.resolvedAt).toBeInstanceOf(Date);

    const reopened = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { isResolved: false },
      }),
      { commentId: comment.id }
    );

    expect(reopened.status).toBe(200);
    const afterReopen = await db.comment.findUniqueOrThrow({ where: { id: comment.id } });
    expect(afterReopen.isResolved).toBe(false);
    expect(afterReopen.resolvedAt).toBeNull();
  });

  it('rejects a tagId from another project on edit', async () => {
    const scenario = await seedVersion();
    const other = await seedVersion();
    const foreignTag = await createCommentTag({ projectId: other.project.id });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { tagId: foreignTag.id },
      }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(400);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).tagId).toBeNull();
  });
});

describe('DELETE /api/comments/[commentId]', () => {
  it('returns 404 for an unknown comment', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(
      deleteCommentRoute,
      apiRequest('/api/comments/nope', { method: 'DELETE' }),
      { commentId: 'nope' }
    );

    expect(response.status).toBe(404);
  });

  // The ownership guard. A COMMENTATOR has project access and can comment, but
  // must not be able to delete another person's comment.
  it('returns 403 for a project COMMENTATOR who is not the author', async () => {
    const scenario = await seedVersion();
    const author = await createUser();
    const commentator = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: author.id });
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: author.id,
    });
    signedInAs(commentator);

    const response = await callRoute(
      deleteCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, { method: 'DELETE' }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(403);
    expect(await db.comment.findUnique({ where: { id: comment.id } })).not.toBeNull();
  });

  it('returns 403 for an anonymous caller with no guest identity', async () => {
    const scenario = await seedVersion();
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
    });
    signedOut();

    const response = await callRoute(
      deleteCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, { method: 'DELETE' }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(403);
    expect(await db.comment.count()).toBe(1);
  });

  it('lets the author delete their own comment and cascades to replies', async () => {
    const scenario = await seedVersion();
    const author = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: author.id });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: author.id,
    });
    await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      parentId: comment.id,
    });
    signedInAs(author);

    const response = await callRoute(
      deleteCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, { method: 'DELETE' }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(200);
    expect(await db.comment.count()).toBe(0);
  });

  it('lets the project owner delete somebody else comment', async () => {
    const scenario = await seedVersion();
    const author = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: author.id });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: author.id,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      deleteCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, { method: 'DELETE' }),
      { commentId: comment.id }
    );

    expect(response.status).toBe(200);
    expect(await db.comment.count()).toBe(0);
  });
});
