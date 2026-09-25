import { timingSafeEqual } from 'node:crypto';
import { Client } from 'pg';
import { db } from '../lib/db';
import { redeemLiveTicket } from '../lib/live-review/tickets';
import { applyLiveStroke } from '../lib/live-review/strokes';
import {
  LIVE_MAX_MESSAGE_BYTES,
  LIVE_MAX_STROKE_POINTS,
  type LiveClientMessage,
  type LiveParticipant,
  type LiveSnapshot,
  type LiveStroke,
} from '../lib/live-review/protocol';

type Permission = {
  allowed: boolean;
  canComment: boolean;
  isManager: boolean;
  sessionId: string | null;
};
type SocketData = {
  participantId: string | null;
  sessionId: string | null;
  authenticated: boolean;
  authenticating: boolean;
  openedAt: number;
  lastSeen: number;
  windowAt: number;
  messageCount: number;
  intentionalLeave: boolean;
};
type Socket = {
  data: SocketData;
  send: (value: string) => void;
  close: (code?: number, reason?: string) => void;
  getBufferedAmount?: () => number;
};
type Room = {
  snapshot: LiveSnapshot;
  sockets: Map<string, Socket>;
  queue: Promise<void>;
  pending: number;
  lastCommand: Map<string, string>;
  emptyTimer: ReturnType<typeof setTimeout> | null;
  ending: boolean;
};
declare const Bun: {
  serve: (options: {
    port: number;
    hostname: string;
    fetch: (
      request: Request,
      server: { upgrade: (request: Request, options: { data: SocketData }) => boolean }
    ) => Promise<Response | undefined> | Response | undefined;
    websocket: {
      open: (socket: Socket) => void;
      message: (socket: Socket, message: string | ArrayBuffer | Uint8Array) => void;
      close: (socket: Socket) => void;
      maxPayloadLength: number;
    };
  }) => { stop: () => void };
};

const secret = process.env.LIVE_REVIEW_SECRET;
const allowedOrigin = process.env.LIVE_REVIEW_ALLOWED_ORIGIN;
const appUrl = process.env.LIVE_REVIEW_APP_URL;
if (!secret || !allowedOrigin || !appUrl)
  throw new Error('Live review configuration is incomplete');
const port = Number(process.env.LIVE_REVIEW_PORT ?? 3101);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid live review port');
const rooms = new Map<string, Room>();
const sockets = new Set<Socket>();
const recentlyEndedRooms = new Map<string, number>();
const EMPTY_ROOM_GRACE_MS = 20_000;

