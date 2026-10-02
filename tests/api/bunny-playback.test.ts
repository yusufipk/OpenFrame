// Signed Bunny CDN URLs: who gets one, and what the stored rows look like.
//
// The CDN serves anything under a valid token, so these routes are the only place
// OpenFrame's access rules are applied to Bunny media. Where a refusal could also
// come from a malformed request, it is paired with a success on the same fixture,
// so the 404 or 403 can only have come from the access check.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoAssetKind, VideoAssetProvider } from '@prisma/client';
import { db } from '@/lib/db';
import { GET as versionPlayback } from '@/app/api/versions/[versionId]/playback/route';
import { GET as assetPlayback } from '@/app/api/videos/[videoId]/assets/[assetId]/playback/route';
import { GET as listVideos, POST as addVideo } from '@/app/api/projects/[projectId]/videos/route';
import { POST as addVersion } from '@/app/api/projects/[projectId]/videos/[videoId]/versions/route';
import { GET as listAssets } from '@/app/api/videos/[videoId]/assets/route';
import { createBunnyUploadToken } from '@/lib/bunny-upload-token';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createExpiredUser,
  createShareLink,
  createUser,
  createVersion,
  createVideo,
  createVideoAsset,
  nextSeq,
  seedProject,
} from '../factories';

const CDN = 'https://vz-test.b-cdn.net';
const KEY = 'test-pull-zone-key';

function guid(): string {
  return `c5b49497-6911-46f2-b17b-${String(nextSeq()).padStart(12, '0')}`;
}

function shareCookie(videoId: string, token: string) {
  return { [getShareSessionCookieName(videoId)]: createShareSessionValue(token, videoId, false) };
}

async function seedBunnyVersion(input: { allowDownloads?: boolean } = {}) {
  const scenario = await seedProject({
    visibility: 'PRIVATE',
    allowDownloads: input.allowDownloads ?? false,
  });
  const bunnyId = guid();
  const video = await createVideo({ projectId: scenario.project.id });
  const version = await createVersion({
    videoParentId: video.id,
    providerId: 'bunny',
    providerVideoId: bunnyId,
    originalUrl: `https://iframe.mediadelivery.net/embed/1/${bunnyId}`,
    thumbnailUrl: `${CDN}/${bunnyId}/thumbnail.jpg`,
  });
  return { ...scenario, video, version, bunnyId };
}

function playVersion(versionId: string, cookies?: Record<string, string>) {
  return callRoute(
    versionPlayback,
    apiRequest(`/api/versions/${versionId}/playback`, { method: 'GET', cookies }),
    { versionId }
  );
}

function expectSignedBase(baseUrl: unknown, bunnyId: string) {
  expect(typeof baseUrl).toBe('string');
  const url = baseUrl as string;
  expect(url.startsWith(`${CDN}/bcdn_token=HS256-`)).toBe(true);
  expect(url).toContain(`token_path=%2F${bunnyId}%2F`);
  expect(url.endsWith(`/${bunnyId}/`)).toBe(true);
}

