import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { GET, POST } from '@/app/api/videos/[videoId]/live-review/route';
import { POST as refreshAccess } from '@/app/api/internal/live-review/access/route';
import { createShareLink, createUser, seedVersion } from '../factories';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import { getGuestIdentityFromRequest } from '@/lib/guest-identity';
import { redeemLiveTicket } from '@/lib/live-review/tickets';

const origin = { origin: 'http://localhost:3000' };

beforeEach(() => {
  vi.stubEnv('OPENFRAME_ENABLE_LIVE_REVIEW', 'true');
  vi.stubEnv('LIVE_REVIEW_SECRET', 'test-live-secret');
  vi.stubEnv('LIVE_REVIEW_INTERNAL_URL', 'http://live-review:3101');
  vi.stubEnv('LIVE_REVIEW_PUBLIC_URL', 'ws://localhost:3101/ws');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 }))
  );
});
afterEach(() => vi.unstubAllGlobals());

async function call(videoId: string, body: object, cookies?: Record<string, string>) {
  return callRoute(
    POST,
    apiRequest(`/api/videos/${videoId}/live-review`, { body, headers: origin, cookies }),
    { videoId }
  );
}

async function startFixture() {
  const fixture = await seedVersion({ providerId: 'r2' });
  signedInAs(fixture.owner);
  const response = await call(fixture.video.id, { action: 'start', versionId: fixture.version.id });
  expect(response.status).toBe(200);
  const data = await readData<{
    ticket: string;
    participantId: string;
    sessionId: string;
    versionId: string;
  }>(response);
  return { ...fixture, data };
}