function sameSecret(value: string | null): boolean {
  if (!value) return false;
  const a = Buffer.from(secret!);
  const b = Buffer.from(value);
  return a.length === b.length && timingSafeEqual(a, b);
}
function send(socket: Socket, value: unknown) {
  if ((socket.getBufferedAmount?.() ?? 0) > 256 * 1024) {
    socket.close(1013, 'Slow client');
    return;
  }
  socket.send(JSON.stringify(value));
}
function error(socket: Socket, code: string, strokeId?: string) {
  send(socket, { type: 'error', code, message: code, ...(strokeId ? { strokeId } : {}) });
}
function publish(room: Room) {
  room.snapshot.serverTime = Date.now();
  for (const socket of room.sockets.values())
    send(socket, { type: 'snapshot', snapshot: room.snapshot });
}
async function permission(participantId: string): Promise<Permission> {
  const response = await fetch(new URL('/api/internal/live-review/access', appUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-live-review-secret': secret! },
    body: JSON.stringify({ participantId }),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error('Permission check unavailable');
  const value = (await response.json()) as { data?: Permission };
  if (!value.data || typeof value.data.allowed !== 'boolean')
    throw new Error('Invalid permission response');
  return value.data;
}
async function loadRoom(sessionId: string): Promise<Room | null> {
  if (recentlyEndedRooms.has(sessionId)) return null;
  const cached = rooms.get(sessionId);
  if (cached) return cached.ending || cached.snapshot.status !== 'active' ? null : cached;
  const session = await db.liveReviewSession.findUnique({
    where: { id: sessionId },
    include: { participants: true },
  });
  if (!session || session.status !== 'active' || recentlyEndedRooms.has(sessionId)) return null;
  const loaded = rooms.get(sessionId);
  if (loaded) return loaded.ending || loaded.snapshot.status !== 'active' ? null : loaded;
  const snapshot: LiveSnapshot = {
    sessionId,
    videoId: session.videoId,
    versionId: session.versionId,
    status: 'active',
    revision: session.revision,
    controlEpoch: session.controlEpoch,
    presenterId: session.presenterId,
    playback: {
      position: session.position,
      playing: false,
      rate: session.rate,
      updatedAt: session.playbackAt.getTime(),
    },
    participants: [],
    strokes: [],
    canvasEpoch: 0,
    serverTime: Date.now(),
  };
  const room: Room = {
    snapshot,
    sockets: new Map(),
    queue: Promise.resolve(),
    pending: 0,
    lastCommand: new Map(),
    emptyTimer: null,
    ending: false,
  };
  rooms.set(sessionId, room);
  return room;
}
function cancelEmptyClose(room: Room) {
  if (room.emptyTimer) clearTimeout(room.emptyTimer);
  room.emptyTimer = null;
}
function hasPendingJoin(room: Room): boolean {
  return [...sockets].some(
    (socket) =>
      socket.data.authenticating &&
      !socket.data.authenticated &&
      (!socket.data.sessionId || socket.data.sessionId === room.snapshot.sessionId)
  );
}
async function endRoom(room: Room) {
  if (room.ending || room.snapshot.status !== 'active') return;
  room.ending = true;
  cancelEmptyClose(room);
  const sessionId = room.snapshot.sessionId;
  const now = new Date();
  try {
    await db.liveReviewSession.updateMany({
      where: { id: sessionId, status: 'active' },
      data: { status: 'ended', playing: false, endedAt: now, revision: room.snapshot.revision + 1 },
    });
  } catch (cause) {
    room.ending = false;
    if (!room.sockets.size) scheduleEmptyClose(room, false);
    throw cause;
  }
  recentlyEndedRooms.set(sessionId, Date.now());
  room.snapshot.status = 'ended';
  room.snapshot.playback.playing = false;
  room.snapshot.revision++;
  publish(room);
  for (const client of room.sockets.values()) client.close(1000, 'Room ended');
  rooms.delete(sessionId);
}
function scheduleEmptyClose(room: Room, intentional: boolean) {
  if (room.sockets.size || room.ending || room.snapshot.status !== 'active') return;
  cancelEmptyClose(room);
  if (intentional && !hasPendingJoin(room)) {
    enqueue(room, async () => {
      if (!room.sockets.size && !hasPendingJoin(room)) await endRoom(room);
      else if (!room.sockets.size) scheduleEmptyClose(room, false);
    });
    return;
  }
  room.emptyTimer = setTimeout(() => {
    room.emptyTimer = null;
    enqueue(room, async () => {
      if (room.sockets.size || room.ending || room.snapshot.status !== 'active') return;
      if (hasPendingJoin(room)) scheduleEmptyClose(room, false);
      else await endRoom(room);
    });
  }, EMPTY_ROOM_GRACE_MS);
}
function enqueue(room: Room, task: () => Promise<void>, source?: Socket) {
  if (source && room.pending >= 100) {
    source?.close(1013, 'Room busy');
    return;
  }
  room.pending++;
  room.queue = room.queue
    .then(task)
    .catch((cause) => {
      console.error(
        'Live review operation failed',
        cause instanceof Error ? cause.name : 'unknown'
      );
    })
    .finally(() => {
      room.pending--;
    });
}
function participantRow(room: Room, id: string) {
  return room.snapshot.participants.find((item) => item.id === id);
}
async function authSocket(socket: Socket, ticket: string) {
  const claim = await redeemLiveTicket(ticket);
  if (!claim) {
    socket.close(1008, 'Invalid ticket');
    return;
  }
  socket.data.sessionId = claim.sessionId;
  const rights = await permission(claim.participantId).catch(() => null);
  if (!rights?.allowed || rights.sessionId !== claim.sessionId) {
    socket.close(1008, 'Access denied');
    return;
  }
  const room = await loadRoom(claim.sessionId);
  if (!room) {
    socket.close(1008, 'Room ended');
    return;
  }
  const participant = await db.liveReviewParticipant.findUnique({
    where: { id: claim.participantId },
  });
  if (!sockets.has(socket)) return;
  if (room.ending || room.snapshot.status !== 'active' || rooms.get(claim.sessionId) !== room) {
    socket.close(1008, 'Room ended');
    return;
  }
  if (!participant || participant.sessionId !== claim.sessionId) {
    socket.close(1008, 'Access denied');
    return;
  }
  const previous = room.sockets.get(participant.id);
  if (!previous && room.sockets.size >= 10) {
    socket.close(1008, 'Room full');
    return;
  }
  cancelEmptyClose(room);
  room.sockets.set(participant.id, socket);
  if (previous) previous.close(1000, 'Reconnected');
  socket.data = {
    ...socket.data,
    authenticated: true,
    sessionId: claim.sessionId,
    participantId: participant.id,
    authenticating: false,
    lastSeen: Date.now(),
  };
  const current = participantRow(room, participant.id);
  const entry: LiveParticipant = {
    id: participant.id,
    name: participant.name,
    isManager: rights.isManager,
    canComment: rights.canComment,
    status: current?.status ?? 'ready',
  };
  if (current) Object.assign(current, entry);
  else room.snapshot.participants.push(entry);
  room.snapshot.revision++;
  await db.liveReviewParticipant.update({
    where: { id: participant.id },
    data: { lastSeenAt: new Date(), canComment: rights.canComment },
  });
  publish(room);
}
function validStroke(stroke: unknown): stroke is Omit<LiveStroke, 'participantId'> {
  if (!stroke || typeof stroke !== 'object') return false;
  const s = stroke as Partial<LiveStroke>;
  return (
    typeof s.id === 'string' &&
    s.id.length > 0 &&
    s.id.length <= 80 &&
    /^#[0-9a-fA-F]{6}$/.test(s.color ?? '') &&
    typeof s.width === 'number' &&
    Number.isFinite(s.width) &&
    s.width >= 1 &&
    s.width <= 20 &&
    Array.isArray(s.points) &&
    s.points.length >= 2 &&
    s.points.length <= LIVE_MAX_STROKE_POINTS &&
    s.points.every(
      (p) =>
        p &&
        Number.isFinite(p.x) &&
        Number.isFinite(p.y) &&
        p.x >= 0 &&
        p.x <= 1 &&
        p.y >= 0 &&
        p.y <= 1
    )
  );
}
async function handle(socket: Socket, input: LiveClientMessage) {
  const participantId = socket.data.participantId;
  const sessionId = socket.data.sessionId;
  if (!participantId || !sessionId) return;
  const room = rooms.get(sessionId);
  if (!room || room.sockets.get(participantId) !== socket) {
    socket.close(1008);
    return;
  }
  socket.data.lastSeen = Date.now();
  if (input.type === 'leave') {
    socket.close(1000, 'Left room');
    return;
  }
  if (input.type === 'ping') {
    if (typeof input.clientTime !== 'number' || !Number.isFinite(input.clientTime)) {
      error(socket, 'INVALID_MESSAGE');
      return;
    }
    send(socket, { type: 'pong', clientTime: input.clientTime, serverTime: Date.now() });
    return;
  }
  if (!['status', 'playback', 'transfer', 'stroke', 'undo', 'clear', 'end'].includes(input.type)) {
    error(socket, 'INVALID_MESSAGE');
    return;
  }
  const rights = await permission(participantId).catch(() => null);
  if (!rights?.allowed || rights.sessionId !== sessionId) {
    socket.close(1008, 'Access revoked');
    return;
  }
  if (room.snapshot.status !== 'active' || room.sockets.get(participantId) !== socket) return;
  const member = participantRow(room, participantId);
  if (!member) {
    socket.close(1008);
    return;
  }
  member.canComment = rights.canComment;
  member.isManager = rights.isManager;
  if (input.type === 'status') {
    if (!['ready', 'buffering', 'blocked'].includes(input.status)) {
      error(socket, 'INVALID_MESSAGE');
      return;
    }
    member.status = input.status;
    if (
      (input.status === 'buffering' || input.status === 'blocked') &&
      room.snapshot.presenterId === participantId &&
      room.snapshot.playback.playing
    )
      await pause(room);
    room.snapshot.revision++;
    publish(room);
    return;
  }
  if (input.type === 'playback') {
    if (
      !rights.canComment ||
      room.snapshot.presenterId !== participantId ||
      input.controlEpoch !== room.snapshot.controlEpoch
    ) {
      error(socket, 'NOT_PRESENTER');
      return;
    }
    if (
      typeof input.commandId !== 'string' ||
      input.commandId.length > 80 ||
      !Number.isFinite(input.position) ||
      input.position < 0 ||
      !Number.isFinite(input.rate) ||
      input.rate < 0.25 ||
      input.rate > 16 ||
      typeof input.playing !== 'boolean'
    ) {
      error(socket, 'INVALID_MESSAGE');
      return;
    }
    if (room.lastCommand.get(participantId) === input.commandId) return;
    const version = await db.videoVersion.findUnique({
      where: { id: room.snapshot.versionId },
      select: { duration: true },
    });
    if (!version || (version.duration !== null && input.position > version.duration + 1)) {
      error(socket, 'INVALID_POSITION');
      return;
    }
    const now = new Date();
    const revision = room.snapshot.revision + 1;
    const updated = await db.liveReviewSession.updateMany({
      where: {
        id: sessionId,
        status: 'active',
        presenterId: participantId,
        controlEpoch: input.controlEpoch,
      },
      data: {
        position: input.position,
        playing: input.playing,
        rate: input.rate,
        playbackAt: now,
        revision,
        lastActiveAt: now,
      },
    });
    if (updated.count !== 1) {
      error(socket, 'STALE_CONTROL');
      return;
    }
    const previous = room.snapshot.playback;
    if (input.playing || Math.abs(input.position - previous.position) > 0.1) {
      room.snapshot.strokes = [];
      room.snapshot.canvasEpoch++;
    }
    room.snapshot.revision = revision;
    room.snapshot.playback = {
      position: input.position,
      playing: input.playing,
      rate: input.rate,
      updatedAt: now.getTime(),
    };
    room.lastCommand.set(participantId, input.commandId);
    publish(room);
    return;
  }
  if (input.type === 'transfer') {
    if (
      !rights.isManager ||
      input.controlEpoch !== room.snapshot.controlEpoch ||
      typeof input.participantId !== 'string' ||
      !room.sockets.has(input.participantId)
    ) {
      error(socket, 'FORBIDDEN');
      return;
    }
    const target = await permission(input.participantId).catch(() => null);
    if (!target?.allowed || !target.canComment || target.sessionId !== sessionId) {
      error(socket, 'FORBIDDEN');
      return;
    }
    await pause(room);
    const revision = room.snapshot.revision + 1;
    const epoch = room.snapshot.controlEpoch + 1;
    const updated = await db.liveReviewSession.updateMany({
      where: { id: sessionId, status: 'active', controlEpoch: input.controlEpoch },
      data: {
        presenterId: input.participantId,
        controlEpoch: epoch,
        revision,
        playing: false,
        playbackAt: new Date(),
        lastActiveAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      error(socket, 'STALE_CONTROL');
      return;
    }
    room.snapshot.presenterId = input.participantId;
    room.snapshot.controlEpoch = epoch;
    room.snapshot.revision = revision;
    room.snapshot.playback.playing = false;
    room.snapshot.playback.updatedAt = Date.now();
    publish(room);
    return;
  }
  if (input.type === 'stroke') {
    const strokeValid = validStroke(input.stroke);
    if (
      !rights.canComment ||
      room.snapshot.playback.playing ||
      input.canvasEpoch !== room.snapshot.canvasEpoch ||
      !strokeValid
    ) {
      error(socket, 'FORBIDDEN', strokeValid ? input.stroke.id : undefined);
      return;
    }
    const change = applyLiveStroke(room.snapshot.strokes, input.stroke, participantId);
    if (change !== 'updated') {
      error(socket, change === 'stale' ? 'STALE_STROKE' : 'CANVAS_LIMIT', input.stroke.id);
      return;
    }
    room.snapshot.revision++;
    publish(room);
    return;
  }
  if (input.type === 'undo') {
    if (
      !rights.canComment ||
      room.snapshot.playback.playing ||
      input.canvasEpoch !== room.snapshot.canvasEpoch
    ) {
      error(socket, 'FORBIDDEN');
      return;
    }
    const index = room.snapshot.strokes.findLastIndex(
      (stroke) => stroke.participantId === participantId
    );
    if (index >= 0) {
      room.snapshot.strokes.splice(index, 1);
      room.snapshot.revision++;
      publish(room);
    }
    return;
  }
  if (input.type === 'clear') {
    if (!rights.isManager || input.canvasEpoch !== room.snapshot.canvasEpoch) {
      error(socket, 'FORBIDDEN');
      return;
    }
    room.snapshot.strokes = [];
    room.snapshot.canvasEpoch++;
    room.snapshot.revision++;
    publish(room);
    return;
  }
  if (input.type === 'end') {
    if (!rights.isManager) {
      error(socket, 'FORBIDDEN');
      return;
    }
    await endRoom(room);
  }
}
async function pause(room: Room) {
  if (room.snapshot.status !== 'active') return;
  const playback = room.snapshot.playback;
  if (!playback.playing) return;
  const position =
    playback.position + (Math.max(0, Date.now() - playback.updatedAt) / 1000) * playback.rate;
  const now = new Date();
  const revision = room.snapshot.revision + 1;
  const changed = await db.liveReviewSession.updateMany({
    where: { id: room.snapshot.sessionId, status: 'active' },
    data: { playing: false, position, playbackAt: now, revision },
  });
  if (changed.count !== 1) return;
  room.snapshot.playback = { ...playback, playing: false, position, updatedAt: now.getTime() };
  room.snapshot.revision = revision;
  publish(room);
}

const ownership = new Client({ connectionString: process.env.DATABASE_URL });
await ownership.connect();
const lock = await ownership.query<{ acquired: boolean }>(
  'SELECT pg_try_advisory_lock(680183641) AS acquired'
);
if (!lock.rows[0]?.acquired) throw new Error('Another live review gateway owns this database');
ownership.on('error', () => process.exit(1));
// Playback stops at the last committed position after an unexpected process exit.
await db.liveReviewSession.updateMany({
  where: { status: 'active', playing: true },
  data: { playing: false, playbackAt: new Date() },
});
let shuttingDown = false;
const server = Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET')
      return new Response(null, {
        status: sameSecret(request.headers.get('x-live-review-secret')) ? 204 : 403,
      });
    if (url.pathname === '/comments' && request.method === 'POST') {
      if (!sameSecret(request.headers.get('x-live-review-secret')))
        return new Response(null, { status: 403 });
      return (async () => {
        let body: { versionId?: unknown };
        try {
          body = (await request.json()) as { versionId?: unknown };
        } catch {
          return new Response(null, { status: 400 });
        }
        if (typeof body.versionId !== 'string' || body.versionId.length > 128)
          return new Response(null, { status: 400 });
        const session = await db.liveReviewSession.findFirst({
          where: { versionId: body.versionId, status: 'active' },
          select: { id: true },
        });
        const room = session ? rooms.get(session.id) : null;
        if (room)
          for (const socket of room.sockets.values())
            send(socket, { type: 'comments', versionId: body.versionId });
        return new Response(null, { status: 204 });
      })();
    }
    if (url.pathname !== '/ws' || request.method !== 'GET')
      return new Response(null, { status: 404 });
    if (request.headers.get('origin') !== allowedOrigin) return new Response(null, { status: 403 });
    const data: SocketData = {
      participantId: null,
      sessionId: null,
      authenticated: false,
      authenticating: false,
      openedAt: Date.now(),
      lastSeen: Date.now(),
      windowAt: Date.now(),
      messageCount: 0,
      intentionalLeave: false,
    };
    return server.upgrade(request, { data }) ? undefined : new Response(null, { status: 400 });
  },
  websocket: {
    maxPayloadLength: LIVE_MAX_MESSAGE_BYTES,
    open(socket) {
      sockets.add(socket);
      setTimeout(() => {
        if (!socket.data.authenticated) socket.close(1008, 'Auth timeout');
      }, 5000);
    },
    message(socket, raw) {
      const text =
        typeof raw === 'string'
          ? raw
          : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw).toString('utf8');
      if (Buffer.byteLength(text) > LIVE_MAX_MESSAGE_BYTES) {
        socket.close(1009);
        return;
      }
      const now = Date.now();
      if (now - socket.data.windowAt >= 1000) {
        socket.data.windowAt = now;
        socket.data.messageCount = 0;
      }
      if (++socket.data.messageCount > 30) {
        socket.close(1008, 'Rate limit');
        return;
      }
      let value: LiveClientMessage;
      try {
        value = JSON.parse(text) as LiveClientMessage;
      } catch {
        socket.close(1008);
        return;
      }
      if (!value || typeof value !== 'object') {
        socket.close(1008);
        return;
      }
      if (!socket.data.authenticated) {
        if (socket.data.authenticating) {
          socket.close(1008);
          return;
        }
        if (value.type !== 'auth' || typeof value.ticket !== 'string') {
          socket.close(1008);
          return;
        }
        socket.data.authenticating = true;
        void authSocket(socket, value.ticket)
          .catch(() => socket.close(1008))
          .finally(() => {
            socket.data.authenticating = false;
          });
        return;
      }
      if (value.type === 'auth') {
        socket.close(1008);
        return;
      }
      if (value.type === 'leave') socket.data.intentionalLeave = true;
      const room = rooms.get(socket.data.sessionId!);
      if (room) enqueue(room, () => handle(socket, value), socket);
    },
    close(socket) {
      sockets.delete(socket);
      if (shuttingDown) return;
      const sessionId = socket.data.sessionId;
      const participantId = socket.data.participantId;
      if (!sessionId || !participantId) return;
      const room = rooms.get(sessionId);
      if (!room || room.sockets.get(participantId) !== socket) return;
      room.sockets.delete(participantId);
      enqueue(room, async () => {
        if (room.sockets.has(participantId) || room.ending || room.snapshot.status !== 'active')
          return;
        if (room.snapshot.presenterId === participantId) await pause(room);
        if (room.sockets.has(participantId) || room.ending || room.snapshot.status !== 'active')
          return;
        room.snapshot.participants = room.snapshot.participants.filter(
          (p) => p.id !== participantId
        );
        // Keep the presenter assignment for a validated rejoin. A manager transfer can replace it.
        room.snapshot.revision++;
        publish(room);
        if (!room.sockets.size) scheduleEmptyClose(room, socket.data.intentionalLeave);
      });
    },
  },
});
const sweep = setInterval(() => {
  for (const [sessionId, endedAt] of recentlyEndedRooms)
    if (Date.now() - endedAt > 60_000) recentlyEndedRooms.delete(sessionId);
  for (const socket of sockets) {
    if (Date.now() - socket.data.lastSeen > 30_000) {
      socket.close(1008, 'Heartbeat timeout');
      continue;
    }
    if (socket.data.authenticated && socket.data.participantId)
      void permission(socket.data.participantId)
        .then((p) => {
          if (!p.allowed || p.sessionId !== socket.data.sessionId) {
            socket.close(1008, 'Access revoked');
            return;
          }
          const room = rooms.get(socket.data.sessionId!);
          if (!room) return;
          enqueue(room, async () => {
            if (
              room.snapshot.status !== 'active' ||
              room.sockets.get(socket.data.participantId!) !== socket
            )
              return;
            if (room.snapshot.presenterId === socket.data.participantId && !p.canComment) {
              socket.close(1008, 'Presenter permission revoked');
              return;
            }
            const member = participantRow(room, socket.data.participantId!);
            if (
              member &&
              (member.canComment !== p.canComment || member.isManager !== p.isManager)
            ) {
              member.canComment = p.canComment;
              member.isManager = p.isManager;
              room.snapshot.revision++;
              publish(room);
            }
          });
        })
        .catch(() => socket.close(1011, 'Permission unavailable'));
  }
  void (async () => {
    const occupied = [...rooms.values()]
      .filter((room) => room.sockets.size > 0)
      .map((room) => room.snapshot.sessionId);
    if (occupied.length)
      await db.liveReviewSession.updateMany({
        where: { id: { in: occupied }, status: 'active' },
        data: { lastActiveAt: new Date() },
      });
    const participantIds = [...rooms.values()].flatMap((room) => [...room.sockets.keys()]);
    if (participantIds.length)
      await db.liveReviewParticipant.updateMany({
        where: { id: { in: participantIds } },
        data: { lastSeenAt: new Date() },
      });
    const expired = await db.liveReviewSession.findMany({
      where: { status: 'active', lastActiveAt: { lt: new Date(Date.now() - 30 * 60_000) } },
      select: { id: true },
    });
    if (expired.length) {
      await db.liveReviewSession.updateMany({
        where: { id: { in: expired.map((item) => item.id) }, status: 'active' },
        data: { status: 'ended', playing: false, endedAt: new Date() },
      });
      for (const item of expired) rooms.delete(item.id);
    }
  })().catch(() => undefined);
}, 15_000);
// Keep crash recovery near the last observed playback, without advancing through
// service downtime. The room queue serializes checkpoints with pause and transfer.
const checkpoint = setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.snapshot.playback.playing || room.snapshot.status !== 'active') continue;
    enqueue(room, async () => {
      const playback = room.snapshot.playback;
      if (!playback.playing || room.snapshot.status !== 'active') return;
      const now = new Date();
      const position =
        playback.position +
        (Math.max(0, now.getTime() - playback.updatedAt) / 1000) * playback.rate;
      await db.liveReviewSession.updateMany({
        where: {
          id: room.snapshot.sessionId,
          status: 'active',
          controlEpoch: room.snapshot.controlEpoch,
        },
        data: { position, playbackAt: now },
      });
    });
  }
}, 5000);
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(sweep);
  clearInterval(checkpoint);
  for (const room of rooms.values()) cancelEmptyClose(room);
  await Promise.all(
    [...rooms.values()].map(async (room) => {
      enqueue(room, () => pause(room));
      await room.queue;
    })
  );
  for (const socket of sockets) socket.close(1001, 'Server restart');
  server.stop();
  await db.liveReviewSession.updateMany({
    where: { status: 'active', playing: true },
    data: { playing: false, playbackAt: new Date() },
  });
  await db.$disconnect();
  await ownership.end();
  process.exit(0);
}
// lib/db installs generic signal handlers during import. This standalone process
// must persist playback before the shared Prisma connection is disconnected.
process.removeAllListeners('SIGTERM');
process.removeAllListeners('SIGINT');
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
