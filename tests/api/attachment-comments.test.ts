import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { GET, POST } from '@/app/api/videos/[videoId]/attachment-comments/route';
import { DELETE } from '@/app/api/videos/[videoId]/attachment-comments/[attachmentCommentId]/route';
import { DELETE as deleteAsset } from '@/app/api/videos/[videoId]/assets/[assetId]/route';
import { PATCH as patchSourceComment } from '@/app/api/comments/[commentId]/route';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import {
  createComment,
  createShareLink,
  createUser,
  createVersion,
  createVideo,
  createVideoAsset,
  seedVersion,
} from '../factories';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';

const IMAGE_A = '/api/upload/image/11111111-2222-3333-4444-555555555555.png';
const IMAGE_B = '/api/upload/image/66666666-7777-8888-9999-aaaaaaaaaaaa.png';
const IMAGE_C = '/api/upload/image/bbbbbbbb-cccc-dddd-eeee-ffffffffffff.png';
const AUDIO_A = '/api/upload/audio/11111111-2222-3333-4444-555555555555.webm';

type Target =
  | { type: 'asset'; id: string }
  | { type: 'comment-image'; id: string; url: string }
  | { type: 'comment-audio'; id: string };

type ListedComment = {
  id: string;
  content: string;
  timestamp: number | null;
  annotationData: string | null;
  guestName: string | null;
  author: { id: string; name: string | null; image: string | null } | null;
  canDelete: boolean;
};

function url(videoId: string) {
  return `/api/videos/${videoId}/attachment-comments`;
}

function targetQuery(target: Target) {
  return {
    targetType: target.type,
    targetId: target.id,
    ...(target.type === 'comment-image' ? { imageUrl: target.url } : {}),
  };
}

async function post(videoId: string, target: Target, content: string, guestName?: string) {
  return callRoute(
    POST,
    apiRequest(url(videoId), { body: { target, content, ...(guestName ? { guestName } : {}) } }),
    { videoId }
  );
}

async function postWithAnnotation(
  videoId: string,
  target: Target,
  annotationData: unknown,
  content = '',
  timestamp?: unknown
) {
  return callRoute(
    POST,
    apiRequest(url(videoId), {
      body: { target, content, annotationData, ...(timestamp !== undefined ? { timestamp } : {}) },
    }),
    { videoId }
  );
}

async function postWithTimestamp(videoId: string, target: Target, timestamp: unknown) {
  return callRoute(
    POST,
    apiRequest(url(videoId), { body: { target, content: 'Playback note', timestamp } }),
    { videoId }
  );
}

const DRAWING = [
  {
    points: [
      { x: 0.25, y: 0.5 },
      { x: 0.75, y: 0.6 },
    ],
    color: '#FF3B30',
    width: 4,
  },
];

async function list(videoId: string, target: Target, extra: Record<string, string | number> = {}) {
  return callRoute(
    GET,
    apiRequest(url(videoId), { searchParams: { ...targetQuery(target), ...extra } }),
    { videoId }
  );
}

async function remove(videoId: string, attachmentCommentId: string) {
  return callRoute(
    DELETE,
    apiRequest(`${url(videoId)}/${attachmentCommentId}`, { method: 'DELETE' }),
    { videoId, attachmentCommentId }
  );
}

async function removeAsset(videoId: string, assetId: string) {
  return callRoute(
    deleteAsset,
    apiRequest(`/api/videos/${videoId}/assets/${assetId}`, { method: 'DELETE' }),
    { videoId, assetId }
  );
}

async function assetScenario() {
  const scenario = await seedVersion({ visibility: 'PRIVATE' });
  const asset = await createVideoAsset({
    videoId: scenario.video.id,
    billedUserId: scenario.owner.id,
  });
  return { ...scenario, asset, target: { type: 'asset' as const, id: asset.id } };
}

function shareCookie(videoId: string, token: string) {
  return {
    [getShareSessionCookieName(videoId)]: createShareSessionValue(token, videoId, false),
  };
}

