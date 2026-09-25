import { db } from '@/lib/db';
import { test, expect } from './fixtures';

test('drawing deltas, legacy snapshots and resync agree through the real gateway', async ({
  page,
  seed,
  seededUser,
}) => {
  const fixture = await seed.version(seededUser);
  await db.videoVersion.update({
    where: { id: fixture.versionId },
    data: { providerId: 'r2', originalUrl: '/api/upload/video/protocol.mp4' },
  });
  await page.goto('/dashboard');
  const result = await page.evaluate(
    async ({ videoId, versionId }) => {
      type Message = { type: string; [key: string]: any };
      type Peer = { socket: WebSocket; messages: Message[]; participantId: string };
      const peers: Peer[] = [];
      const until = async (predicate: () => boolean) => {
        const deadline = Date.now() + 5000;
        while (!predicate()) {
          if (Date.now() > deadline) throw new Error('Protocol observation timed out');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      const connect = async (capable: boolean) => {
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
          peer.socket.send(
            JSON.stringify({
              type: 'auth',
              ticket: data.ticket,
              ...(capable ? { capabilities: ['stroke-delta'] } : {}),
            })
          );
        peer.socket.onmessage = (event) => peer.messages.push(JSON.parse(event.data));
        await until(() => peer.messages.some((m) => m.type === 'snapshot'));
        return peer;
      };
      const send = (peer: Peer, value: object) => peer.socket.send(JSON.stringify(value));
      const lastSnapshot = (peer: Peer) =>
        peer.messages.filter((m) => m.type === 'snapshot').at(-1)!.snapshot;
      try {
        const drawer = await connect(true);
        const legacy = await connect(false);
        const follower = await connect(true);
        await until(() => lastSnapshot(drawer).participants.length === 3);
        const canvasEpoch = lastSnapshot(drawer).canvasEpoch;
        const marks = { legacy: legacy.messages.length, follower: follower.messages.length };
        const stroke = {
          id: 'wire-stroke',
          color: '#00ff00',
          width: 4,
          points: [
            { x: 0.1, y: 0.1 },
            { x: 0.2, y: 0.2 },
          ],
        };
        send(drawer, { type: 'stroke', canvasEpoch, stroke });
        await until(() => follower.messages.some((m) => m.type === 'stroke-delta'));
        await until(() =>
          legacy.messages
            .slice(marks.legacy)
            .some((m) => m.snapshot?.strokes[0]?.points.length === 2)
        );
        const first = follower.messages.find((m) => m.type === 'stroke-delta')!;
        stroke.points.push({ x: 0.3, y: 0.4 });
        send(drawer, { type: 'stroke', canvasEpoch, stroke });
        await until(() => follower.messages.filter((m) => m.type === 'stroke-delta').length === 2);
        await until(() => lastSnapshot(legacy).strokes[0]?.points.length === 3);
        const appended = follower.messages.filter((m) => m.type === 'stroke-delta')[1];
        const incrementalSnapshots = follower.messages
          .slice(marks.follower)
          .filter((m) => m.type === 'snapshot').length;
        const recoveryMark = follower.messages.length;
        send(follower, { type: 'resync', revision: -1 });
        await until(() => follower.messages.slice(recoveryMark).some((m) => m.type === 'snapshot'));
        const recovered = lastSnapshot(follower);
        const late = await connect(true);
        const lateStroke = lastSnapshot(late).strokes[0];
        send(drawer, { type: 'undo', canvasEpoch });
        await until(() => follower.messages.some((m) => m.type === 'stroke-remove'));
        await until(() => lastSnapshot(legacy).strokes.length === 0);
        const removed = follower.messages.find((m) => m.type === 'stroke-remove')!;
        send(drawer, { type: 'stroke', canvasEpoch, stroke: { ...stroke, id: 'clear-me' } });
        await until(() => lastSnapshot(legacy).strokes[0]?.id === 'clear-me');
        const clearMark = follower.messages.length;
        send(drawer, { type: 'clear', canvasEpoch });
        await until(() => follower.messages.slice(clearMark).some((m) => m.type === 'snapshot'));
        const cleared = lastSnapshot(follower);
        return {
          first,
          appended,
          incrementalSnapshots,
          recovered: recovered.strokes,
          lateStroke,
          removedId: removed.strokeId,
          cleared: { strokes: cleared.strokes, canvasEpoch: cleared.canvasEpoch },
          initialCanvasEpoch: canvasEpoch,
          drawerId: drawer.participantId,
          errors: peers.flatMap((peer) => peer.messages.filter((m) => m.type === 'error')),
        };
      } finally {
        for (const peer of peers)
          if (peer.socket.readyState === WebSocket.OPEN) send(peer, { type: 'leave' });
        await until(() => peers.every((peer) => peer.socket.readyState === WebSocket.CLOSED));
      }
    },
    { videoId: fixture.videoId, versionId: fixture.versionId }
  );
  expect(result.errors).toEqual([]);
  expect(result.incrementalSnapshots).toBe(0);
  expect(result.first.fromIndex).toBe(0);
  expect(result.first.points).toEqual([
    { x: 0.1, y: 0.1 },
    { x: 0.2, y: 0.2 },
  ]);
  expect(result.first.stroke).toEqual({
    id: 'wire-stroke',
    participantId: result.drawerId,
    color: '#00ff00',
    width: 4,
  });
  expect(result.appended.fromIndex).toBe(2);
  expect(result.appended.points).toEqual([{ x: 0.3, y: 0.4 }]);
  expect(result.appended.baseRevision).toBe(result.first.revision);
  expect(result.appended.revision).toBe(result.first.revision + 1);
  expect(result.recovered[0].points).toHaveLength(3);
  expect(result.lateStroke).toEqual(result.recovered[0]);
  expect(result.removedId).toBe('wire-stroke');
  expect(result.cleared.strokes).toEqual([]);
  expect(result.cleared.canvasEpoch).toBe(result.initialCanvasEpoch + 1);
});
