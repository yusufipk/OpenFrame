import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bucketedExpiry,
  canonicalBunnyThumbnailUrl,
  computeBunnyToken,
  signBunnyVideoDirectory,
  signBunnyVideoFileUrl,
  signBunnyThumbnail,
  thumbnailTokenBucket,
  withSignedThumbnail,
} from '@/lib/bunny-cdn-token';

// Expected tokens are copied by hand from Bunny's reference signer tests
// (github.com/BunnyWay/BunnyCDN.TokenAuthentication, nodejs/token.test.js), so a
// change to the hash input, its order or the encoding fails here rather than at
// the CDN.
const REFERENCE_KEY = 'SecurityKey';
const REFERENCE_EXPIRES = 1598024587;

const GUID = 'c5b49497-6911-46f2-b17b-2d7de0460ee6';
const KEY = 'test-pull-zone-key';
// 2026-10-01T10:20:00Z
const NOW_MS = Date.UTC(2026, 9, 1, 10, 20, 0);

describe('computeBunnyToken', () => {
  it('matches the reference vector for a path-scoped token', () => {
    expect(
      computeBunnyToken(REFERENCE_KEY, '/abc', REFERENCE_EXPIRES, { token_path: '/abc' })
    ).toBe('HS256-uVZvT3SbEoVKYJyDJgbcsDmSFf73cv-uNUVaJiKWpbQ');
  });

  it('matches the reference vector for an ignore-params token', () => {
    expect(
      computeBunnyToken(REFERENCE_KEY, '/300kb.jpg', REFERENCE_EXPIRES, {
        token_ignore_params: 'true',
      })
    ).toBe('HS256-1lwWBD_c1IAGSj1UKPoxreu8ePDQ-Z9FoWLcRn_RRH0');
  });

  it('matches the reference vector for a bare directory token', () => {
    expect(computeBunnyToken(REFERENCE_KEY, '/abc/', REFERENCE_EXPIRES, {})).toBe(
      'HS256-bTMv4RVOkjx2UXLfVDl-JIygaxfSIQP8UCnCy7CILuY'
    );
  });

  // Not a published vector: the parameter set every player URL is signed with. It
  // was computed with an independent Python HMAC that reproduces the published ones
  // above, and it is the only case that pins how two parameters are sorted and joined.
  it('joins two sorted parameters with an ampersand, as a directory token needs', () => {
    expect(
      computeBunnyToken(REFERENCE_KEY, '/abc/', REFERENCE_EXPIRES, {
        token_path: '/abc/',
        token_ignore_params: 'true',
      })
    ).toBe('HS256-OJmRfUK9LTPOp2ODB5UI3ERnvp2tSWdAqV_LhCG6dSY');
  });
});

describe('bucketedExpiry', () => {
  it('rounds up to the next whole hour after the minimum lifetime', () => {
    // 10:20 + 1h = 11:20, rounded up to 12:00.
    expect(bucketedExpiry(NOW_MS, 3600)).toBe(Date.UTC(2026, 9, 1, 12, 0, 0) / 1000);
  });

  it('stays the same for every request within one clock hour', () => {
    const early = bucketedExpiry(Date.UTC(2026, 9, 1, 10, 0, 1), 3600);
    const late = bucketedExpiry(Date.UTC(2026, 9, 1, 10, 59, 59), 3600);
    expect(early).toBe(late);
  });
});