describe('video attachment comments API', () => {
  it('refuses anonymous reads and writes on a private video without adding a row', async () => {
    const { video, target } = await assetScenario();
    signedOut();

    expect((await list(video.id, target)).status).toBe(403);
    expect((await post(video.id, target, 'No access')).status).toBe(403);
    expect(await db.attachmentComment.count()).toBe(0);
  });

  it('refuses an unrelated signed-in user and preserves an existing row on DELETE', async () => {
    const { owner, video, target } = await assetScenario();
    signedInAs(owner);
    const created = await post(video.id, target, 'Keep this');
    expect(created.status).toBe(201);
    const row = await db.attachmentComment.findFirstOrThrow();

    signedInAs(await createUser());
    expect((await list(video.id, target)).status).toBe(403);
    expect((await post(video.id, target, 'Forbidden')).status).toBe(403);
    expect((await remove(video.id, row.id)).status).toBe(403);
    expect(await db.attachmentComment.findUnique({ where: { id: row.id } })).toMatchObject({
      content: 'Keep this',
      assetId: target.id,
    });
    expect(await db.attachmentComment.count()).toBe(1);
  });

  it('creates, lists, paginates, and deletes asset comments with persisted attribution', async () => {
    const { owner, video, target } = await assetScenario();
    signedInAs(owner);
    expect((await post(video.id, target, 'First')).status).toBe(201);
    const second = await post(video.id, target, 'Second');
    expect(second.status).toBe(201);
    const created = await readData<{ comment: ListedComment }>(second);
    expect(created.comment).toMatchObject({
      content: 'Second',
      annotationData: null,
      author: { id: owner.id },
      canDelete: true,
    });
    expect(
      await db.attachmentComment.count({ where: { assetId: target.id, authorId: owner.id } })
    ).toBe(2);

    const page = await readData<{
      comments: ListedComment[];
      total: number;
      hasMore: boolean;
      canComment: boolean;
    }>(await list(video.id, target, { offset: 0, limit: 1 }));
    expect(page).toMatchObject({ total: 2, hasMore: true, canComment: true });
    expect(page.comments).toHaveLength(1);
    expect(page.comments[0].canDelete).toBe(true);
    const next = await readData<{ comments: ListedComment[]; total: number; hasMore: boolean }>(
      await list(video.id, target, { offset: 1, limit: 1 })
    );
    expect(next).toMatchObject({ total: 2, hasMore: false });
    expect(next.comments).toHaveLength(1);
    expect(next.comments[0].id).not.toBe(page.comments[0].id);

    expect((await remove(video.id, created.comment.id)).status).toBe(200);
    expect(await db.attachmentComment.findUnique({ where: { id: created.comment.id } })).toBeNull();
    expect(await db.attachmentComment.count({ where: { assetId: target.id } })).toBe(1);
  });

  it('persists zero and fractional timestamps on audio and video assets', async () => {
    const { owner, video } = await seedVersion({ visibility: 'PRIVATE' });
    const audio = await createVideoAsset({
      videoId: video.id,
      billedUserId: owner.id,
      kind: 'AUDIO',
      provider: 'R2_AUDIO',
      sourceUrl: AUDIO_A,
    });
    const videoAsset = await createVideoAsset({
      videoId: video.id,
      billedUserId: owner.id,
      kind: 'VIDEO',
      provider: 'BUNNY',
      sourceUrl: 'https://example.com/attachment-video.mp4',
    });
    signedInAs(owner);

    for (const [target, timestamp] of [
      [{ type: 'asset' as const, id: audio.id }, 0],
      [{ type: 'asset' as const, id: videoAsset.id }, 12.375],
    ] as const) {
      const response = await postWithTimestamp(video.id, target, timestamp);
      expect(response.status).toBe(201);
      const created = (await readData<{ comment: ListedComment }>(response)).comment;
      expect(created.timestamp).toBe(timestamp);
      expect(
        await db.attachmentComment.findUniqueOrThrow({ where: { id: created.id } })
      ).toMatchObject({ timestamp });
      const listed = await readData<{ comments: ListedComment[] }>(await list(video.id, target));
      expect(listed.comments).toEqual([expect.objectContaining({ id: created.id, timestamp })]);
    }
  });

  it('accepts a timestamp on comment audio after resolving it to an audio asset', async () => {
    const { owner, video, version } = await seedVersion({ visibility: 'PRIVATE' });
    const audio = await createVideoAsset({
      videoId: video.id,
      billedUserId: owner.id,
      kind: 'AUDIO',
      provider: 'R2_AUDIO',
      sourceUrl: AUDIO_A,
    });
    const source = await createComment({
      versionId: version.id,
      authorId: owner.id,
      voiceUrl: AUDIO_A,
    });
    signedInAs(owner);
    const target: Target = { type: 'comment-audio', id: source.id };

    const response = await postWithTimestamp(video.id, target, 3.25);
    expect(response.status).toBe(201);
    const created = (await readData<{ comment: ListedComment }>(response)).comment;
    expect(created.timestamp).toBe(3.25);
    expect(
      await db.attachmentComment.findUniqueOrThrow({ where: { id: created.id } })
    ).toMatchObject({
      targetType: 'ASSET',
      assetId: audio.id,
      timestamp: 3.25,
    });
    const listed = await readData<{ comments: ListedComment[] }>(await list(video.id, target));
    expect(listed.comments).toEqual([expect.objectContaining({ id: created.id, timestamp: 3.25 })]);
  });

  it('returns null for legacy and explicit null timestamps', async () => {
    const { owner, video, target } = await assetScenario();
    signedInAs(owner);

    const legacy = await post(video.id, target, 'General image note');
    expect(legacy.status).toBe(201);
    expect((await readData<{ comment: ListedComment }>(legacy)).comment.timestamp).toBeNull();
    const explicitNull = await postWithTimestamp(video.id, target, null);
    expect(explicitNull.status).toBe(201);
    expect((await readData<{ comment: ListedComment }>(explicitNull)).comment.timestamp).toBeNull();
    expect(await db.attachmentComment.count({ where: { timestamp: null } })).toBe(2);
    const listed = await readData<{ comments: ListedComment[] }>(await list(video.id, target));
    expect(listed.comments.map((comment) => comment.timestamp)).toEqual([null, null]);
  });

  it('enforces the timestamp range in the database', async () => {
    const { owner, video } = await seedVersion({ visibility: 'PRIVATE' });
    const audio = await createVideoAsset({
      videoId: video.id,
      billedUserId: owner.id,
      kind: 'AUDIO',
      provider: 'R2_AUDIO',
      sourceUrl: AUDIO_A,
    });
    const target: Target = { type: 'asset', id: audio.id };
    signedInAs(owner);
    const response = await postWithTimestamp(video.id, target, 86400);
    expect(response.status).toBe(201);
    const created = (await readData<{ comment: ListedComment }>(response)).comment;

    await expect(
      db.$executeRaw`UPDATE attachment_comments SET "timestamp" = ${86400.001} WHERE id = ${created.id}`
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE attachment_comments SET "timestamp" = ${-0.001} WHERE id = ${created.id}`
    ).rejects.toThrow();
    expect(
      await db.attachmentComment.findUniqueOrThrow({ where: { id: created.id } })
    ).toMatchObject({
      timestamp: 86400,
    });
  });

  it.each([
    ['negative', -0.5],
    ['above maximum', 86400.001],
    ['NaN string', 'NaN'],
    ['infinity string', 'Infinity'],
    ['numeric string', '12.5'],
  ])('rejects %s timestamps without adding a row', async (_label, timestamp) => {
    const { owner, video } = await seedVersion({ visibility: 'PRIVATE' });
    const audio = await createVideoAsset({
      videoId: video.id,
      billedUserId: owner.id,
      kind: 'AUDIO',
      provider: 'R2_AUDIO',
      sourceUrl: AUDIO_A,
    });
    signedInAs(owner);

    expect(
      (await postWithTimestamp(video.id, { type: 'asset', id: audio.id }, timestamp)).status
    ).toBe(400);
    expect(await db.attachmentComment.count()).toBe(0);
  });

  it('rejects timestamp zero on image assets and comment images', async () => {
    const { owner, video, version, target } = await assetScenario();
    const source = await createComment({ versionId: version.id, authorId: owner.id });
    await db.comment.update({ where: { id: source.id }, data: { imageUrl: IMAGE_C } });
    signedInAs(owner);

    expect((await postWithTimestamp(video.id, target, 0)).status).toBe(400);
    expect(
      (await postWithTimestamp(video.id, { type: 'comment-image', id: source.id, url: IMAGE_C }, 0))
        .status
    ).toBe(400);
    expect(await db.attachmentComment.count()).toBe(0);
  });

  it('refuses timestamped writes without permission and preserves the existing row', async () => {
    const { owner, video } = await seedVersion({ visibility: 'PRIVATE' });
    const audio = await createVideoAsset({
      videoId: video.id,
      billedUserId: owner.id,
      kind: 'AUDIO',
      provider: 'R2_AUDIO',
      sourceUrl: AUDIO_A,
    });
    const target: Target = { type: 'asset', id: audio.id };
    signedInAs(owner);
    expect((await postWithTimestamp(video.id, target, 5)).status).toBe(201);

    signedOut();
    expect((await postWithTimestamp(video.id, target, 6)).status).toBe(403);
    signedInAs(await createUser());
    expect((await postWithTimestamp(video.id, target, 7)).status).toBe(403);
    expect(await db.attachmentComment.count()).toBe(1);
    expect(await db.attachmentComment.findFirstOrThrow()).toMatchObject({ timestamp: 5 });
  });

  it('persists an annotation-only image comment and returns canonical strokes in POST and GET', async () => {
    const { owner, video, target } = await assetScenario();
    signedInAs(owner);
    const response = await postWithAnnotation(video.id, target, [
      {
        ...DRAWING[0],
        tool: 'pen',
        points: [
          { x: 0.25, y: 0.5, pressure: 1 },
          { x: 0.75, y: 0.6, pressure: 0.5 },
        ],
      },
    ]);

    expect(response.status).toBe(201);
    const created = (await readData<{ comment: ListedComment }>(response)).comment;
    expect(created).toMatchObject({ content: '', annotationData: JSON.stringify(DRAWING) });
    const row = await db.attachmentComment.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({
      content: '',
      assetId: target.id,
      annotationData: JSON.stringify(DRAWING),
    });
    const listed = await readData<{ comments: ListedComment[] }>(await list(video.id, target));
    expect(listed.comments).toEqual([
      expect.objectContaining({ id: created.id, annotationData: JSON.stringify(DRAWING) }),
    ]);
  });

  it('normalizes an empty drawing with text to a plain comment', async () => {
    const { owner, video, target } = await assetScenario();
    signedInAs(owner);
    const response = await postWithAnnotation(video.id, target, [], 'Text without a drawing');
    expect(response.status).toBe(201);
    const created = (await readData<{ comment: ListedComment }>(response)).comment;
    expect(created.annotationData).toBeNull();
    expect(
      await db.attachmentComment.findUniqueOrThrow({ where: { id: created.id } })
    ).toMatchObject({ content: 'Text without a drawing', annotationData: null });
    const listed = await readData<{ comments: ListedComment[] }>(await list(video.id, target));
    expect(listed.comments[0].annotationData).toBeNull();
  });

  it('accepts a drawing on a legacy comment image', async () => {
    const { owner, video, version } = await seedVersion({ visibility: 'PRIVATE' });
    const source = await createComment({ versionId: version.id, authorId: owner.id });
    await db.comment.update({ where: { id: source.id }, data: { imageUrl: IMAGE_C } });
    const target: Target = { type: 'comment-image', id: source.id, url: IMAGE_C };
    signedInAs(owner);

    const response = await postWithAnnotation(video.id, target, DRAWING);
    expect(response.status).toBe(201);
    expect(await db.attachmentComment.findFirstOrThrow()).toMatchObject({
      targetType: 'COMMENT_IMAGE',
      sourceCommentId: source.id,
      annotationData: JSON.stringify(DRAWING),
    });
    const listed = await readData<{ comments: ListedComment[] }>(await list(video.id, target));
    expect(listed.comments[0].annotationData).toBe(JSON.stringify(DRAWING));
  });

  it.each([
    ['string', '[]'],
    ['invalid stroke', [{ ...DRAWING[0], width: 21 }]],
    ['too many strokes', Array.from({ length: 501 }, () => DRAWING[0])],
    ['empty array', []],
    ['no drawn points', [{ ...DRAWING[0], points: [] }]],
    ['one undrawn point', [{ ...DRAWING[0], points: [{ x: 0.2, y: 0.3 }] }]],
  ])('rejects an annotation-only comment with %s', async (_label, annotationData) => {
    const { owner, video, target } = await assetScenario();
    signedInAs(owner);

    expect((await postWithAnnotation(video.id, target, annotationData)).status).toBe(400);
    expect(await db.attachmentComment.count()).toBe(0);
  });

  it('rejects empty text and an empty drawing together', async () => {
    const { owner, video, target } = await assetScenario();
    signedInAs(owner);

    expect((await post(video.id, target, '  ')).status).toBe(400);
    expect((await postWithAnnotation(video.id, target, [], '  ')).status).toBe(400);
    expect(await db.attachmentComment.count()).toBe(0);
  });

  it('persists a video drawing on frame zero and returns it through POST and GET', async () => {
    const { owner, video } = await seedVersion({ visibility: 'PRIVATE' });
    const asset = await createVideoAsset({
      videoId: video.id,
      billedUserId: owner.id,
      kind: 'VIDEO',
      provider: 'BUNNY',
    });
    const target: Target = { type: 'asset', id: asset.id };
    signedInAs(owner);

    const response = await postWithAnnotation(video.id, target, DRAWING, '', 0);
    expect(response.status).toBe(201);
    const created = (await readData<{ comment: ListedComment }>(response)).comment;
    expect(created).toMatchObject({
      content: '',
      timestamp: 0,
      annotationData: JSON.stringify(DRAWING),
    });
    expect(
      await db.attachmentComment.findUniqueOrThrow({ where: { id: created.id } })
    ).toMatchObject({
      assetId: asset.id,
      timestamp: 0,
      annotationData: JSON.stringify(DRAWING),
    });
    const listed = await readData<{ comments: ListedComment[] }>(await list(video.id, target));
    expect(listed.comments).toEqual([
      expect.objectContaining({
        id: created.id,
        timestamp: 0,
        annotationData: JSON.stringify(DRAWING),
      }),
    ]);
  });

  it.each([
    ['missing', undefined, ''],
    ['missing even with text', undefined, 'Frame note'],
    ['null', null, ''],
    ['negative', -1, ''],
    ['string', '12', ''],
  ])('rejects a video drawing with a %s timestamp', async (_label, timestamp, content) => {
    const { owner, video } = await seedVersion({ visibility: 'PRIVATE' });
    const asset = await createVideoAsset({
      videoId: video.id,
      billedUserId: owner.id,
      kind: 'VIDEO',
      provider: 'BUNNY',
    });
    signedInAs(owner);

    expect(
      (
        await postWithAnnotation(
          video.id,
          { type: 'asset', id: asset.id },
          DRAWING,
          content,
          timestamp
        )
      ).status
    ).toBe(400);
    expect(await db.attachmentComment.count()).toBe(0);
  });

  it('refuses drawings on audio attachments even with a timestamp', async () => {
    const { owner, video, version } = await seedVersion({ visibility: 'PRIVATE' });
    const audio = await createVideoAsset({
      videoId: video.id,
      billedUserId: owner.id,
      kind: 'AUDIO',
      provider: 'R2_AUDIO',
      sourceUrl: AUDIO_A,
    });
    const source = await createComment({
      versionId: version.id,
      authorId: owner.id,
      voiceUrl: AUDIO_A,
    });
    signedInAs(owner);

    for (const target of [
      { type: 'asset' as const, id: audio.id },
      { type: 'comment-audio' as const, id: source.id },
    ]) {
      expect((await postWithAnnotation(video.id, target, DRAWING, '', 3.5)).status).toBe(400);
    }
    expect(await db.attachmentComment.count()).toBe(0);
  });

  it('refuses annotation writes without permission and preserves the existing comment', async () => {
    const { owner, video, target } = await assetScenario();
    signedInAs(owner);
    const initial = await post(video.id, target, 'Keep this');
    expect(initial.status).toBe(201);
    const row = await db.attachmentComment.findFirstOrThrow();

    signedOut();
    expect((await postWithAnnotation(video.id, target, DRAWING)).status).toBe(403);
    signedInAs(await createUser());
    expect((await postWithAnnotation(video.id, target, DRAWING)).status).toBe(403);
    expect(await db.attachmentComment.count()).toBe(1);
    expect(await db.attachmentComment.findUnique({ where: { id: row.id } })).toMatchObject({
      content: 'Keep this',
      annotationData: null,
    });
  });

  it('allows a COMMENT share guest to draw on a video frame but refuses a VIEW share guest', async () => {
    const { project, video, owner } = await seedVersion({ visibility: 'PRIVATE' });
    const asset = await createVideoAsset({
      videoId: video.id,
      billedUserId: owner.id,
      kind: 'VIDEO',
      provider: 'BUNNY',
    });
    const target: Target = { type: 'asset', id: asset.id };
    const commentLink = await createShareLink({
      projectId: project.id,
      videoId: video.id,
      permission: 'COMMENT',
      allowGuests: true,
    });
    const viewLink = await createShareLink({
      projectId: project.id,
      videoId: video.id,
      permission: 'VIEW',
      allowGuests: true,
    });
    signedOut();
    const body = {
      target,
      content: '',
      annotationData: DRAWING,
      timestamp: 9.5,
      guestName: 'Reviewer',
    };

    const allowed = await callRoute(
      POST,
      apiRequest(url(video.id), { body, cookies: shareCookie(video.id, commentLink.token) }),
      { videoId: video.id }
    );
    expect(allowed.status).toBe(201);
    expect(await db.attachmentComment.findFirstOrThrow()).toMatchObject({
      assetId: asset.id,
      authorId: null,
      guestName: 'Reviewer',
      timestamp: 9.5,
      annotationData: JSON.stringify(DRAWING),
    });

    const denied = await callRoute(
      POST,
      apiRequest(url(video.id), { body, cookies: shareCookie(video.id, viewLink.token) }),
      { videoId: video.id }
    );
    expect(denied.status).toBe(403);
    expect(await db.attachmentComment.count()).toBe(1);
  });

  it('lets a COMMENT share guest write with a name and a VIEW share guest only read', async () => {
    const { project, video, target } = await assetScenario();
    const commentLink = await createShareLink({
      projectId: project.id,
      videoId: video.id,
      permission: 'COMMENT',
      allowGuests: true,
    });
    const viewLink = await createShareLink({
      projectId: project.id,
      videoId: video.id,
      permission: 'VIEW',
      allowGuests: true,
    });
    signedOut();

    const response = await callRoute(
      POST,
      apiRequest(url(video.id), {
        body: { target, content: 'Guest note', guestName: 'Reviewer' },
        cookies: shareCookie(video.id, commentLink.token),
      }),
      { videoId: video.id }
    );
    expect(response.status).toBe(201);
    const row = await db.attachmentComment.findFirstOrThrow();
    expect(row).toMatchObject({ content: 'Guest note', authorId: null, guestName: 'Reviewer' });

    const view = await callRoute(
      GET,
      apiRequest(url(video.id), {
        searchParams: targetQuery(target),
        cookies: shareCookie(video.id, viewLink.token),
      }),
      { videoId: video.id }
    );
    expect(view.status).toBe(200);
    const data = await readData<{ comments: ListedComment[]; canComment: boolean }>(view);
    expect(data.canComment).toBe(false);
    expect(data.comments).toEqual([
      expect.objectContaining({
        id: row.id,
        guestName: 'Reviewer',
        author: null,
        canDelete: false,
      }),
    ]);

    const denied = await callRoute(
      POST,
      apiRequest(url(video.id), {
        body: { target, content: 'View cannot write', guestName: 'Reviewer' },
        cookies: shareCookie(video.id, viewLink.token),
      }),
      { videoId: video.id }
    );
    expect(denied.status).toBe(403);
    expect(await db.attachmentComment.count()).toBe(1);
  });

  it('lets only the guest identity that wrote a comment delete it', async () => {
    const { project, video, target } = await assetScenario();
    const link = await createShareLink({
      projectId: project.id,
      videoId: video.id,
      permission: 'COMMENT',
      allowGuests: true,
    });
    signedOut();
    const share = shareCookie(video.id, link.token);
    const first = await callRoute(
      POST,
      apiRequest(url(video.id), {
        body: { target, content: 'First guest', guestName: 'Reviewer' },
        cookies: share,
      }),
      { videoId: video.id }
    );
    expect(first.status).toBe(201);
    const firstId = (await readData<{ comment: { id: string } }>(first)).comment.id;
    const firstIdentity = first.headers
      .get('set-cookie')
      ?.match(/openframe_guest_identity=([^;]+)/)?.[1];
    expect(firstIdentity).toBeTruthy();

    const second = await callRoute(
      POST,
      apiRequest(url(video.id), {
        body: { target, content: 'Second guest', guestName: 'Reviewer' },
        cookies: share,
      }),
      { videoId: video.id }
    );
    expect(second.status).toBe(201);
    const secondId = (await readData<{ comment: { id: string } }>(second)).comment.id;
    const secondIdentity = second.headers
      .get('set-cookie')
      ?.match(/openframe_guest_identity=([^;]+)/)?.[1];
    expect(secondIdentity).toBeTruthy();
    expect(secondIdentity).not.toBe(firstIdentity);
    expect(
      (await db.attachmentComment.findUniqueOrThrow({ where: { id: firstId } })).guestIdentityId
    ).not.toBe(
      (await db.attachmentComment.findUniqueOrThrow({ where: { id: secondId } })).guestIdentityId
    );

    const deletionUrl = `${url(video.id)}/${firstId}`;
    const foreignDelete = await callRoute(
      DELETE,
      apiRequest(deletionUrl, {
        method: 'DELETE',
        cookies: { ...share, openframe_guest_identity: secondIdentity! },
      }),
      { videoId: video.id, attachmentCommentId: firstId }
    );
    expect(foreignDelete.status).toBe(403);
    expect(await db.attachmentComment.findUnique({ where: { id: firstId } })).toMatchObject({
      content: 'First guest',
      guestName: 'Reviewer',
    });

    const ownDelete = await callRoute(
      DELETE,
      apiRequest(deletionUrl, {
        method: 'DELETE',
        cookies: { ...share, openframe_guest_identity: firstIdentity! },
      }),
      { videoId: video.id, attachmentCommentId: firstId }
    );
    expect(ownDelete.status).toBe(200);
    expect(await db.attachmentComment.findUnique({ where: { id: firstId } })).toBeNull();
    expect(await db.attachmentComment.findUnique({ where: { id: secondId } })).toMatchObject({
      content: 'Second guest',
    });
  });

  it('hides deletion after a signed-in author loses comment permission on a share', async () => {
    const { video, project, target } = await assetScenario();
    const author = await createUser();
    const link = await createShareLink({
      projectId: project.id,
      videoId: video.id,
      permission: 'COMMENT',
    });
    signedInAs(author);
    const cookies = shareCookie(video.id, link.token);
    const response = await callRoute(
      POST,
      apiRequest(url(video.id), {
        body: { target, content: 'Keep after permission change' },
        cookies,
      }),
      { videoId: video.id }
    );
    expect(response.status).toBe(201);
    const row = await db.attachmentComment.findFirstOrThrow();
    await db.shareLink.update({ where: { id: link.id }, data: { permission: 'VIEW' } });
    const listed = await callRoute(
      GET,
      apiRequest(url(video.id), {
        searchParams: targetQuery(target),
        cookies,
      }),
      { videoId: video.id }
    );
    expect(listed.status).toBe(200);
    const data = await readData<{ comments: ListedComment[]; canComment: boolean }>(listed);
    expect(data.canComment).toBe(false);
    expect(data.comments).toEqual([expect.objectContaining({ id: row.id, canDelete: false })]);
    const denied = await callRoute(
      DELETE,
      apiRequest(`${url(video.id)}/${row.id}`, {
        method: 'DELETE',
        cookies,
      }),
      { videoId: video.id, attachmentCommentId: row.id }
    );
    expect(denied.status).toBe(403);
    expect(await db.attachmentComment.findUnique({ where: { id: row.id } })).not.toBeNull();
  });

  it('rejects attachment targets belonging to another video', async () => {
    const { owner, project, video } = await seedVersion({ visibility: 'PRIVATE' });
    const otherVideo = await createVideo({ projectId: project.id });
    const asset = await createVideoAsset({ videoId: otherVideo.id, billedUserId: owner.id });
    const otherVersion = await createVersion({ videoParentId: otherVideo.id });
    const source = await createComment({
      versionId: otherVersion.id,
      authorId: owner.id,
      imageUrls: [IMAGE_A],
      voiceUrl: AUDIO_A,
    });
    signedInAs(owner);

    for (const target of [
      { type: 'asset' as const, id: asset.id },
      { type: 'comment-image' as const, id: source.id, url: IMAGE_A },
      { type: 'comment-audio' as const, id: source.id },
    ]) {
      expect((await post(video.id, target, 'Wrong video')).status).toBe(404);
    }
    expect(await db.attachmentComment.count()).toBe(0);
  });

  it('keeps two images on the same comment in separate discussions', async () => {
    const { owner, video, version } = await seedVersion({ visibility: 'PRIVATE' });
    const source = await createComment({
      versionId: version.id,
      authorId: owner.id,
      imageUrls: [IMAGE_A, IMAGE_B],
    });
    const first: Target = { type: 'comment-image', id: source.id, url: IMAGE_A };
    const second: Target = { type: 'comment-image', id: source.id, url: IMAGE_B };
    signedInAs(owner);

    expect((await post(video.id, first, 'Only image A')).status).toBe(201);
    expect((await post(video.id, second, 'Only image B')).status).toBe(201);
    const firstData = await readData<{ comments: ListedComment[]; total: number }>(
      await list(video.id, first)
    );
    const secondData = await readData<{ comments: ListedComment[]; total: number }>(
      await list(video.id, second)
    );
    expect(firstData.comments.map((item) => item.content)).toEqual(['Only image A']);
    expect(secondData.comments.map((item) => item.content)).toEqual(['Only image B']);
    expect(firstData.total).toBe(1);
    expect(secondData.total).toBe(1);
    expect(await db.attachmentComment.count({ where: { sourceCommentId: source.id } })).toBe(2);
  });

  it('shares an image discussion between its asset and a reply attachment', async () => {
    const { owner, video, version } = await seedVersion({ visibility: 'PRIVATE' });
    const asset = await createVideoAsset({
      videoId: video.id,
      billedUserId: owner.id,
      sourceUrl: IMAGE_A,
    });
    const parent = await createComment({ versionId: version.id, authorId: owner.id });
    const reply = await createComment({
      versionId: version.id,
      parentId: parent.id,
      authorId: owner.id,
      imageUrls: [IMAGE_A],
    });
    const imageTarget: Target = { type: 'comment-image', id: reply.id, url: IMAGE_A };
    const assetTarget: Target = { type: 'asset', id: asset.id };
    signedInAs(owner);

    expect((await post(video.id, imageTarget, 'From reply')).status).toBe(201);
    const throughAsset = await readData<{ comments: ListedComment[]; total: number }>(
      await list(video.id, assetTarget)
    );
    expect(throughAsset.comments.map((comment) => comment.content)).toEqual(['From reply']);
    expect(throughAsset.total).toBe(1);

    expect((await post(video.id, assetTarget, 'From asset')).status).toBe(201);
    const throughReply = await readData<{ comments: ListedComment[]; total: number }>(
      await list(video.id, imageTarget)
    );
    expect(throughReply.comments.map((comment) => comment.content).sort()).toEqual([
      'From asset',
      'From reply',
    ]);
    expect(throughReply.total).toBe(2);
    const rows = await db.attachmentComment.findMany({
      select: { targetType: true, assetId: true, sourceCommentId: true, content: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      expect.objectContaining({ targetType: 'ASSET', assetId: asset.id, sourceCommentId: null }),
      expect.objectContaining({ targetType: 'ASSET', assetId: asset.id, sourceCommentId: null }),
    ]);

    const counts = await readData<{ counts: Record<string, number> }>(
      await callRoute(
        GET,
        apiRequest(url(video.id), { searchParams: { counts: true, versionId: version.id } }),
        { videoId: video.id }
      )
    );
    expect(counts.counts).toMatchObject({
      [`asset:${asset.id}`]: 2,
      [`comment-image:${reply.id}:${IMAGE_A}`]: 2,
    });
  });

  it('shares an audio discussion between its asset and a source comment', async () => {
    const { owner, video, version } = await seedVersion({ visibility: 'PRIVATE' });
    const asset = await createVideoAsset({
      videoId: video.id,
      billedUserId: owner.id,
      kind: 'AUDIO',
      provider: 'R2_AUDIO',
      sourceUrl: AUDIO_A,
    });
    const source = await createComment({
      versionId: version.id,
      authorId: owner.id,
      voiceUrl: AUDIO_A,
    });
    const assetTarget: Target = { type: 'asset', id: asset.id };
    const audioTarget: Target = { type: 'comment-audio', id: source.id };
    signedInAs(owner);

    expect((await post(video.id, assetTarget, 'From audio asset')).status).toBe(201);
    const throughComment = await readData<{ comments: ListedComment[]; total: number }>(
      await list(video.id, audioTarget)
    );
    expect(throughComment.comments.map((comment) => comment.content)).toEqual(['From audio asset']);
    expect(throughComment.total).toBe(1);
    expect(await db.attachmentComment.findFirstOrThrow()).toMatchObject({
      targetType: 'ASSET',
      assetId: asset.id,
      sourceCommentId: null,
    });
  });

  it('uses one discussion for duplicate image assets and transfers it when the earliest asset is deleted', async () => {
    const { owner, video, version } = await seedVersion({ visibility: 'PRIVATE' });
    const first = await createVideoAsset({
      videoId: video.id,
      billedUserId: owner.id,
      uploadedByUserId: owner.id,
      sourceUrl: IMAGE_A,
    });
    const second = await createVideoAsset({
      videoId: video.id,
      billedUserId: owner.id,
      uploadedByUserId: owner.id,
      sourceUrl: IMAGE_A,
    });
    await db.videoAsset.update({
      where: { id: first.id },
      data: { createdAt: new Date('2020-01-01T00:00:00Z') },
    });
    await db.videoAsset.update({
      where: { id: second.id },
      data: { createdAt: new Date('2021-01-01T00:00:00Z') },
    });
    const source = await createComment({
      versionId: version.id,
      authorId: owner.id,
      imageUrls: [IMAGE_A],
    });
    const imageTarget: Target = { type: 'comment-image', id: source.id, url: IMAGE_A };
    const firstTarget: Target = { type: 'asset', id: first.id };
    const secondTarget: Target = { type: 'asset', id: second.id };
    signedInAs(owner);

    expect((await post(video.id, firstTarget, 'Shared duplicate')).status).toBe(201);
    for (const target of [secondTarget, imageTarget]) {
      const data = await readData<{ comments: ListedComment[]; total: number }>(
        await list(video.id, target)
      );
      expect(data.total).toBe(1);
      expect(data.comments.map((comment) => comment.content)).toEqual(['Shared duplicate']);
    }
    expect(await db.attachmentComment.findFirstOrThrow()).toMatchObject({
      targetType: 'ASSET',
      assetId: first.id,
    });
    const before = await readData<{ counts: Record<string, number> }>(
      await callRoute(
        GET,
        apiRequest(url(video.id), { searchParams: { counts: true, versionId: version.id } }),
        { videoId: video.id }
      )
    );
    expect(before.counts).toMatchObject({
      [`asset:${first.id}`]: 1,
      [`asset:${second.id}`]: 1,
      [`comment-image:${source.id}:${IMAGE_A}`]: 1,
    });

    expect((await removeAsset(video.id, first.id)).status).toBe(200);
    expect(await db.videoAsset.findUnique({ where: { id: first.id } })).toBeNull();
    expect(await db.attachmentComment.findFirstOrThrow()).toMatchObject({
      content: 'Shared duplicate',
      targetType: 'ASSET',
      assetId: second.id,
    });
    for (const target of [secondTarget, imageTarget]) {
      const data = await readData<{ comments: ListedComment[]; total: number }>(
        await list(video.id, target)
      );
      expect(data.total).toBe(1);
      expect(data.comments.map((comment) => comment.content)).toEqual(['Shared duplicate']);
    }
  });

  it.each([
    { kind: 'IMAGE' as const, provider: 'R2_IMAGE' as const, sourceUrl: IMAGE_A },
    { kind: 'AUDIO' as const, provider: 'R2_AUDIO' as const, sourceUrl: AUDIO_A },
  ])(
    'keeps a $kind comment attachment discussion after deleting its last asset',
    async ({ kind, provider, sourceUrl }) => {
      const { owner, video, version } = await seedVersion({ visibility: 'PRIVATE' });
      const asset = await createVideoAsset({
        videoId: video.id,
        billedUserId: owner.id,
        uploadedByUserId: owner.id,
        kind,
        provider,
        sourceUrl,
      });
      const source = await createComment({
        versionId: version.id,
        authorId: owner.id,
        ...(kind === 'IMAGE' ? { imageUrls: [sourceUrl] } : { voiceUrl: sourceUrl }),
      });
      const target: Target =
        kind === 'IMAGE'
          ? { type: 'comment-image', id: source.id, url: sourceUrl }
          : { type: 'comment-audio', id: source.id };
      signedInAs(owner);

      expect((await post(video.id, target, `Keep ${kind}`)).status).toBe(201);
      expect(await db.attachmentComment.findFirstOrThrow()).toMatchObject({
        targetType: 'ASSET',
        assetId: asset.id,
      });
      expect((await removeAsset(video.id, asset.id)).status).toBe(200);
      expect(await db.videoAsset.findUnique({ where: { id: asset.id } })).toBeNull();
      expect(await db.attachmentComment.findFirstOrThrow()).toMatchObject({
        content: `Keep ${kind}`,
        targetType: kind === 'IMAGE' ? 'COMMENT_IMAGE' : 'COMMENT_AUDIO',
        assetId: null,
        sourceCommentId: source.id,
        sourceUrl: kind === 'IMAGE' ? sourceUrl : null,
      });
      const data = await readData<{ comments: ListedComment[]; total: number }>(
        await list(video.id, target)
      );
      expect(data.total).toBe(1);
      expect(data.comments.map((comment) => comment.content)).toEqual([`Keep ${kind}`]);
    }
  );

  it('refuses a URL that is not attached to the source comment', async () => {
    const { owner, video, version } = await seedVersion({ visibility: 'PRIVATE' });
    const source = await createComment({
      versionId: version.id,
      authorId: owner.id,
      imageUrls: [IMAGE_A],
    });
    signedInAs(owner);

    expect(
      (await post(video.id, { type: 'comment-image', id: source.id, url: IMAGE_B }, 'Wrong image'))
        .status
    ).toBe(404);
    expect(await db.attachmentComment.count()).toBe(0);
  });

  it('discusses a voice attachment and a legacy image without image rows', async () => {
    const { owner, video, version } = await seedVersion({ visibility: 'PRIVATE' });
    const source = await createComment({
      versionId: version.id,
      authorId: owner.id,
      voiceUrl: AUDIO_A,
    });
    const legacy = await createComment({ versionId: version.id, authorId: owner.id });
    await db.comment.update({ where: { id: legacy.id }, data: { imageUrl: IMAGE_C } });
    signedInAs(owner);

    expect(
      (await post(video.id, { type: 'comment-audio', id: source.id }, 'Voice note')).status
    ).toBe(201);
    expect(
      (await post(video.id, { type: 'comment-image', id: legacy.id, url: IMAGE_C }, 'Legacy image'))
        .status
    ).toBe(201);
    expect(
      await db.attachmentComment.count({
        where: { sourceCommentId: source.id, targetType: 'COMMENT_AUDIO' },
      })
    ).toBe(1);
    expect(
      await db.attachmentComment.count({
        where: { sourceCommentId: legacy.id, sourceUrl: IMAGE_C },
      })
    ).toBe(1);
  });

  it('counts assets and attachments on replies for one version only', async () => {
    const { owner, video, version } = await seedVersion({ visibility: 'PRIVATE' });
    const asset = await createVideoAsset({ videoId: video.id, billedUserId: owner.id });
    const parent = await createComment({ versionId: version.id, authorId: owner.id });
    const reply = await createComment({
      versionId: version.id,
      authorId: owner.id,
      parentId: parent.id,
      imageUrls: [IMAGE_A],
      voiceUrl: AUDIO_A,
    });
    const secondVersion = await createVersion({ videoParentId: video.id, versionNumber: 2 });
    const later = await createComment({
      versionId: secondVersion.id,
      authorId: owner.id,
      imageUrls: [IMAGE_B],
    });
    signedInAs(owner);

    expect((await post(video.id, { type: 'asset', id: asset.id }, 'Asset')).status).toBe(201);
    expect(
      (await post(video.id, { type: 'comment-image', id: reply.id, url: IMAGE_A }, 'Reply image'))
        .status
    ).toBe(201);
    expect(
      (await post(video.id, { type: 'comment-audio', id: reply.id }, 'Reply voice')).status
    ).toBe(201);
    expect(
      (await post(video.id, { type: 'comment-image', id: later.id, url: IMAGE_B }, 'Later version'))
        .status
    ).toBe(201);

    const response = await callRoute(
      GET,
      apiRequest(url(video.id), { searchParams: { counts: true, versionId: version.id } }),
      { videoId: video.id }
    );
    expect(response.status).toBe(200);
    const data = await readData<{ counts: Record<string, number> }>(response);
    expect(data.counts).toMatchObject({
      [`asset:${asset.id}`]: 1,
      [`comment-image:${reply.id}:${IMAGE_A}`]: 1,
      [`comment-audio:${reply.id}`]: 1,
    });
    expect(data.counts[`comment-image:${later.id}:${IMAGE_B}`]).toBeUndefined();
  });

  it('cascades when an asset or source comment is deleted', async () => {
    const { owner, video, version } = await seedVersion({ visibility: 'PRIVATE' });
    const asset = await createVideoAsset({ videoId: video.id, billedUserId: owner.id });
    const source = await createComment({
      versionId: version.id,
      authorId: owner.id,
      imageUrls: [IMAGE_A],
    });
    signedInAs(owner);
    expect((await post(video.id, { type: 'asset', id: asset.id }, 'Asset thread')).status).toBe(
      201
    );
    expect(
      (await post(video.id, { type: 'comment-image', id: source.id, url: IMAGE_A }, 'Image thread'))
        .status
    ).toBe(201);
    expect(await db.attachmentComment.count()).toBe(2);

    await db.videoAsset.delete({ where: { id: asset.id } });
    expect(await db.attachmentComment.count({ where: { assetId: asset.id } })).toBe(0);
    expect(await db.attachmentComment.count({ where: { sourceCommentId: source.id } })).toBe(1);
    await db.comment.delete({ where: { id: source.id } });
    expect(await db.attachmentComment.count()).toBe(0);
  });

  it('removes discussion for a detached image while preserving the remaining image discussion', async () => {
    const { owner, video, version } = await seedVersion({ visibility: 'PRIVATE' });
    const source = await createComment({
      versionId: version.id,
      authorId: owner.id,
      imageUrls: [IMAGE_A, IMAGE_B],
    });
    signedInAs(owner);
    expect(
      (
        await post(
          video.id,
          { type: 'comment-image', id: source.id, url: IMAGE_A },
          'Remove with image'
        )
      ).status
    ).toBe(201);
    expect(
      (
        await post(
          video.id,
          { type: 'comment-image', id: source.id, url: IMAGE_B },
          'Keep with image'
        )
      ).status
    ).toBe(201);

    const response = await callRoute(
      patchSourceComment,
      apiRequest(`/api/comments/${source.id}`, { method: 'PATCH', body: { imageUrls: [IMAGE_B] } }),
      { commentId: source.id }
    );
    expect(response.status).toBe(200);
    expect(
      await db.commentImage.findMany({ where: { commentId: source.id }, select: { url: true } })
    ).toEqual([{ url: IMAGE_B }]);
    expect(
      await db.attachmentComment.count({
        where: { sourceCommentId: source.id, sourceUrl: IMAGE_A },
      })
    ).toBe(0);
    expect(
      await db.attachmentComment.count({
        where: { sourceCommentId: source.id, sourceUrl: IMAGE_B },
      })
    ).toBe(1);
  });
});
