// Bunny download source resolution. Everything the module decides is a
// function of what the CDN answers to a HEAD, so `fetch` is the only boundary
// stubbed here. Urls are asserted in full because they are fully deterministic;
// nothing in this module is signed.
//
// The module keeps a 60 second in-process cache keyed on
// videoId:quality:preference, so every test uses its own video id unless it is
// deliberately exercising the cache.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWithTimeout,
  resolveBunnyCdnHostname,
  resolveBunnyDownloadSource,
} from '@/lib/bunny-download';

const HOST = 'cdn.example.b-cdn.net';

type FetchCall = [string, RequestInit];

let fetchMock: ReturnType<typeof vi.fn>;

function ok(body = ''): Response {
  return { ok: true, status: 200, text: async () => body } as unknown as Response;
}

function notFound(): Response {
  return { ok: false, status: 404, text: async () => '' } as unknown as Response;
}

/**
 * Answer 200 for the listed urls and 404 for everything else. `playlist` is
 * served as the body of any playlist.m3u8 request.
 */
function stubCdn(available: string[], playlist?: string): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/playlist.m3u8')) {
      return playlist === undefined ? notFound() : ok(playlist);
    }
    return available.includes(url) ? ok() : notFound();
  });
}

function requestedUrls(): string[] {
  return (fetchMock.mock.calls as FetchCall[]).map((call) => call[0]);
}

