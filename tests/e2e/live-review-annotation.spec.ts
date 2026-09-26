import { db } from '@/lib/db';
import { test, expect } from './fixtures';

test('saved comments share canonical annotation previews through the gateway', async ({
  page,
  seed,
  seededUser,
}) => {
  const version = await seed.version(seededUser);
  const otherVersion = await seed.version(seededUser);
  await db.videoVersion.update({
    where: { id: version.versionId },
    data: { providerId: 'r2', originalUrl: '/api/upload/video/annotation.mp4' },
  });
  const strokes = [
    {
      points: [
        { x: 0.15, y: 0.3 },
        { x: 0.4, y: 0.7 },
      ],
      color: '#ff3300',
      width: 3,
    },
  ];
  const annotated = await db.comment.create({
    data: {
      versionId: version.versionId,
      authorId: seededUser.id,
      timestamp: 0,
      content: null,
      annotationData: JSON.stringify(strokes),
    },
  });
  const plain = await seed.comment({
    versionId: version.versionId,
    authorId: seededUser.id,
    content: 'Plain comment',
    timestamp: 4,
  });
  const wrongVersion = await seed.comment({
    versionId: otherVersion.versionId,
    authorId: seededUser.id,
    content: 'Other version',
    timestamp: 5,
  });
  const deleted = await seed.comment({
    versionId: version.versionId,
    authorId: seededUser.id,
    content: 'Deleted',
    timestamp: 6,
  });
  await db.comment.delete({ where: { id: deleted.id } });
  const invalid = await db.comment.create({
    data: {
      versionId: version.versionId,
      authorId: seededUser.id,
      timestamp: 7,
      content: 'Invalid saved drawing',
      annotationData: '{"points":"bad"}',
    },
  });

  await page.goto('/dashboard');
  const result = await page.evaluate(
    async ({ videoId, versionId, annotatedId, plainId, wrongVersionId, deletedId, invalidId }) => {
      type Message = { type: string; [key: string]: any };
      type Peer = { socket: WebSocket; messages: Message[]; participantId: string };
      const peers: Peer[] = [];
      const until = async (predicate: () => boolean) => {
        const deadline = Date.now() + 8000;
        while (!predicate()) {
          if (Date.now() > deadline) throw new Error('Annotation protocol observation timed out');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      const connect = async () => {
        const response = await fetch(`/api/videos/${videoId}/live-review`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: peers.length ? 'join' : 'start', versionId }),
        });
        if (!response.ok) throw new Error(`Room HTTP ${response.status}`);
        const { data } = await response.json();
        const peer: Peer = {
          socket: new WebSocket(data.websocketUrl),
          messages: [],
          participantId: data.participantId,
        };
        peers.push(peer);
        peer.socket.onopen = () =>
          peer.socket.send(JSON.stringify({ type: 'auth', ticket: data.ticket }));
        peer.socket.onmessage = (event) => peer.messages.push(JSON.parse(event.data));
        await until(() => peer.messages.some((message) => message.type === 'snapshot'));
        return peer;
      };
      const send = (peer: Peer, message: object) => peer.socket.send(JSON.stringify(message));
      const snapshot = (peer: Peer) =>
        peer.messages.filter((message) => message.type === 'snapshot').at(-1)!.snapshot;
      const playback = (peer: Peer, commandId: string, position: number, extra: object = {}) =>
        send(peer, {
          type: 'playback',
          commandId,
          controlEpoch: snapshot(peer).controlEpoch,
          position,
          playing: false,
          rate: 1,
          ...extra,
        });
      const nextSnapshot = async (peer: Peer, revision: number) => {
        await until(() => snapshot(peer).revision > revision);
        return snapshot(peer);
      };
      const rejected = async (peer: Peer, command: object) => {
        const errors = peer.messages.filter((message) => message.type === 'error').length;
        const before = snapshot(peer);
        send(peer, command);
        await until(
          () => peer.messages.filter((message) => message.type === 'error').length > errors
        );
        const lastError = peer.messages.filter((message) => message.type === 'error').at(-1)!.code;
        return { code: lastError, unchanged: snapshot(peer).revision === before.revision };
      };
      try {
        const presenter = await connect();
        const follower = await connect();
        await until(() => snapshot(presenter).participants.length === 2);
        const start = snapshot(presenter);
        send(presenter, {
          type: 'stroke',
          canvasEpoch: start.canvasEpoch,
          stroke: {
            id: 'temporary-mark',
            color: '#008800',
            width: 2,
            points: [
              { x: 0.1, y: 0.1 },
              { x: 0.2, y: 0.2 },
            ],
          },
        });
        await until(() => snapshot(presenter).strokes.length === 1);
        const drawn = snapshot(presenter);
        playback(presenter, 'select-zero', 9, {
          commentId: annotatedId,
          playing: false,
          annotation: { commentId: plainId, strokes: [] },
        });
        const selected = await nextSnapshot(presenter, drawn.revision);
        await until(() => snapshot(follower).revision === selected.revision);
        const peerSelected = snapshot(follower);
        const late = await connect();
        const lateSelected = snapshot(late);
        const resyncRevision = late.messages.length;
        send(late, { type: 'resync', revision: -1 });
        await until(() => late.messages.length > resyncRevision);
        const resynced = snapshot(late);

        const beforeEcho = snapshot(presenter).revision;
        playback(presenter, 'same-position-echo', 0);
        const echoed = await nextSnapshot(presenter, beforeEcho);
        playback(presenter, 'play', 0, { playing: true });
        const playing = await nextSnapshot(presenter, echoed.revision);
        playback(presenter, 'select-again', 8, { commentId: annotatedId, playing: true });
        const reselected = await nextSnapshot(presenter, playing.revision);
        playback(presenter, 'frame-seek', 1 / 30);
        const frameSeek = await nextSnapshot(presenter, reselected.revision);
        playback(presenter, 'select-third', 8, { commentId: annotatedId });
        const third = await nextSnapshot(presenter, frameSeek.revision);
        playback(presenter, 'select-plain', 8, { commentId: plainId, playing: true });
        const plainSelected = await nextSnapshot(presenter, third.revision);
        playback(presenter, 'select-fourth', 8, { commentId: annotatedId });
        const fourth = await nextSnapshot(presenter, plainSelected.revision);
        send(presenter, { type: 'clear', canvasEpoch: fourth.canvasEpoch });
        const cleared = await nextSnapshot(presenter, fourth.revision);
        playback(presenter, 'select-fifth', 8, { commentId: annotatedId });
        const fifth = await nextSnapshot(presenter, cleared.revision);
        await until(() => snapshot(follower).revision === fifth.revision);

        const denied = await rejected(follower, {
          type: 'playback',
          commandId: 'follower-select',
          controlEpoch: fifth.controlEpoch,
          position: 8,
          playing: false,
          rate: 1,
          commentId: plainId,
        });
        const stale = await rejected(presenter, {
          type: 'playback',
          commandId: 'stale-select',
          controlEpoch: fifth.controlEpoch - 1,
          position: 8,
          playing: false,
          rate: 1,
          commentId: plainId,
        });
        const crossVersion = await rejected(presenter, {
          type: 'playback',
          commandId: 'wrong-version',
          controlEpoch: fifth.controlEpoch,
          position: 8,
          playing: false,
          rate: 1,
          commentId: wrongVersionId,
        });
        const removed = await rejected(presenter, {
          type: 'playback',
          commandId: 'deleted-comment',
          controlEpoch: fifth.controlEpoch,
          position: 8,
          playing: false,
          rate: 1,
          commentId: deletedId,
        });
        const malformed = await rejected(presenter, {
          type: 'playback',
          commandId: 'invalid-annotation',
          controlEpoch: fifth.controlEpoch,
          position: 8,
          playing: false,
          rate: 1,
          commentId: invalidId,
        });
        return {
          selected,
          peerSelected,
          lateSelected,
          resynced,
          echoed,
          playing,
          frameSeek,
          reselected,
          plainSelected,
          cleared,
          fifth,
          denied,
          stale,
          crossVersion,
          removed,
          malformed,
          afterRejected: snapshot(presenter),
        };
      } finally {
        for (const peer of peers)
          if (peer.socket.readyState === WebSocket.OPEN) send(peer, { type: 'leave' });
        await until(() => peers.every((peer) => peer.socket.readyState === WebSocket.CLOSED));
      }
    },
    {
      videoId: version.videoId,
      versionId: version.versionId,
      annotatedId: annotated.id,
      plainId: plain.id,
      wrongVersionId: wrongVersion.id,
      deletedId: deleted.id,
      invalidId: invalid.id,
    }
  );
  const preview = { commentId: annotated.id, strokes };
  expect(result.selected.playback).toMatchObject({ position: 0, playing: false });
  expect(result.selected.annotation).toEqual(preview);
  expect(result.selected.strokes).toEqual([]);
  expect(result.selected.canvasEpoch).toBeGreaterThan(0);
  expect(result.peerSelected.annotation).toEqual(preview);
  expect(result.lateSelected.annotation).toEqual(preview);
  expect(result.resynced.annotation).toEqual(preview);
  expect(result.echoed.annotation).toEqual(preview);
  expect(result.playing.annotation).toBeNull();
  expect(result.frameSeek.annotation).toBeNull();
  expect(result.reselected.playback).toMatchObject({ position: 0, playing: false });
  expect(result.plainSelected).toMatchObject({
    annotation: null,
    playback: { position: 4, playing: true },
  });
  expect(result.cleared.annotation).toBeNull();
  expect([
    result.denied,
    result.stale,
    result.crossVersion,
    result.removed,
    result.malformed,
  ]).toEqual([
    { code: 'NOT_PRESENTER', unchanged: true },
    { code: 'NOT_PRESENTER', unchanged: true },
    { code: 'INVALID_COMMENT', unchanged: true },
    { code: 'INVALID_COMMENT', unchanged: true },
    { code: 'INVALID_COMMENT', unchanged: true },
  ]);
  expect(result.fifth.annotation).toEqual(preview);
  expect(result.afterRejected.annotation).toEqual(preview);
  expect(result.afterRejected.revision).toBe(result.fifth.revision);
  const persisted = await db.liveReviewSession.findUniqueOrThrow({
    where: { id: result.fifth.sessionId },
  });
  expect(persisted.position).toBe(0);
});
