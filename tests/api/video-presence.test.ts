import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/videos/[videoId]/presence/route';
import { db } from '@/lib/db';
import { VIDEO_PRESENCE_HEARTBEAT_MS, VIDEO_PRESENCE_TTL_MS } from '@/lib/video-presence-types';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createExpiredUser,
  createShareLink,
  createUser,
  createVideo,
  seedProject,
  seedVersion,
} from '../factories';

const ORIGIN = 'http://localhost:3000';
type PresenceData = {
  participants: Array<{
    id: string;
    name: string;
    isAnonymous: boolean;
    isGuest?: boolean;
    isPlaying: boolean;
    isSelf: boolean;
  }>;
};

function shareCookie(videoId: string, token: string, passwordVerified = false) {
  return {
    [getShareSessionCookieName(videoId)]: createShareSessionValue(token, videoId, passwordVerified),
  };
}

function request(
  videoId: string,
  input: {
    clientId?: string;
    action?: 'heartbeat' | 'leave';
    isPlaying?: boolean;
    guestName?: unknown;
    cookies?: Record<string, string>;
    origin?: string | null;
  } = {}
) {
  return apiRequest(`/api/videos/${videoId}/presence`, {
    method: 'POST',
    body: {
      clientId: input.clientId ?? randomUUID(),
      action: input.action ?? 'heartbeat',
      isPlaying: input.isPlaying ?? false,
      ...(input.guestName !== undefined ? { guestName: input.guestName } : {}),
    },
    headers: input.origin === null ? {} : { origin: input.origin ?? ORIGIN },
    cookies: input.cookies,
  });
}

function guestCookie(response: Response): Record<string, string> {
  const first = response.headers.get('set-cookie')?.split(';')[0];
  expect(first).toMatch(/^openframe_guest_identity=/);
  const separator = first!.indexOf('=');
  return { [first!.slice(0, separator)]: first!.slice(separator + 1) };
}

async function call(videoId: string, input: Parameters<typeof request>[1] = {}) {
  return callRoute(POST, request(videoId, input), { videoId });
}