beforeEach(() => {
  fetchMock = vi.fn(async () => notFound());
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('BUNNY_CDN_URL', `https://${HOST}`);
  vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', undefined);
  // These assertions are about unsigned URLs; a key in a developer's .env would sign them.
  vi.stubEnv('BUNNY_CDN_TOKEN_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('resolveBunnyCdnHostname', () => {
  it('reduces a configured url to its hostname', () => {
    expect(resolveBunnyCdnHostname()).toBe(HOST);
  });

  it('drops a path and a trailing slash', () => {
    vi.stubEnv('BUNNY_CDN_URL', `https://${HOST}/some/path/`);

    expect(resolveBunnyCdnHostname()).toBe(HOST);
  });

  it('accepts a bare hostname with no scheme', () => {
    vi.stubEnv('BUNNY_CDN_URL', `${HOST}/`);

    expect(resolveBunnyCdnHostname()).toBe(HOST);
  });

  it('falls back to the public variable', () => {
    vi.stubEnv('BUNNY_CDN_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', `https://${HOST}`);

    expect(resolveBunnyCdnHostname()).toBe(HOST);
  });

  it('returns null when neither variable is set', () => {
    vi.stubEnv('BUNNY_CDN_URL', undefined);

    expect(resolveBunnyCdnHostname()).toBeNull();
  });

  it('returns null for a blank value rather than an empty hostname', () => {
    vi.stubEnv('BUNNY_CDN_URL', '   ');

    expect(resolveBunnyCdnHostname()).toBeNull();
  });
});

describe('with no CDN configured', () => {
  it('resolves to null without making a request', async () => {
    vi.stubEnv('BUNNY_CDN_URL', undefined);

    await expect(resolveBunnyDownloadSource('vid-nohost', null, 'auto')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the original preference', () => {
  it('returns the original url when the CDN has one', async () => {
    stubCdn([`https://${HOST}/vid-orig-1/original`]);

    await expect(resolveBunnyDownloadSource('vid-orig-1', null, 'original')).resolves.toEqual({
      sourceType: 'original',
      quality: null,
      url: `https://${HOST}/vid-orig-1/original`,
    });
  });

  // Asking for the original explicitly means the caller wants the master file
  // or nothing; falling back to a transcode would silently hand back a
  // lower-quality file under the same name.
  it('returns null rather than a transcode when the original is absent', async () => {
    stubCdn([`https://${HOST}/vid-orig-2/play_1080p.mp4`]);

    await expect(resolveBunnyDownloadSource('vid-orig-2', null, 'original')).resolves.toBeNull();
    expect(requestedUrls()).toEqual([`https://${HOST}/vid-orig-2/original`]);
  });

  it('probes with a HEAD that bypasses the cache', async () => {
    stubCdn([`https://${HOST}/vid-orig-3/original`]);

    await resolveBunnyDownloadSource('vid-orig-3', null, 'original');

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'HEAD', cache: 'no-store' });
  });
});

describe('the compressed preference', () => {
  it('never asks for the original', async () => {
    stubCdn([`https://${HOST}/vid-comp-1/original`, `https://${HOST}/vid-comp-1/play_720p.mp4`]);

    const source = await resolveBunnyDownloadSource('vid-comp-1', null, 'compressed');

    expect(source?.sourceType).toBe('compressed');
    expect(requestedUrls().some((url) => url.endsWith('/original'))).toBe(false);
  });

  it('uses the requested quality when that rendition exists', async () => {
    stubCdn([
      `https://${HOST}/vid-comp-2/play_720p.mp4`,
      `https://${HOST}/vid-comp-2/play_1080p.mp4`,
    ]);

    await expect(resolveBunnyDownloadSource('vid-comp-2', 720, 'compressed')).resolves.toEqual({
      sourceType: 'compressed',
      quality: 720,
      url: `https://${HOST}/vid-comp-2/play_720p.mp4`,
    });
  });

  it('falls back to the highest available rendition when the requested one is missing', async () => {
    stubCdn([`https://${HOST}/vid-comp-3/play_480p.mp4`]);

    await expect(resolveBunnyDownloadSource('vid-comp-3', 1080, 'compressed')).resolves.toEqual({
      sourceType: 'compressed',
      quality: 480,
      url: `https://${HOST}/vid-comp-3/play_480p.mp4`,
    });
  });

  it.each([0, -720, Number.NaN])(
    'ignores a requested quality of %s and goes straight to the fallback',
    async (quality) => {
      stubCdn([`https://${HOST}/vid-comp-q${quality}/play_360p.mp4`]);

      const source = await resolveBunnyDownloadSource(
        `vid-comp-q${quality}`,
        quality,
        'compressed'
      );

      expect(source?.quality).toBe(360);
      expect(requestedUrls().some((url) => url.includes(`play_${quality}p`))).toBe(false);
    }
  );

  it('reports an empty url when nothing is available at all', async () => {
    stubCdn([]);

    await expect(resolveBunnyDownloadSource('vid-comp-4', null, 'compressed')).resolves.toEqual({
      sourceType: 'compressed',
      quality: null,
      url: '',
    });
  });

  it('walks the fallback ladder from highest to lowest', async () => {
    stubCdn([]);

    await resolveBunnyDownloadSource('vid-comp-5', null, 'compressed');

    expect(requestedUrls()).toEqual([
      `https://${HOST}/vid-comp-5/playlist.m3u8`,
      `https://${HOST}/vid-comp-5/play_2160p.mp4`,
      `https://${HOST}/vid-comp-5/play_1440p.mp4`,
      `https://${HOST}/vid-comp-5/play_1080p.mp4`,
      `https://${HOST}/vid-comp-5/play_720p.mp4`,
      `https://${HOST}/vid-comp-5/play_480p.mp4`,
      `https://${HOST}/vid-comp-5/play_360p.mp4`,
      `https://${HOST}/vid-comp-5/play_240p.mp4`,
    ]);
  });
});

describe('the playlist hint', () => {
  it('tries the heights the playlist advertises before the static ladder', async () => {
    stubCdn(
      [`https://${HOST}/vid-pl-1/play_720p.mp4`],
      '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\n720.m3u8\n'
    );

    const source = await resolveBunnyDownloadSource('vid-pl-1', null, 'compressed');

    expect(source?.url).toBe(`https://${HOST}/vid-pl-1/play_720p.mp4`);
    // 720 came from the playlist, so it is probed before 2160.
    expect(requestedUrls()[1]).toBe(`https://${HOST}/vid-pl-1/play_720p.mp4`);
  });

  it('sorts the advertised heights from highest to lowest', async () => {
    stubCdn(
      [],
      '#EXT-X-STREAM-INF:RESOLUTION=640x360\na\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\nb\n'
    );

    await resolveBunnyDownloadSource('vid-pl-2', null, 'compressed');

    expect(requestedUrls().slice(1, 3)).toEqual([
      `https://${HOST}/vid-pl-2/play_1080p.mp4`,
      `https://${HOST}/vid-pl-2/play_360p.mp4`,
    ]);
  });

  it('ignores an advertised height that is not a Bunny rendition', async () => {
    stubCdn([], '#EXT-X-STREAM-INF:RESOLUTION=1600x900\na\n');

    await resolveBunnyDownloadSource('vid-pl-3', null, 'compressed');

    expect(requestedUrls().some((url) => url.includes('play_900p'))).toBe(false);
    expect(requestedUrls()[1]).toBe(`https://${HOST}/vid-pl-3/play_2160p.mp4`);
  });

  it('does not probe a playlist height twice when the ladder repeats it', async () => {
    stubCdn([], '#EXT-X-STREAM-INF:RESOLUTION=1920x1080\na\n');

    await resolveBunnyDownloadSource('vid-pl-4', null, 'compressed');

    const probes = requestedUrls().filter((url) => url.includes('play_1080p'));
    expect(probes).toHaveLength(1);
  });

  it('falls back to the static ladder when the playlist request fails', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/playlist.m3u8')) throw new Error('connection reset');
      return url.endsWith('play_1440p.mp4') ? ok() : notFound();
    });

    const source = await resolveBunnyDownloadSource('vid-pl-5', null, 'compressed');

    expect(source?.quality).toBe(1440);
  });
});