describe('with a token key configured', () => {
  beforeEach(() => {
    vi.stubEnv('BUNNY_CDN_URL', 'https://vz-test.b-cdn.net');
    vi.stubEnv('BUNNY_CDN_TOKEN_KEY', KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('signs a directory token in path form that covers only this video', () => {
    const signed = signBunnyVideoDirectory(GUID, { nowMs: NOW_MS, ttlSeconds: 6 * 3600 });
    // 10:20 + 6h = 16:20, rounded up to 17:00.
    const expires = Date.UTC(2026, 9, 1, 17, 0, 0) / 1000;
    const token = computeBunnyToken(KEY, `/${GUID}/`, expires, {
      token_ignore_params: 'true',
      token_path: `/${GUID}/`,
    });

    expect(signed).toEqual({
      baseUrl: `https://vz-test.b-cdn.net/bcdn_token=${token}&token_ignore_params=true&token_path=%2F${GUID}%2F&expires=${expires}/${GUID}/`,
      expiresAt: expires,
    });
  });

  it('does not produce the same token under a different key', () => {
    const signed = signBunnyVideoDirectory(GUID, { nowMs: NOW_MS });
    vi.stubEnv('BUNNY_CDN_TOKEN_KEY', 'another-key');
    expect(signBunnyVideoDirectory(GUID, { nowMs: NOW_MS })?.baseUrl).not.toBe(signed?.baseUrl);
  });

  it.each(['', '../other', 'a/b', '%2F', 'x'.repeat(129), 'a.b'])(
    'refuses to sign the video id %j, which would widen the directory scope',
    (videoId) => {
      expect(signBunnyVideoDirectory(videoId, { nowMs: NOW_MS })).toBeNull();
      expect(signBunnyVideoFileUrl(videoId, 'original', { nowMs: NOW_MS })).toBeNull();
    }
  );

  it('signs a single file in query form with a short lifetime', () => {
    const url = signBunnyVideoFileUrl(GUID, 'play_720p.mp4', { nowMs: NOW_MS, ttlSeconds: 900 });
    const expires = NOW_MS / 1000 + 900;
    const token = computeBunnyToken(KEY, `/${GUID}/play_720p.mp4`, expires, {
      token_ignore_params: 'true',
    });
    expect(url).toBe(
      `https://vz-test.b-cdn.net/${GUID}/play_720p.mp4?token=${token}&token_ignore_params=true&expires=${expires}`
    );
  });

  it('gives a download URL one hour by default', () => {
    const url = signBunnyVideoFileUrl(GUID, 'original', { nowMs: NOW_MS });
    expect(url).toContain(`&expires=${NOW_MS / 1000 + 3600}`);
  });

  it('refuses to sign a thumbnail for an own id that is not a plain Bunny id', () => {
    expect(
      signBunnyThumbnail(`https://vz-test.b-cdn.net/${GUID}/thumbnail.jpg`, '../x')
    ).toBeNull();
    expect(signBunnyThumbnail(`https://vz-test.b-cdn.net/${GUID}/thumbnail.jpg`, '')).toBeNull();
  });

  it('matches the pull zone host however the configured value is capitalised', () => {
    vi.stubEnv('BUNNY_CDN_URL', 'VZ-Test.b-cdn.net');
    expect(
      signBunnyThumbnail(`https://vz-test.b-cdn.net/${GUID}/thumbnail.jpg`, GUID)?.includes(
        '?token=HS256-'
      )
    ).toBe(true);
  });

  it('reports the hour bucket the thumbnail tokens expire in', () => {
    expect(thumbnailTokenBucket(NOW_MS)).toBe(Date.UTC(2026, 9, 1, 23, 0, 0) / 1000);
  });

  it('refuses a file name that is not a plain file name', () => {
    expect(signBunnyVideoFileUrl(GUID, '../secret', { nowMs: NOW_MS })).toBeNull();
  });

  it("signs a Bunny row's own thumbnail with an hour-rounded expiry", () => {
    const url = signBunnyThumbnail(`https://vz-test.b-cdn.net/${GUID}/thumbnail.jpg`, GUID, NOW_MS);
    // 10:20 + 12h = 22:20, rounded up to 23:00.
    const expires = Date.UTC(2026, 9, 1, 23, 0, 0) / 1000;
    const token = computeBunnyToken(KEY, `/${GUID}/thumbnail.jpg`, expires, {
      token_ignore_params: 'true',
    });
    expect(url).toBe(
      `https://vz-test.b-cdn.net/${GUID}/thumbnail.jpg?token=${token}&token_ignore_params=true&expires=${expires}`
    );
  });

  it("signs the row's own thumbnail, never the path the stored URL names", () => {
    const victim = 'a1b2c3d4-0000-4000-8000-000000000001';
    const url = signBunnyThumbnail(`https://vz-test.b-cdn.net/${victim}/original`, GUID, NOW_MS);
    expect(url).toBe(
      signBunnyThumbnail(`https://vz-test.b-cdn.net/${GUID}/thumbnail.jpg`, GUID, NOW_MS)
    );
    expect(url).not.toContain(victim);
    expect(url).not.toContain('/original');
  });

  it('drops a pull-zone URL on a row that has no Bunny id of its own', () => {
    const victim = 'a1b2c3d4-0000-4000-8000-000000000001';
    expect(signBunnyThumbnail(`https://vz-test.b-cdn.net/${victim}/original`, null)).toBeNull();
    expect(
      signBunnyThumbnail(`https://vz-thumbnail.b-cdn.net/${victim}/thumbnail.jpg`, null)
    ).toBeNull();
  });

  it('signs only Bunny versions, by their own video id', () => {
    const victim = 'a1b2c3d4-0000-4000-8000-000000000001';
    const planted = `https://vz-test.b-cdn.net/${victim}/original`;
    expect(
      withSignedThumbnail({ thumbnailUrl: planted, providerId: 'youtube', videoId: victim })
        .thumbnailUrl
    ).toBeNull();
    expect(
      withSignedThumbnail({ thumbnailUrl: planted, providerId: 'bunny', videoId: GUID }, NOW_MS)
        .thumbnailUrl
    ).toBe(signBunnyThumbnail(`https://vz-test.b-cdn.net/${GUID}/thumbnail.jpg`, GUID, NOW_MS));
  });

  it('moves a thumbnail on the legacy shared host onto the pull zone and signs it', () => {
    const url = signBunnyThumbnail(`https://vz-thumbnail.b-cdn.net/${GUID}/thumbnail.jpg`, GUID);
    expect(url?.startsWith(`https://vz-test.b-cdn.net/${GUID}/thumbnail.jpg?token=HS256-`)).toBe(
      true
    );
  });

  it('leaves thumbnails on other hosts and app paths untouched', () => {
    // Two path segments, the same shape as a pull-zone thumbnail, so only the host
    // check keeps it from being rewritten.
    expect(signBunnyThumbnail('https://i.vimeocdn.com/video/123_640.jpg', null)).toBe(
      'https://i.vimeocdn.com/video/123_640.jpg'
    );
    expect(signBunnyThumbnail('/api/upload/image/x.png', null)).toBe('/api/upload/image/x.png');
    expect(signBunnyThumbnail(null, GUID)).toBeNull();
  });

  it('stores the canonical thumbnail without any token', () => {
    expect(canonicalBunnyThumbnailUrl(GUID)).toBe(
      `https://vz-test.b-cdn.net/${GUID}/thumbnail.jpg`
    );
  });
});

describe('without a token key', () => {
  beforeEach(() => {
    vi.stubEnv('BUNNY_CDN_URL', 'vz-test.b-cdn.net');
    vi.stubEnv('BUNNY_CDN_TOKEN_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns plain URLs that never expire, as before signing existed', () => {
    expect(signBunnyVideoDirectory(GUID)).toEqual({
      baseUrl: `https://vz-test.b-cdn.net/${GUID}/`,
      expiresAt: null,
    });
    expect(signBunnyVideoFileUrl(GUID, 'original')).toBe(
      `https://vz-test.b-cdn.net/${GUID}/original`
    );
    expect(thumbnailTokenBucket(NOW_MS)).toBe(0);
    expect(signBunnyThumbnail(`https://vz-test.b-cdn.net/${GUID}/thumbnail.jpg`, GUID)).toBe(
      `https://vz-test.b-cdn.net/${GUID}/thumbnail.jpg`
    );
  });
});