describe('live review access and session lifecycle', () => {
  it('revokes an existing participant when live review is disabled', async () => {
    const fixture = await startFixture();
    vi.stubEnv('OPENFRAME_ENABLE_LIVE_REVIEW', 'false');
    const response = await refreshAccess(
      apiRequest('/api/internal/live-review/access', {
        body: { participantId: fixture.data.participantId },
        headers: { 'x-live-review-secret': 'test-live-secret' },
      })
    );
    expect(response.status).toBe(200);
    expect(await readData(response)).toEqual({
      allowed: false,
      canComment: false,
      isManager: false,
      sessionId: null,
    });
  });

  it('refuses an unauthenticated caller and an unauthorized account without creating a room', async () => {
    const fixture = await seedVersion({ providerId: 'r2' });
    signedOut();
    expect(
      (await call(fixture.video.id, { action: 'start', versionId: fixture.version.id })).status
    ).toBe(401);
    signedInAs(await createUser());
    expect(
      (await call(fixture.video.id, { action: 'start', versionId: fixture.version.id })).status
    ).toBe(403);
    expect(await db.liveReviewSession.count()).toBe(0);
  });

  it('creates one room, gives its manager control, and redeems its ticket once', async () => {
    const fixture = await startFixture();
    const room = await db.liveReviewSession.findUniqueOrThrow({
      where: { id: fixture.data.sessionId },
    });
    expect(room.videoId).toBe(fixture.video.id);
    expect(room.versionId).toBe(fixture.version.id);
    expect(room.presenterId).toBe(fixture.data.participantId);
    expect(room.controlEpoch).toBe(1);
    expect(
      (await call(fixture.video.id, { action: 'start', versionId: fixture.version.id })).status
    ).toBe(409);
    expect(await db.liveReviewSession.count({ where: { status: 'active' } })).toBe(1);
    expect(await redeemLiveTicket(fixture.data.ticket)).toEqual({
      sessionId: room.id,
      participantId: fixture.data.participantId,
    });
    expect(await redeemLiveTicket(fixture.data.ticket)).toBeNull();
  });

  it('requires the same account for a participant reconnect', async () => {
    const fixture = await startFixture();
    const other = await createUser();
    signedInAs(other);
    const response = await call(fixture.video.id, {
      action: 'join',
      versionId: fixture.version.id,
      participantId: fixture.data.participantId,
    });
    expect(response.status).toBe(403);
    signedInAs(fixture.owner);
    const reconnect = await call(fixture.video.id, {
      action: 'join',
      versionId: fixture.version.id,
      participantId: fixture.data.participantId,
    });
    expect(reconnect.status).toBe(200);
    const data = await readData<{ participantId: string; ticket: string }>(reconnect);
    expect(data.participantId).toBe(fixture.data.participantId);
    expect(data.ticket).not.toBe(fixture.data.ticket);
    expect(
      await db.liveReviewParticipant.count({ where: { sessionId: fixture.data.sessionId } })
    ).toBe(1);
  });

  it('restores manager rights after a reload creates a new participant', async () => {
    const fixture = await startFixture();
    const response = await call(fixture.video.id, {
      action: 'join',
      versionId: fixture.version.id,
    });
    const joined = await readData<{ participantId: string }>(response);
    expect(joined.participantId).not.toBe(fixture.data.participantId);
    const participant = await db.liveReviewParticipant.findUniqueOrThrow({
      where: { id: joined.participantId },
    });
    expect(participant.isManager).toBe(true);
    expect(participant.userId).toBe(fixture.owner.id);
    const room = await db.liveReviewSession.findUniqueOrThrow({
      where: { id: fixture.data.sessionId },
    });
    expect(room.presenterId).toBe(fixture.data.participantId);
  });

  it('rejects a mismatched video version and does not add a participant', async () => {
    const fixture = await startFixture();
    const otherVersion = await db.videoVersion.create({
      data: {
        videoParentId: fixture.video.id,
        versionNumber: 2,
        providerId: 'r2',
        videoId: 'other-provider-video',
        originalUrl: '/api/upload/video/other.mp4',
      },
    });
    expect(
      (await call(fixture.video.id, { action: 'join', versionId: otherVersion.id })).status
    ).toBe(404);
    expect(
      await db.liveReviewParticipant.count({ where: { sessionId: fixture.data.sessionId } })
    ).toBe(1);
  });

  it('keeps a guest bound to its signed identity and revokes a deleted share link', async () => {
    const fixture = await startFixture();
    const share = await createShareLink({
      projectId: fixture.project.id,
      videoId: fixture.video.id,
      permission: 'COMMENT',
    });
    signedOut();
    const cookies = {
      [getShareSessionCookieName(fixture.video.id)]: createShareSessionValue(
        share.token,
        fixture.video.id,
        false
      ),
    };
    const joined = await call(
      fixture.video.id,
      { action: 'join', versionId: fixture.version.id, guestName: 'Reviewer' },
      cookies
    );
    expect(joined.status).toBe(200);
    const guest = await readData<{ participantId: string }>(joined);
    expect(
      (
        await call(
          fixture.video.id,
          { action: 'join', versionId: fixture.version.id, participantId: guest.participantId },
          cookies
        )
      ).status
    ).toBe(403);
    const identityCookie = joined.headers.get('set-cookie')?.split(';')[0]?.split('=')[1] ?? '';
    expect(
      getGuestIdentityFromRequest(
        apiRequest('/', {
          cookies: {
            ...cookies,
            openframe_guest_identity: identityCookie,
          },
        })
      )
    ).toBeTruthy();
    expect(
      (
        await call(
          fixture.video.id,
          { action: 'join', versionId: fixture.version.id, participantId: guest.participantId },
          { ...cookies, openframe_guest_identity: identityCookie }
        )
      ).status
    ).toBe(200);
    const row = await db.liveReviewParticipant.findUniqueOrThrow({
      where: { id: guest.participantId },
    });
    expect(row.canComment).toBe(true);
    const refresh = () =>
      callRoute(
        refreshAccess,
        apiRequest('/api/internal/live-review/access', {
          body: { participantId: guest.participantId },
          headers: { 'x-live-review-secret': 'test-live-secret' },
        })
      );
    expect((await readData<{ allowed: boolean }>(await refresh())).allowed).toBe(true);
    await db.shareLink.delete({ where: { id: share.id } });
    expect((await readData<{ allowed: boolean }>(await refresh())).allowed).toBe(false);
  });

  it('allows a VIEW guest to follow without comment or presenter eligibility', async () => {
    const fixture = await startFixture();
    const share = await createShareLink({
      projectId: fixture.project.id,
      videoId: fixture.video.id,
      permission: 'VIEW',
    });
    signedOut();
    const joined = await call(
      fixture.video.id,
      { action: 'join', versionId: fixture.version.id },
      {
        [getShareSessionCookieName(fixture.video.id)]: createShareSessionValue(
          share.token,
          fixture.video.id,
          false
        ),
      }
    );
    expect(joined.status).toBe(200);
    const data = await readData<{ participantId: string }>(joined);
    const refreshed = await callRoute(
      refreshAccess,
      apiRequest('/api/internal/live-review/access', {
        body: { participantId: data.participantId },
        headers: { 'x-live-review-secret': 'test-live-secret' },
      })
    );
    expect(await readData<{ allowed: boolean; canComment: boolean }>(refreshed)).toMatchObject({
      allowed: true,
      canComment: false,
    });
  });

  it('preserves active-video uniqueness when two managers start concurrently', async () => {
    const fixture = await seedVersion({ providerId: 'r2' });
    signedInAs(fixture.owner);
    const attempts = await Promise.all([
      call(fixture.video.id, { action: 'start', versionId: fixture.version.id }),
      call(fixture.video.id, { action: 'start', versionId: fixture.version.id }),
    ]);
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await db.liveReviewSession.count({ where: { videoId: fixture.video.id } })).toBe(1);
  });

  it('does not advertise availability when the gateway health check fails', async () => {
    const fixture = await seedVersion({ providerId: 'r2' });
    signedInAs(fixture.owner);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    const discovery = await callRoute(
      GET,
      apiRequest(`/api/videos/${fixture.video.id}/live-review`),
      { videoId: fixture.video.id }
    );
    expect(discovery.status).toBe(200);
    expect(discovery.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await readData<{ available: boolean }>(discovery)).available).toBe(false);
    expect(
      (await call(fixture.video.id, { action: 'start', versionId: fixture.version.id })).status
    ).toBe(503);
    expect(await db.liveReviewSession.count()).toBe(0);
  });
});