describe('the auto preference', () => {
  it('prefers the original when the CDN has one', async () => {
    stubCdn([`https://${HOST}/vid-auto-1/original`, `https://${HOST}/vid-auto-1/play_1080p.mp4`]);

    const source = await resolveBunnyDownloadSource('vid-auto-1', null, 'auto');

    expect(source).toEqual({
      sourceType: 'original',
      quality: null,
      url: `https://${HOST}/vid-auto-1/original`,
    });
    expect(requestedUrls()).toEqual([`https://${HOST}/vid-auto-1/original`]);
  });

  it('falls through to a transcode when there is no original', async () => {
    stubCdn([`https://${HOST}/vid-auto-2/play_1080p.mp4`]);

    await expect(resolveBunnyDownloadSource('vid-auto-2', null, 'auto')).resolves.toEqual({
      sourceType: 'compressed',
      quality: 1080,
      url: `https://${HOST}/vid-auto-2/play_1080p.mp4`,
    });
  });

  it('honours the requested quality on the fall-through path', async () => {
    stubCdn([
      `https://${HOST}/vid-auto-3/play_480p.mp4`,
      `https://${HOST}/vid-auto-3/play_1080p.mp4`,
    ]);

    const source = await resolveBunnyDownloadSource('vid-auto-3', 480, 'auto');

    expect(source?.url).toBe(`https://${HOST}/vid-auto-3/play_480p.mp4`);
  });
});

describe('availability probing', () => {
  it('retries with a ranged GET when the CDN refuses HEAD', async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === 'HEAD') return { ok: false, status: 405 } as unknown as Response;
      return { ok: false, status: 206 } as unknown as Response;
    });

    const source = await resolveBunnyDownloadSource('vid-probe-1', null, 'original');

    expect(source?.url).toBe(`https://${HOST}/vid-probe-1/original`);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
    });
  });

  it('accepts a plain 200 on the ranged retry too', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      init.method === 'HEAD'
        ? ({ ok: false, status: 405 } as unknown as Response)
        : ({ ok: true, status: 200 } as unknown as Response)
    );

    const source = await resolveBunnyDownloadSource('vid-probe-2', null, 'original');

    expect(source).not.toBeNull();
  });

  it('treats the file as absent when the ranged retry also fails', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      init.method === 'HEAD'
        ? ({ ok: false, status: 405 } as unknown as Response)
        : ({ ok: false, status: 403 } as unknown as Response)
    );

    await expect(resolveBunnyDownloadSource('vid-probe-3', null, 'original')).resolves.toBeNull();
  });

  it('does not retry a status other than 405', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 } as unknown as Response);

    await resolveBunnyDownloadSource('vid-probe-4', null, 'original');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a rejected probe as absent rather than propagating it', async () => {
    fetchMock.mockRejectedValue(new Error('dns failure'));

    await expect(resolveBunnyDownloadSource('vid-probe-5', null, 'original')).resolves.toBeNull();
  });
});