beforeEach(() => {
  vi.stubEnv('BUNNY_CDN_URL', CDN);
  vi.stubEnv('BUNNY_CDN_TOKEN_KEY', KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/versions/[versionId]/playback', () => {
  it('refuses an anonymous caller without saying whether the version exists', async () => {
    const fixture = await seedBunnyVersion();
    signedOut();

    const response = await playVersion(fixture.version.id);

    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('bcdn_token');
  });

  it('refuses a signed-in stranger, and the owner gets a URL for the same version', async () => {
    const fixture = await seedBunnyVersion();
    signedInAs(await createUser());
    const refused = await playVersion(fixture.version.id);
    expect(refused.status).toBe(404);

    signedInAs(fixture.owner);
    const allowed = await playVersion(fixture.version.id);
    expect(allowed.status).toBe(200);
    expectSignedBase((await readData(allowed)).baseUrl, fixture.bunnyId);
  });

  it('signs for a project member and scopes the token to that one video', async () => {
    const fixture = await seedBunnyVersion();
    const member = await createUser();
    await addProjectMember({ projectId: fixture.project.id, userId: member.id });
    signedInAs(member);

    const response = await playVersion(fixture.version.id);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const data = await readData(response);
    expectSignedBase(data.baseUrl, fixture.bunnyId);
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(data.expiresAt).toBeGreaterThanOrEqual(nowSeconds + 6 * 3600);
    expect(data.expiresAt).toBeLessThanOrEqual(nowSeconds + 7 * 3600);
  });

  it('answers 403 to an owner whose billing lapsed, who already knows the id', async () => {
    const owner = await createExpiredUser();
    const scenario = await seedProject({ ownerUser: owner, visibility: 'PRIVATE' });
    const bunnyId = guid();
    const video = await createVideo({ projectId: scenario.project.id });
    const version = await createVersion({
      videoParentId: video.id,
      providerId: 'bunny',
      providerVideoId: bunnyId,
    });
    signedInAs(owner);

    const response = await playVersion(version.id);

    expect(response.status).toBe(403);
  });

  it('signs for an anonymous viewer holding a share session for that video', async () => {
    const fixture = await seedBunnyVersion();
    const link = await createShareLink({
      projectId: fixture.project.id,
      videoId: fixture.video.id,
    });
    signedOut();

    const response = await playVersion(
      fixture.version.id,
      shareCookie(fixture.video.id, link.token)
    );

    expect(response.status).toBe(200);
    expectSignedBase((await readData(response)).baseUrl, fixture.bunnyId);
  });

  it('refuses a share session whose link has since been deleted', async () => {
    const fixture = await seedBunnyVersion();
    const link = await createShareLink({
      projectId: fixture.project.id,
      videoId: fixture.video.id,
    });
    await db.shareLink.delete({ where: { id: link.id } });
    signedOut();

    const response = await playVersion(
      fixture.version.id,
      shareCookie(fixture.video.id, link.token)
    );

    expect(response.status).toBe(404);
  });

  it('refuses a share session for a different video in the same project', async () => {
    const fixture = await seedBunnyVersion();
    const otherVideo = await createVideo({ projectId: fixture.project.id });
    const link = await createShareLink({ projectId: fixture.project.id, videoId: otherVideo.id });
    signedOut();

    // The cookie is valid for the other video; presenting it under this video's
    // cookie name is the only way to put it in front of this route.
    const response = await playVersion(
      fixture.version.id,
      shareCookie(fixture.video.id, link.token)
    );

    expect(response.status).toBe(404);
  });

  it('turns away a non-Bunny version only after the access check', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE' });
    const video = await createVideo({ projectId: scenario.project.id });
    const version = await createVersion({ videoParentId: video.id, providerId: 'youtube' });

    signedOut();
    expect((await playVersion(version.id)).status).toBe(404);

    signedInAs(scenario.owner);
    expect((await playVersion(version.id)).status).toBe(400);
  });

  it('hands out a plain URL when no token key is configured', async () => {
    vi.stubEnv('BUNNY_CDN_TOKEN_KEY', '');
    const fixture = await seedBunnyVersion();
    signedInAs(fixture.owner);

    const data = await readData(await playVersion(fixture.version.id));

    expect(data).toEqual({ baseUrl: `${CDN}/${fixture.bunnyId}/`, expiresAt: null });
  });
});

describe('GET /api/videos/[videoId]/assets/[assetId]/playback', () => {
  async function seedBunnyAsset(allowDownloads: boolean) {
    const fixture = await seedBunnyVersion({ allowDownloads });
    const assetBunnyId = guid();
    const asset = await createVideoAsset({
      videoId: fixture.video.id,
      billedUserId: fixture.owner.id,
      kind: VideoAssetKind.VIDEO,
      provider: VideoAssetProvider.BUNNY,
      sourceUrl: `https://iframe.mediadelivery.net/embed/1/${assetBunnyId}`,
      providerVideoId: assetBunnyId,
    });
    return { ...fixture, asset, assetBunnyId };
  }

  function playAsset(videoId: string, assetId: string) {
    return callRoute(
      assetPlayback,
      apiRequest(`/api/videos/${videoId}/assets/${assetId}/playback`, { method: 'GET' }),
      { videoId, assetId }
    );
  }

  it('refuses an anonymous caller', async () => {
    const fixture = await seedBunnyAsset(true);
    signedOut();

    expect((await playAsset(fixture.video.id, fixture.asset.id)).status).toBe(404);
  });

  it('refuses a commentator while downloads are off and signs once they are on', async () => {
    const fixture = await seedBunnyAsset(false);
    const member = await createUser();
    await addProjectMember({ projectId: fixture.project.id, userId: member.id });
    signedInAs(member);

    expect((await playAsset(fixture.video.id, fixture.asset.id)).status).toBe(403);

    await db.project.update({
      where: { id: fixture.project.id },
      data: { allowDownloads: true },
    });
    const allowed = await playAsset(fixture.video.id, fixture.asset.id);
    expect(allowed.status).toBe(200);
    expectSignedBase((await readData(allowed)).baseUrl, fixture.assetBunnyId);
  });

  it('does not sign an asset reached through another video id', async () => {
    const fixture = await seedBunnyAsset(true);
    const other = await createVideo({ projectId: fixture.project.id });
    signedInAs(fixture.owner);

    expect((await playAsset(other.id, fixture.asset.id)).status).toBe(404);
  });

  it('turns away a non-Bunny asset', async () => {
    const fixture = await seedBunnyVersion({ allowDownloads: true });
    const asset = await createVideoAsset({
      videoId: fixture.video.id,
      billedUserId: fixture.owner.id,
    });
    signedInAs(fixture.owner);

    expect((await playAsset(fixture.video.id, asset.id)).status).toBe(400);
  });
});

