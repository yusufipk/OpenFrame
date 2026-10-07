import { createHmac, randomUUID } from 'node:crypto';
import type { VideoPresence } from '@prisma/client';
import { checkVideoAccess } from '@/lib/content-access';
import { db } from '@/lib/db';
import {
  VIDEO_PRESENCE_HEARTBEAT_MS,
  VIDEO_PRESENCE_TTL_MS,
  type VideoPresenceParticipant,
} from '@/lib/video-presence-types';

export interface PresenceViewer {
  userId: string | null;
  guestIdentityId: string | null;
  name: string;
  shareToken: string | null;
  sharePasswordHash: string | null;
}

type PresenceRow = Pick<
  VideoPresence,
  'identityKey' | 'userId' | 'shareToken' | 'sharePasswordHash' | 'name' | 'isPlaying'
>;

function presenceSecret(): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('Missing AUTH_SECRET/NEXTAUTH_SECRET for video presence');
  return secret;
}

export function presenceIdentityKey(
  videoId: string,
  viewer: Pick<PresenceViewer, 'userId' | 'guestIdentityId'>
): string {
  const identity = viewer.userId ? `user:${viewer.userId}` : `guest:${viewer.guestIdentityId}`;
  if (!viewer.userId && !viewer.guestIdentityId) throw new Error('Missing presence identity');
  return createHmac('sha256', presenceSecret())
    .update(`video-presence:${videoId}:${identity}`)
    .digest('base64url');
}

const adjectives = [
  'Amber',
  'Brave',
  'Calm',
  'Clever',
  'Gentle',
  'Golden',
  'Kind',
  'Quiet',
  'Swift',
  'Warm',
];
const animals = ['Bear', 'Deer', 'Fox', 'Heron', 'Koala', 'Otter', 'Owl', 'Panda', 'Robin', 'Wolf'];
const PRESENCE_CLEANUP_MS = 60_000;
let lastCleanupAt = 0;

export function anonymousPresenceName(identityKey: string): string {
  const bytes = Buffer.from(identityKey, 'base64url');
  return `${adjectives[bytes[0] % adjectives.length]} ${animals[bytes[1] % animals.length]}`;
}

async function activePresenceRows(videoId: string): Promise<PresenceRow[]> {
  const now = Date.now();
  const cutoff = new Date(now - VIDEO_PRESENCE_TTL_MS);
  if (now - lastCleanupAt >= PRESENCE_CLEANUP_MS) {
    lastCleanupAt = now;
    await db.videoPresence.deleteMany({ where: { lastSeenAt: { lte: cutoff } } });
  }
  return db.videoPresence.findMany({
    where: { videoId, lastSeenAt: { gt: cutoff } },
    orderBy: { lastSeenAt: 'desc' },
    select: {
      identityKey: true,
      userId: true,
      shareToken: true,
      sharePasswordHash: true,
      name: true,
      isPlaying: true,
    },
  });
}

async function allowedRows(
  videoId: string,
  projectId: string,
  rows: PresenceRow[]
): Promise<PresenceRow[]> {
  const hasPublicGuests = rows.some((row) => !row.shareToken && !row.userId);
  const tokens = [
    ...new Set(
      rows.map((row) => row.shareToken).filter((token): token is string => Boolean(token))
    ),
  ];
  const [links, publicGuestAccess] = await Promise.all([
    tokens.length
      ? db.shareLink.findMany({
          where: {
            token: { in: tokens },
            projectId,
            videoId,
            permission: { in: ['VIEW', 'COMMENT'] },
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          select: { token: true, passwordHash: true },
        })
      : Promise.resolve([]),
    hasPublicGuests
      ? checkVideoAccess(videoId, undefined).then((access) => access.hasAccess)
      : Promise.resolve(false),
  ]);
  const shares = new Map(links.map((link) => [link.token, link.passwordHash]));
  return rows.filter((row) => {
    // Direct members lose their row no later than the TTL after access is revoked,
    // because a revoked client cannot renew it. Rechecking every member on each
    // poll would multiply access queries by the number of viewers.
    if (!row.shareToken) return row.userId ? true : publicGuestAccess;
    return shares.has(row.shareToken) && shares.get(row.shareToken) === row.sharePasswordHash;
  });
}

export async function updateVideoPresence(input: {
  videoId: string;
  projectId: string;
  clientId: string;
  action: 'heartbeat' | 'leave';
  isPlaying: boolean;
  viewer: PresenceViewer;
}): Promise<VideoPresenceParticipant[]> {
  const { videoId, projectId, clientId, action, isPlaying, viewer } = input;
  const identityKey = presenceIdentityKey(videoId, viewer);
  if (action === 'leave') {
    await db.videoPresence.deleteMany({ where: { videoId, identityKey, clientId } });
  } else {
    // Guest names are display labels; identity and access still use the signed cookie.
    const name = viewer.name;
    await db.$executeRaw`
      INSERT INTO "video_presences" ("id", "videoId", "identityKey", "clientId", "userId", "shareToken", "sharePasswordHash", "name", "isPlaying", "lastSeenAt")
      VALUES (${randomUUID()}, ${videoId}, ${identityKey}, ${clientId}, ${viewer.userId}, ${viewer.shareToken}, ${viewer.sharePasswordHash}, ${name}, ${isPlaying}, CURRENT_TIMESTAMP)
      ON CONFLICT ("videoId", "identityKey", "clientId") DO UPDATE SET
        "userId" = EXCLUDED."userId",
        "shareToken" = EXCLUDED."shareToken",
        "sharePasswordHash" = EXCLUDED."sharePasswordHash",
        "name" = EXCLUDED."name",
        "isPlaying" = EXCLUDED."isPlaying",
        "lastSeenAt" = CURRENT_TIMESTAMP
      WHERE "video_presences"."lastSeenAt" <= CURRENT_TIMESTAMP - (${VIDEO_PRESENCE_HEARTBEAT_MS} * INTERVAL '1 millisecond')
        OR "video_presences"."userId" IS DISTINCT FROM EXCLUDED."userId"
        OR "video_presences"."shareToken" IS DISTINCT FROM EXCLUDED."shareToken"
        OR "video_presences"."sharePasswordHash" IS DISTINCT FROM EXCLUDED."sharePasswordHash"
        OR "video_presences"."name" IS DISTINCT FROM EXCLUDED."name"
        OR "video_presences"."isPlaying" IS DISTINCT FROM EXCLUDED."isPlaying"
    `;
  }
  const rows = await allowedRows(videoId, projectId, await activePresenceRows(videoId));
  const participants = new Map<string, VideoPresenceParticipant>();
  for (const row of rows) {
    const existing = participants.get(row.identityKey);
    if (existing) {
      existing.isPlaying ||= row.isPlaying;
      if (existing.isAnonymous && row.name) {
        existing.name = row.name;
        existing.isAnonymous = false;
      }
      continue;
    }
    participants.set(row.identityKey, {
      id: row.identityKey,
      name: row.name || anonymousPresenceName(row.identityKey),
      isAnonymous: !row.userId && !row.name,
      isGuest: !row.userId,
      isPlaying: row.isPlaying,
      isSelf: row.identityKey === identityKey,
    });
  }
  return [...participants.values()].sort(
    (left, right) =>
      Number(right.isSelf) - Number(left.isSelf) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id)
  );
}