describe('the resolution cache', () => {
  it('serves a repeat lookup without touching the CDN again', async () => {
    stubCdn([`https://${HOST}/vid-cache-1/original`]);

    const first = await resolveBunnyDownloadSource('vid-cache-1', null, 'auto');
    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await resolveBunnyDownloadSource('vid-cache-1', null, 'auto');

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it('caches a negative result so a missing original is not re-probed', async () => {
    stubCdn([]);

    await resolveBunnyDownloadSource('vid-cache-2', null, 'original');
    const callsAfterFirst = fetchMock.mock.calls.length;
    await expect(resolveBunnyDownloadSource('vid-cache-2', null, 'original')).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it('keys the cache on the preference', async () => {
    stubCdn([`https://${HOST}/vid-cache-3/play_720p.mp4`]);

    await resolveBunnyDownloadSource('vid-cache-3', null, 'original');
    const callsAfterFirst = fetchMock.mock.calls.length;
    await resolveBunnyDownloadSource('vid-cache-3', null, 'compressed');

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('keys the cache on the requested quality', async () => {
    stubCdn([
      `https://${HOST}/vid-cache-4/play_720p.mp4`,
      `https://${HOST}/vid-cache-4/play_1080p.mp4`,
    ]);

    const low = await resolveBunnyDownloadSource('vid-cache-4', 720, 'compressed');
    const high = await resolveBunnyDownloadSource('vid-cache-4', 1080, 'compressed');

    expect(low?.quality).toBe(720);
    expect(high?.quality).toBe(1080);
  });

  it('re-probes once the sixty second window has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T00:00:00.000Z'));
    stubCdn([`https://${HOST}/vid-cache-5/original`]);

    await resolveBunnyDownloadSource('vid-cache-5', null, 'original');
    const callsAfterFirst = fetchMock.mock.calls.length;

    vi.setSystemTime(new Date('2026-01-15T00:01:00.001Z'));
    await resolveBunnyDownloadSource('vid-cache-5', null, 'original');

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('still serves from the cache one millisecond before expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T00:00:00.000Z'));
    stubCdn([`https://${HOST}/vid-cache-6/original`]);

    await resolveBunnyDownloadSource('vid-cache-6', null, 'original');
    const callsAfterFirst = fetchMock.mock.calls.length;

    vi.setSystemTime(new Date('2026-01-15T00:00:59.999Z'));
    await resolveBunnyDownloadSource('vid-cache-6', null, 'original');

    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst);
  });
});

describe('fetchWithTimeout', () => {
  it('passes an abort signal through to fetch', async () => {
    fetchMock.mockResolvedValue(ok());

    await fetchWithTimeout('https://example.com/a', { method: 'HEAD' });

    const init = (fetchMock.mock.calls[0] as FetchCall)[1];
    expect(init.method).toBe('HEAD');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a request that has not answered within eight seconds', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    // Never settles, so the only thing that can end the request is the timeout.
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise(() => {});
    });

    void fetchWithTimeout('https://example.com/slow', {});

    await vi.advanceTimersByTimeAsync(7999);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
  });

  it('does not abort a request that answered in time', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return ok();
    });

    await fetchWithTimeout('https://example.com/fast', {});
    await vi.advanceTimersByTimeAsync(20_000);

    expect(signal?.aborted).toBe(false);
  });
});
