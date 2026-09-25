import type { Page } from '@playwright/test';
import { SharePermission } from '@prisma/client';
import { db } from '@/lib/db';
import type {
  LiveClientMessage,
  LiveServerMessage,
  LiveSnapshot,
} from '@/lib/live-review/protocol';
import { test, expect } from './fixtures';

type Probe = {
  socket: WebSocket;
  messages: LiveServerMessage[];
  closeCode: number | null;
  heartbeat: number;
};
type ProbeWindow = Window & { liveReviewPermissionSockets?: Record<string, Probe> };

async function connectRoomSocket(
  page: Page,
  key: string,
  videoId: string,
  versionId: string,
  action: 'start' | 'join',
  guestName?: string
): Promise<string> {
  return page.evaluate(
    async ({ key, videoId, versionId, action, guestName }) => {
      const response = await fetch(`/api/videos/${videoId}/live-review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, versionId, guestName }),
      });
      if (!response.ok) throw new Error(`Room ${action} returned ${response.status}`);
      const { data } = (await response.json()) as {
        data: { participantId: string; ticket: string; websocketUrl: string };
      };
      const browser = window as ProbeWindow;
      const sockets = (browser.liveReviewPermissionSockets ??= {});
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(data.websocketUrl);
        const probe: Probe = { socket, messages: [], closeCode: null, heartbeat: 0 };
        sockets[key] = probe;
        const timeout = window.setTimeout(
          () => reject(new Error('Room authentication timed out')),
          8000
        );
        socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', ticket: data.ticket }));
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as LiveServerMessage;
          probe.messages.push(message);
          if (message.type === 'snapshot' && probe.heartbeat === 0) {
            window.clearTimeout(timeout);
            probe.heartbeat = window.setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'ping', clientTime: Date.now() }));
              }
            }, 5000);
            resolve();
          }
        };
        socket.onclose = (event) => {
          probe.closeCode = event.code;
          window.clearTimeout(timeout);
          if (probe.heartbeat) window.clearInterval(probe.heartbeat);
          if (probe.messages.every((message) => message.type !== 'snapshot')) {
            reject(new Error(`Room socket closed before authentication: ${event.code}`));
          }
        };
        socket.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error('Room socket failed'));
        };
      });
      return data.participantId;
    },
    { key, videoId, versionId, action, guestName }
  );
}

async function roomMessages(page: Page, key: string): Promise<LiveServerMessage[]> {
  return page.evaluate((key) => {
    const probe = (window as ProbeWindow).liveReviewPermissionSockets?.[key];
    if (!probe) throw new Error(`Missing room socket ${key}`);
    return probe.messages;
  }, key);
}

async function latestSnapshot(page: Page, key: string): Promise<LiveSnapshot> {
  const snapshots = (await roomMessages(page, key)).filter(
    (message): message is Extract<LiveServerMessage, { type: 'snapshot' }> =>
      message.type === 'snapshot'
  );
  const latest = snapshots.at(-1)?.snapshot;
  if (!latest) throw new Error(`No room snapshot for ${key}`);
  return latest;
}

async function errorCount(page: Page, key: string, code: string): Promise<number> {
  return (await roomMessages(page, key)).filter(
    (message) => message.type === 'error' && message.code === code
  ).length;
}

async function sendRoomMessage(page: Page, key: string, message: LiveClientMessage): Promise<void> {
  await page.evaluate(
    ({ key, message }) => {
      const probe = (window as ProbeWindow).liveReviewPermissionSockets?.[key];
      if (!probe || probe.socket.readyState !== WebSocket.OPEN)
        throw new Error('Room socket is closed');
      probe.socket.send(JSON.stringify(message));
    },
    { key, message }
  );
}

async function closeRoomSocket(page: Page, key: string): Promise<void> {
  if (page.isClosed()) return;
  await page.evaluate((key) => {
    const probe = (window as ProbeWindow).liveReviewPermissionSockets?.[key];
    if (!probe) return;
    if (probe.heartbeat) window.clearInterval(probe.heartbeat);
    probe.socket.close();
  }, key);
}

test.setTimeout(120_000);

test('live room enforces guest permissions and socket command controls', async ({
  page,
  browser,
  seed,
  seededUser,
}) => {
  const seeded = await seed.version(seededUser, { title: 'Live review permission video' });
  await db.videoVersion.update({
    where: { id: seeded.versionId },
    data: { providerId: 'r2', videoId: `videos/${seeded.versionId}.mp4`, duration: 12 },
  });
  const link = await seed.shareLink({ projectId: seeded.project.id, videoId: seeded.videoId });
  const guestContext = await browser.newContext({ storageState: undefined });
  try {
    await page.goto('/dashboard');
    const ownerId = await connectRoomSocket(
      page,
      'owner',
      seeded.videoId,
      seeded.versionId,
      'start'
    );
    const guestPage = await guestContext.newPage();
    await guestPage.goto(`/watch/${seeded.videoId}?shareToken=${link.token}`);
    await expect(guestPage).toHaveURL(new RegExp(`/watch/${seeded.videoId}$`));
    const guestId = await connectRoomSocket(
      guestPage,
      'guest',
      seeded.videoId,
      seeded.versionId,
      'join',
      'View guest'
    );
    await expect
      .poll(async () => (await latestSnapshot(page, 'owner')).participants.length)
      .toBe(2);
    const joined = await latestSnapshot(page, 'owner');
    expect(joined.presenterId).toBe(ownerId);
    expect(joined.participants.find((person) => person.id === guestId)?.canComment).toBe(false);

    const deniedStroke = {
      id: 'view-guest-denied',
      points: [
        { x: 0.1, y: 0.2 },
        { x: 0.3, y: 0.4 },
      ],
      color: '#ff0000',
      width: 2,
    };
    await sendRoomMessage(guestPage, 'guest', {
      type: 'stroke',
      canvasEpoch: joined.canvasEpoch,
      stroke: deniedStroke,
    });
    await expect.poll(() => errorCount(guestPage, 'guest', 'FORBIDDEN')).toBe(1);
    expect((await latestSnapshot(page, 'owner')).strokes).toHaveLength(0);

    await sendRoomMessage(page, 'owner', {
      type: 'transfer',
      participantId: guestId,
      controlEpoch: joined.controlEpoch,
    });
    await expect.poll(() => errorCount(page, 'owner', 'FORBIDDEN')).toBe(1);
    const refusedTransfer = await db.liveReviewSession.findFirstOrThrow({
      where: { videoId: seeded.videoId, status: 'active' },
    });
    expect(refusedTransfer.presenterId).toBe(ownerId);
    expect((await latestSnapshot(page, 'owner')).presenterId).toBe(ownerId);

    await sendRoomMessage(page, 'owner', {
      type: 'playback',
      commandId: 'owner-play',
      controlEpoch: joined.controlEpoch,
      position: 1,
      playing: true,
      rate: 4,
    });
    await expect
      .poll(
        async () =>
          (
            await db.liveReviewSession.findUniqueOrThrow({
              where: { id: refusedTransfer.id },
            })
          ).playing
      )
      .toBe(true);
    await expect
      .poll(async () => (await latestSnapshot(guestPage, 'guest')).playback.playing)
      .toBe(true);
    await sendRoomMessage(page, 'owner', { type: 'status', status: 'blocked' });
    await expect
      .poll(
        async () =>
          (
            await db.liveReviewSession.findUniqueOrThrow({
              where: { id: refusedTransfer.id },
            })
          ).playing
      )
      .toBe(false);
    await expect
      .poll(async () => (await latestSnapshot(guestPage, 'guest')).playback.playing)
      .toBe(false);
    await sendRoomMessage(page, 'owner', {
      type: 'playback',
      commandId: 'owner-rate-16',
      controlEpoch: joined.controlEpoch,
      position: 1,
      playing: false,
      rate: 16,
    });
    await expect
      .poll(
        async () =>
          (
            await db.liveReviewSession.findUniqueOrThrow({
              where: { id: refusedTransfer.id },
            })
          ).rate
      )
      .toBe(16);
    await sendRoomMessage(page, 'owner', {
      type: 'playback',
      commandId: 'owner-rate-1',
      controlEpoch: joined.controlEpoch,
      position: 1,
      playing: false,
      rate: 1,
    });
    await expect
      .poll(
        async () =>
          (
            await db.liveReviewSession.findUniqueOrThrow({
              where: { id: refusedTransfer.id },
            })
          ).rate
      )
      .toBe(1);

    await db.shareLink.update({
      where: { id: link.id },
      data: { permission: SharePermission.COMMENT },
    });
    const commentSnapshot = await latestSnapshot(guestPage, 'guest');
    const acceptedStroke = {
      id: 'comment-guest-accepted',
      points: [
        { x: 0.2, y: 0.3 },
        { x: 0.4, y: 0.5 },
      ],
      color: '#00ff00',
      width: 2,
    };
    await sendRoomMessage(guestPage, 'guest', {
      type: 'stroke',
      canvasEpoch: commentSnapshot.canvasEpoch,
      stroke: acceptedStroke,
    });
    await expect
      .poll(async () => (await latestSnapshot(page, 'owner')).strokes.map((stroke) => stroke.id))
      .toContain(acceptedStroke.id);
    expect(
      (await latestSnapshot(page, 'owner')).strokes.find(
        (stroke) => stroke.id === acceptedStroke.id
      )?.participantId
    ).toBe(guestId);

    const beforeTransfer = await latestSnapshot(page, 'owner');
    await sendRoomMessage(page, 'owner', {
      type: 'transfer',
      participantId: guestId,
      controlEpoch: beforeTransfer.controlEpoch,
    });
    await expect
      .poll(async () => (await latestSnapshot(guestPage, 'guest')).presenterId)
      .toBe(guestId);
    const transferred = await db.liveReviewSession.findUniqueOrThrow({
      where: { id: refusedTransfer.id },
    });
    expect(transferred.controlEpoch).toBe(beforeTransfer.controlEpoch + 1);

    await sendRoomMessage(page, 'owner', {
      type: 'playback',
      commandId: 'former-presenter-stale-epoch',
      controlEpoch: beforeTransfer.controlEpoch,
      position: 7,
      playing: false,
      rate: 1,
    });
    await expect.poll(() => errorCount(page, 'owner', 'NOT_PRESENTER')).toBe(1);
    const afterStaleCommand = await db.liveReviewSession.findUniqueOrThrow({
      where: { id: refusedTransfer.id },
    });
    expect(afterStaleCommand.presenterId).toBe(guestId);
    expect(afterStaleCommand.position).toBe(transferred.position);
    expect(afterStaleCommand.revision).toBe(transferred.revision);

    await sendRoomMessage(guestPage, 'guest', {
      type: 'playback',
      commandId: 'current-presenter-stale-epoch',
      controlEpoch: beforeTransfer.controlEpoch,
      position: 8,
      playing: false,
      rate: 1,
    });
    await expect.poll(() => errorCount(guestPage, 'guest', 'NOT_PRESENTER')).toBe(1);
    const afterStaleEpoch = await db.liveReviewSession.findUniqueOrThrow({
      where: { id: refusedTransfer.id },
    });
    expect(afterStaleEpoch.position).toBe(transferred.position);
    expect(afterStaleEpoch.revision).toBe(transferred.revision);

    await sendRoomMessage(guestPage, 'guest', {
      type: 'playback',
      commandId: 'guest-seek-once',
      controlEpoch: transferred.controlEpoch,
      position: 2,
      playing: false,
      rate: 1,
    });
    await expect
      .poll(
        async () =>
          (await db.liveReviewSession.findUniqueOrThrow({ where: { id: refusedTransfer.id } }))
            .position
      )
      .toBe(2);
    const afterFirstSeek = await db.liveReviewSession.findUniqueOrThrow({
      where: { id: refusedTransfer.id },
    });
    await sendRoomMessage(guestPage, 'guest', {
      type: 'playback',
      commandId: 'guest-seek-once',
      controlEpoch: transferred.controlEpoch,
      position: 4,
      playing: false,
      rate: 1,
    });
    const barrier = Date.now() + 123456;
    await sendRoomMessage(guestPage, 'guest', { type: 'ping', clientTime: barrier });
    await expect
      .poll(async () =>
        (await roomMessages(guestPage, 'guest')).some(
          (message) => message.type === 'pong' && message.clientTime === barrier
        )
      )
      .toBe(true);
    const afterDuplicate = await db.liveReviewSession.findUniqueOrThrow({
      where: { id: refusedTransfer.id },
    });
    expect(afterDuplicate.position).toBe(2);
    expect(afterDuplicate.revision).toBe(afterFirstSeek.revision);

    const afterSeekCanvasEpoch = (await latestSnapshot(guestPage, 'guest')).canvasEpoch;
    await db.shareLink.delete({ where: { id: link.id } });
    const nextStroke = {
      id: 'revoked-guest-denied',
      points: [
        { x: 0.3, y: 0.4 },
        { x: 0.5, y: 0.6 },
      ],
      color: '#0000ff',
      width: 2,
    };
    await sendRoomMessage(guestPage, 'guest', {
      type: 'stroke',
      canvasEpoch: afterSeekCanvasEpoch,
      stroke: nextStroke,
    });
    await expect
      .poll(() =>
        guestPage.evaluate(
          () => (window as ProbeWindow).liveReviewPermissionSockets?.guest.closeCode ?? null
        )
      )
      .toBeTruthy();
    const closeCode = await guestPage.evaluate(
      () => (window as ProbeWindow).liveReviewPermissionSockets?.guest.closeCode
    );
    expect([1008, 1011]).toContain(closeCode);
    const ownerAfterRevocation = await latestSnapshot(page, 'owner');
    expect(ownerAfterRevocation.strokes.map((stroke) => stroke.id)).not.toContain(nextStroke.id);

    await connectRoomSocket(page, 'flood', seeded.videoId, seeded.versionId, 'join');
    await page.evaluate(() => {
      const probe = (window as ProbeWindow).liveReviewPermissionSockets?.flood;
      if (!probe || probe.socket.readyState !== WebSocket.OPEN)
        throw new Error('Flood probe is not connected');
      for (let index = 0; index < 45; index++) {
        probe.socket.send(JSON.stringify({ type: 'ping', clientTime: index }));
      }
    });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as ProbeWindow).liveReviewPermissionSockets?.flood.closeCode ?? null
        )
      )
      .toBe(1008);
  } finally {
    await closeRoomSocket(page, 'owner');
    await closeRoomSocket(page, 'flood');
    const guestPage = guestContext.pages()[0];
    if (guestPage) await closeRoomSocket(guestPage, 'guest');
    await guestContext.close();
  }
});