describe('POST /api/videos/[videoId]/presence', () => {
  it('rejects anonymous and signed-in visitors without access and writes no row', async () => {
    const { video } = await seedVersion({ visibility: 'PRIVATE' });
    signedOut();
    expect((await call(video.id)).status).toBe(401);
    signedInAs(await createUser());
    expect((await call(video.id)).status).toBe(403);
    expect(await db.videoPresence.count()).toBe(0);
  });

  it('rejects absent or cross-site Origin and invalid client IDs', async () => {
    const { owner, video } = await seedVersion();
    signedInAs(owner);
    expect((await call(video.id, { origin: null })).status).toBe(403);
    expect((await call(video.id, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call(video.id, { clientId: 'spoof' })).status).toBe(400);
    expect(await db.videoPresence.count()).toBe(0);
  });

  it('shows a signed-in name and a stable anonymous name without exposing identities', async () => {
    const { owner, project, video } = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({
      projectId: project.id,
      videoId: video.id,
      allowGuests: false,
    });
    signedInAs(owner);
    const named = await call(video.id, { isPlaying: true });
    expect(named.status).toBe(200);
    const namedParticipant = (await readData<PresenceData>(named)).participants[0];
    expect(namedParticipant).toMatchObject({
      name: owner.name,
      isAnonymous: false,
      isPlaying: true,
      isSelf: true,
    });
    expect(namedParticipant.id).not.toContain(owner.id);
    signedOut();
    const first = await call(video.id, { cookies: shareCookie(video.id, link.token) });
    expect(first.status).toBe(200);
    const anonymous = (await readData<PresenceData>(first)).participants.find((p) => p.isSelf)!;
    expect(anonymous).toMatchObject({ isAnonymous: true, isPlaying: false });
    expect(anonymous.name).toMatch(/^[A-Za-z]+ [A-Za-z]+$/);
    expect(
      JSON.stringify(
        await readData<PresenceData>(
          await call(video.id, {
            cookies: { ...shareCookie(video.id, link.token), ...guestCookie(first) },
          })
        )
      )
    ).toContain(anonymous.id);
    expect(await db.videoPresence.count()).toBe(3);
  });

  it('keeps an anonymous public viewer visible without a share link', async () => {
    const { video } = await seedVersion({ visibility: 'PUBLIC' });
    signedOut();
    const response = await call(video.id, { isPlaying: true });
    expect(response.status).toBe(200);
    expect((await readData<PresenceData>(response)).participants).toMatchObject([
      { isAnonymous: true, isPlaying: true, isSelf: true },
    ]);
    expect((await db.videoPresence.findFirstOrThrow()).shareToken).toBeNull();
  });

  it('uses an entered guest name and updates it within the heartbeat write interval', async () => {
    const { project, video } = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({ projectId: project.id, videoId: video.id });
    const clientId = randomUUID();
    signedOut();
    const first = await call(video.id, { clientId, cookies: shareCookie(video.id, link.token) });
    const anonymous = (await readData<PresenceData>(first)).participants[0];
    const cookies = { ...shareCookie(video.id, link.token), ...guestCookie(first) };
    const named = await call(video.id, { clientId, cookies, guestName: '  Zoë İpek  ' });
    expect(named.status).toBe(200);
    expect((await readData<PresenceData>(named)).participants).toEqual([
      { ...anonymous, name: 'Zoë İpek', isAnonymous: false, isGuest: true },
    ]);
    const row = await db.videoPresence.findFirstOrThrow();
    expect(row.name).toBe('Zoë İpek');
    expect(await db.videoPresence.count()).toBe(1);
    await call(video.id, { clientId, cookies, guestName: 'Renamed Reviewer' });
    expect((await db.videoPresence.findFirstOrThrow()).name).toBe('Renamed Reviewer');
    await call(video.id, { clientId, cookies, guestName: '   ' });
    expect((await db.videoPresence.findFirstOrThrow()).name).toBe('');
    expect(
      (await readData<PresenceData>(await call(video.id, { clientId, cookies }))).participants
    ).toEqual([anonymous]);
  });

  it('prefers a supplied guest name over a newer unnamed tab for the same identity', async () => {
    const { project, video } = await seedVersion();
    const link = await createShareLink({ projectId: project.id, videoId: video.id });
    signedOut();
    const named = await call(video.id, {
      cookies: shareCookie(video.id, link.token),
      guestName: 'Reviewer Name',
    });
    const cookies = { ...shareCookie(video.id, link.token), ...guestCookie(named) };
    const response = await call(video.id, { cookies, isPlaying: true });
    const data = await readData<PresenceData>(response);
    expect(data.participants).toMatchObject([
      { name: 'Reviewer Name', isAnonymous: false, isGuest: true, isPlaying: true },
    ]);
    expect(data.participants).toHaveLength(1);
    expect(await db.videoPresence.count()).toBe(2);
  });

  it('rejects invalid guest labels without writing and cannot replace an account name', async () => {
    const { owner, video } = await seedVersion();
    signedInAs(owner);
    expect((await call(video.id, { guestName: { name: 'Other' } })).status).toBe(400);
    expect((await call(video.id, { guestName: 'x'.repeat(101) })).status).toBe(400);
    expect(await db.videoPresence.count()).toBe(0);
    const response = await call(video.id, { guestName: 'Other account' });
    expect(response.status).toBe(200);
    expect((await readData<PresenceData>(response)).participants).toMatchObject([
      { name: owner.name, isAnonymous: false, isGuest: false },
    ]);
    expect((await db.videoPresence.findFirstOrThrow()).name).toBe(owner.name);
  });

  it('aggregates two tabs, removes one on leave, and expires stale rows', async () => {
    const { owner, project, video } = await seedVersion();
    signedInAs(owner);
    const firstId = randomUUID();
    const secondId = randomUUID();
    await call(video.id, { clientId: firstId, isPlaying: true });
    let response = await call(video.id, { clientId: secondId });
    expect((await readData<PresenceData>(response)).participants).toMatchObject([
      { isPlaying: true, isSelf: true },
    ]);
    expect(await db.videoPresence.count()).toBe(2);
    response = await call(video.id, { clientId: secondId, action: 'leave' });
    expect((await readData<PresenceData>(response)).participants).toMatchObject([
      { isPlaying: true },
    ]);
    expect(await db.videoPresence.count()).toBe(1);
    const otherVideo = await createVideo({ projectId: project.id });
    await call(otherVideo.id);
    await db.videoPresence.updateMany({
      data: { lastSeenAt: new Date(Date.now() - VIDEO_PRESENCE_TTL_MS - 1000) },
    });
    response = await call(video.id, { clientId: secondId, action: 'leave' });
    expect((await readData<PresenceData>(response)).participants).toEqual([]);
  });

  it('skips unchanged heartbeat writes inside 15 seconds but updates playback changes', async () => {
    const { owner, video } = await seedVersion();
    const clientId = randomUUID();
    signedInAs(owner);
    await call(video.id, { clientId });
    const first = await db.videoPresence.findFirstOrThrow();
    await call(video.id, { clientId });
    const unchanged = await db.videoPresence.findFirstOrThrow();
    expect(unchanged.lastSeenAt).toEqual(first.lastSeenAt);
    await call(video.id, { clientId, isPlaying: true });
    const changed = await db.videoPresence.findFirstOrThrow();
    expect(changed.isPlaying).toBe(true);
    expect(changed.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());
    const agedAt = new Date(Date.now() - VIDEO_PRESENCE_HEARTBEAT_MS - 1000);
    await db.videoPresence.updateMany({ data: { lastSeenAt: agedAt } });
    await call(video.id, { clientId, isPlaying: true });
    expect((await db.videoPresence.findFirstOrThrow()).lastSeenAt.getTime()).toBeGreaterThan(
      agedAt.getTime()
    );
  });

  it('does not let another viewer overwrite or leave a known client ID', async () => {
    const { owner, video } = await seedVersion({ visibility: 'PUBLIC' });
    const other = await createUser();
    const clientId = randomUUID();
    signedInAs(owner);
    await call(video.id, { clientId, isPlaying: true });
    signedInAs(other);
    expect((await call(video.id, { clientId, action: 'leave' })).status).toBe(200);
    expect(
      (await db.videoPresence.findFirstOrThrow({ where: { videoId: video.id } })).isPlaying
    ).toBe(true);
    await call(video.id, { clientId, isPlaying: false });
    expect(await db.videoPresence.count({ where: { clientId } })).toBe(2);
    expect(
      (await readData<PresenceData>(await call(video.id, { clientId }))).participants
    ).toHaveLength(2);
  });

  it('refuses a share session for another video or project and a locked link without verification', async () => {
    const first = await seedVersion({ visibility: 'PRIVATE' });
    const secondVideo = await createVideo({ projectId: first.project.id });
    const otherProject = await seedProject();
    const otherVideo = await createVideo({ projectId: otherProject.project.id });
    const link = await createShareLink({
      projectId: first.project.id,
      videoId: first.video.id,
      password: 'secret',
    });
    const projectLink = await createShareLink({ projectId: first.project.id, videoId: null });
    signedOut();
    expect(
      (await call(first.video.id, { cookies: shareCookie(first.video.id, link.token) })).status
    ).toBe(401);
    expect(
      (await call(secondVideo.id, { cookies: shareCookie(secondVideo.id, link.token, true) }))
        .status
    ).toBe(401);
    expect(
      (await call(otherVideo.id, { cookies: shareCookie(otherVideo.id, link.token, true) })).status
    ).toBe(401);
    expect(
      (await call(first.video.id, { cookies: shareCookie(first.video.id, projectLink.token) }))
        .status
    ).toBe(401);
    expect(
      (await call(first.video.id, { cookies: shareCookie(first.video.id, 'forged', true) })).status
    ).toBe(401);
    expect(await db.videoPresence.count()).toBe(0);
  });

  it('hides revoked, rotated, expired, and password-changed share presences', async () => {
    const { project, video } = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({
      projectId: project.id,
      videoId: video.id,
      password: 'secret',
    });
    signedOut();
    const first = await call(video.id, { cookies: shareCookie(video.id, link.token, true) });
    expect(first.status).toBe(200);
    const owner = await db.project.findUniqueOrThrow({
      where: { id: project.id },
      include: { owner: true },
    });
    signedInAs(owner.owner);
    const ownerCall = () => call(video.id);
    expect((await readData<PresenceData>(await ownerCall())).participants).toHaveLength(2);
    await db.shareLink.update({
      where: { id: link.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await readData<PresenceData>(await ownerCall())).participants).toHaveLength(1);
    await db.shareLink.update({
      where: { id: link.id },
      data: { expiresAt: null, token: 'rotated-token' },
    });
    expect((await readData<PresenceData>(await ownerCall())).participants).toHaveLength(1);
    await db.shareLink.update({
      where: { id: link.id },
      data: { token: link.token, passwordHash: 'changed-hash' },
    });
    expect((await readData<PresenceData>(await ownerCall())).participants).toHaveLength(1);
    await db.shareLink.delete({ where: { id: link.id } });
    expect((await readData<PresenceData>(await ownerCall())).participants).toHaveLength(1);
  });

  it('hides direct presence when account access or owner billing expires', async () => {
    const { owner, video } = await seedVersion();
    const outsider = await createExpiredUser();
    signedInAs(owner);
    await call(video.id);
    signedInAs(outsider);
    expect((await call(video.id)).status).toBe(403);
    await db.user.update({
      where: { id: owner.id },
      data: { trialEndsAt: new Date(Date.now() - 1000) },
    });
    signedInAs(owner);
    expect((await call(video.id)).status).toBe(403);
    expect(await db.videoPresence.count()).toBe(1);
  });

  it('refuses a share heartbeat after owner billing expires', async () => {
    const { owner, project, video } = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({ projectId: project.id, videoId: video.id });
    const cookies = shareCookie(video.id, link.token);
    signedOut();
    expect((await call(video.id, { cookies })).status).toBe(200);
    await db.user.update({
      where: { id: owner.id },
      data: { trialEndsAt: new Date(Date.now() - 1000) },
    });
    expect((await call(video.id, { cookies })).status).toBe(401);
  });

  it('expires a member within the TTL after video access is revoked', async () => {
    const { owner, project, video } = await seedVersion({ visibility: 'PRIVATE' });
    const member = await createUser();
    const membership = await addProjectMember({ projectId: project.id, userId: member.id });
    signedInAs(member);
    expect((await call(video.id)).status).toBe(200);
    signedInAs(owner);
    expect((await readData<PresenceData>(await call(video.id))).participants).toHaveLength(2);
    await db.projectMember.delete({ where: { id: membership.id } });
    signedInAs(member);
    expect((await call(video.id)).status).toBe(403);
    signedInAs(owner);
    await db.videoPresence.updateMany({
      where: { userId: member.id },
      data: { lastSeenAt: new Date(Date.now() - VIDEO_PRESENCE_TTL_MS - 1000) },
    });
    expect((await readData<PresenceData>(await call(video.id))).participants).toHaveLength(1);
  });

  it('checks all share tokens in one roster query as the number of viewers grows', async () => {
    const { owner, project, video } = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({ projectId: project.id, videoId: video.id });
    signedOut();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        call(video.id, { cookies: shareCookie(video.id, link.token) })
      )
    );
    expect(responses.map((response) => response.status)).toEqual(Array(12).fill(200));
    const links = vi.spyOn(db.shareLink, 'findMany');
    const rows = vi.spyOn(db.videoPresence, 'findMany');
    const videoReads = vi.spyOn(db.video, 'findUnique');
    try {
      signedInAs(owner);
      const response = await call(video.id);
      expect((await readData<PresenceData>(response)).participants).toHaveLength(13);
      expect(links).toHaveBeenCalledTimes(1);
      expect(rows).toHaveBeenCalledTimes(1);
      expect(videoReads).toHaveBeenCalledTimes(1);
    } finally {
      links.mockRestore();
      rows.mockRestore();
      videoReads.mockRestore();
    }
  });
});