describe('Bunny thumbnails', () => {
  it('are signed in the video list', async () => {
    const fixture = await seedBunnyVersion();
    signedInAs(fixture.owner);

    const response = await callRoute(
      listVideos,
      apiRequest(`/api/projects/${fixture.project.id}/videos`, { method: 'GET' }),
      { projectId: fixture.project.id }
    );

    expect(response.status).toBe(200);
    const { videos } = await readData(response);
    const thumbnail: string = videos[0].versions[0].thumbnailUrl;
    expect(thumbnail.startsWith(`${CDN}/${fixture.bunnyId}/thumbnail.jpg?token=HS256-`)).toBe(true);
  });

  it('are never signed for a path planted on a non-Bunny row', async () => {
    // A row written before the create routes refused this, pointing a YouTube
    // version's thumbnail at somebody else's original upload.
    const scenario = await seedProject();
    const victimId = guid();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVersion({
      videoParentId: video.id,
      providerId: 'youtube',
      thumbnailUrl: `${CDN}/${victimId}/original`,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      listVideos,
      apiRequest(`/api/projects/${scenario.project.id}/videos`, { method: 'GET' }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);
    const { videos } = await readData(response);
    expect(videos[0].versions[0].thumbnailUrl).toBeNull();
    expect(JSON.stringify(videos)).not.toContain('token=');
  });

  it('cannot be pointed at the pull zone by a client creating a non-Bunny video', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      addVideo,
      apiRequest(`/api/projects/${scenario.project.id}/videos`, {
        body: {
          title: 'Planted',
          videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          videoId: 'dQw4w9WgXcQ',
          thumbnailUrl: `${CDN}/${guid()}/original`,
        },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(400);
    expect(await db.video.count({ where: { projectId: scenario.project.id } })).toBe(0);
  });

  it('are derived by the server when a Bunny version is added, ignoring the client value', async () => {
    vi.stubEnv('BUNNY_UPLOAD_TOKEN_SECRET', 'test-bunny-upload-token-secret');
    const fixture = await seedBunnyVersion();
    const bunnyId = guid();
    const uploadToken = createBunnyUploadToken({
      userId: fixture.owner.id,
      projectId: fixture.project.id,
      videoId: bunnyId,
    });
    signedInAs(fixture.owner);

    const response = await callRoute(
      addVersion,
      apiRequest(`/api/projects/${fixture.project.id}/videos/${fixture.video.id}/versions`, {
        body: {
          providerId: 'bunny',
          videoUrl: `https://iframe.mediadelivery.net/embed/1/${bunnyId}`,
          providerVideoId: bunnyId,
          uploadToken,
          thumbnailUrl: `${CDN}/${fixture.bunnyId}/original`,
        },
      }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(201);
    const stored = await db.videoVersion.findFirstOrThrow({ where: { videoId: bunnyId } });
    expect(stored.thumbnailUrl).toBe(`${CDN}/${bunnyId}/thumbnail.jpg`);
  });

  it('are derived by the server when a Bunny video is created, ignoring the client value', async () => {
    vi.stubEnv('BUNNY_UPLOAD_TOKEN_SECRET', 'test-bunny-upload-token-secret');
    const scenario = await seedProject();
    const bunnyId = guid();
    const uploadToken = createBunnyUploadToken({
      userId: scenario.owner.id,
      projectId: scenario.project.id,
      videoId: bunnyId,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      addVideo,
      apiRequest(`/api/projects/${scenario.project.id}/videos`, {
        body: {
          title: 'Bunny cut',
          providerId: 'bunny',
          videoUrl: `https://iframe.mediadelivery.net/embed/1/${bunnyId}`,
          videoId: bunnyId,
          uploadToken,
          // A signed URL echoed back would expire in the database.
          thumbnailUrl: `${CDN}/${bunnyId}/thumbnail.jpg?token=HS256-x&expires=1`,
        },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(201);
    const stored = await db.videoVersion.findFirstOrThrow({ where: { videoId: bunnyId } });
    expect(stored.thumbnailUrl).toBe(`${CDN}/${bunnyId}/thumbnail.jpg`);
    const created = await readData(response);
    expect(created.versions[0].thumbnailUrl).toContain('?token=HS256-');
  });

  it('cannot be pointed at the pull zone by a client adding a non-Bunny version', async () => {
    const fixture = await seedBunnyVersion();
    signedInAs(fixture.owner);

    const response = await callRoute(
      addVersion,
      apiRequest(`/api/projects/${fixture.project.id}/videos/${fixture.video.id}/versions`, {
        body: {
          videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          providerVideoId: 'dQw4w9WgXcQ',
          thumbnailUrl: `${CDN}/${guid()}/original`,
        },
      }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(400);
    expect(await db.videoVersion.count({ where: { videoParentId: fixture.video.id } })).toBe(1);
  });

  it('are signed for a Bunny asset and dropped for a pull-zone URL on any other asset', async () => {
    const fixture = await seedBunnyVersion({ allowDownloads: true });
    const assetBunnyId = guid();
    const bunnyAsset = await createVideoAsset({
      videoId: fixture.video.id,
      billedUserId: fixture.owner.id,
      kind: VideoAssetKind.VIDEO,
      provider: VideoAssetProvider.BUNNY,
      sourceUrl: `https://iframe.mediadelivery.net/embed/1/${assetBunnyId}`,
      providerVideoId: assetBunnyId,
      thumbnailUrl: `${CDN}/${assetBunnyId}/thumbnail.jpg`,
    });
    const planted = await createVideoAsset({
      videoId: fixture.video.id,
      billedUserId: fixture.owner.id,
      kind: VideoAssetKind.VIDEO,
      provider: VideoAssetProvider.YOUTUBE,
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      providerVideoId: 'dQw4w9WgXcQ',
      thumbnailUrl: `${CDN}/${fixture.bunnyId}/original`,
    });
    signedInAs(fixture.owner);

    const response = await callRoute(
      listAssets,
      apiRequest(`/api/videos/${fixture.video.id}/assets`, { method: 'GET' }),
      { videoId: fixture.video.id }
    );

    expect(response.status).toBe(200);
    const { assets } = await readData(response);
    const byId = new Map(assets.map((asset: { id: string }) => [asset.id, asset]));
    expect(
      (byId.get(bunnyAsset.id) as { thumbnailUrl: string }).thumbnailUrl.startsWith(
        `${CDN}/${assetBunnyId}/thumbnail.jpg?token=HS256-`
      )
    ).toBe(true);
    expect((byId.get(planted.id) as { thumbnailUrl: string | null }).thumbnailUrl).toBeNull();
  });

  it('give the asset list a new ETag when the thumbnail tokens roll over', async () => {
    const fixture = await seedBunnyVersion({ allowDownloads: true });
    signedInAs(fixture.owner);
    const list = (ifNoneMatch?: string) =>
      callRoute(
        listAssets,
        apiRequest(`/api/videos/${fixture.video.id}/assets`, {
          method: 'GET',
          headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {},
        }),
        { videoId: fixture.video.id }
      );

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 1, 10, 5, 0));
      const first = await list();
      const etag = first.headers.get('etag') ?? '';
      expect(etag).not.toBe('');
      // Same hour, nothing changed: the cached copy is still valid.
      vi.setSystemTime(Date.UTC(2026, 9, 1, 10, 55, 0));
      expect((await list(etag)).status).toBe(304);
      // Next hour: the signed thumbnails differ, so the cache must not be reused.
      vi.setSystemTime(Date.UTC(2026, 9, 1, 11, 5, 0));
      expect((await list(etag)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
