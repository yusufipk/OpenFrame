// Orphan deletion on the Bunny side. Every assertion here is really the same
// question asked from a different angle: does this module ever issue a DELETE
// for something it was not handed as a live Bunny reference?

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BunnyVideoRef,
  cleanupBunnyStreamVideos,
  cleanupBunnyStreamVideosBestEffort,
} from '@/lib/bunny-stream-cleanup';

let fetchMock: ReturnType<typeof vi.fn>;

function deletedIds(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]).split('/videos/')[1]);
}

function bunnyRefs(...videoIds: string[]): BunnyVideoRef[] {
  return videoIds.map((videoId) => ({ providerId: 'bunny', videoId }));
}

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('BUNNY_STREAM_API_KEY', 'bunny-api-key-unit');
  vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '4242');
  vi.stubEnv('NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('which references get deleted', () => {
  // The provider filter is the safety net. A reference that belongs to another
  // provider names a live object somewhere else; deleting it by Bunny id would
  // be meaningless at best, and the same guard is what stops a caller passing a
  // mixed list from wiping rows it only meant to inspect.
  it.each(['r2', 'youtube', 'direct', 'BUNNY', ''])(
    'never deletes a reference whose provider is %s',
    async (providerId) => {
      const result = await cleanupBunnyStreamVideosBestEffort([
        { providerId, videoId: 'live-video-id-1' },
      ]);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toEqual({ attempted: 0, failed: 0, failedIds: [] });
    }
  );

  it('deletes only the Bunny references out of a mixed list', async () => {
    await cleanupBunnyStreamVideosBestEffort([
      { providerId: 'r2', videoId: 'r2-object-key-1' },
      { providerId: 'bunny', videoId: 'bunny-video-id-1' },
      { providerId: 'youtube', videoId: 'dQw4w9WgXcQ' },
    ]);

    expect(deletedIds()).toEqual(['bunny-video-id-1']);
  });

  it('does nothing at all for an empty list', async () => {
    const result = await cleanupBunnyStreamVideosBestEffort([]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 0, failed: 0, failedIds: [] });
  });

  it('skips a Bunny reference with an empty video id', async () => {
    const result = await cleanupBunnyStreamVideosBestEffort(bunnyRefs(''));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.attempted).toBe(0);
  });

  // The id goes straight into the request path, so anything that is not the
  // Bunny guid alphabet is dropped rather than sent.
  it.each([
    ['too short', 'abc1234'],
    ['a path traversal', '../../library/1/videos/other'],
    ['a slash', 'bunny/video'],
    ['a space', 'bunny video id'],
    ['a wildcard', '*'],
    ['a sql fragment', "abcdefgh'; DROP TABLE videos; --"],
    ['over 128 characters', 'a'.repeat(129)],
  ])('skips an id containing %s', async (_label, videoId) => {
    const result = await cleanupBunnyStreamVideosBestEffort(bunnyRefs(videoId));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 0, failed: 0, failedIds: [] });
  });

  it.each([8, 128])('accepts an id of exactly %i characters', async (length) => {
    await cleanupBunnyStreamVideosBestEffort(bunnyRefs('a'.repeat(length)));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('trims surrounding whitespace before validating and sending', async () => {
    await cleanupBunnyStreamVideosBestEffort(bunnyRefs('  bunny-video-id-1  '));

    expect(deletedIds()).toEqual(['bunny-video-id-1']);
  });

  it('deletes a repeated id once', async () => {
    const result = await cleanupBunnyStreamVideosBestEffort(
      bunnyRefs('bunny-video-id-1', 'bunny-video-id-1', ' bunny-video-id-1 ')
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.attempted).toBe(1);
  });
});

describe('the delete request', () => {
  it('sends a keyed DELETE to the library video endpoint', async () => {
    await cleanupBunnyStreamVideosBestEffort(bunnyRefs('bunny-video-id-1'));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://video.bunnycdn.com/library/4242/videos/bunny-video-id-1',
      { method: 'DELETE', headers: { AccessKey: 'bunny-api-key-unit' } }
    );
  });

  it('falls back to the public library id when the server one is unset', async () => {
    vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', undefined);
    vi.stubEnv('NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID', '9001');

    await cleanupBunnyStreamVideosBestEffort(bunnyRefs('bunny-video-id-1'));

    expect(String(fetchMock.mock.calls[0][0])).toContain('/library/9001/videos/');
  });

  it.each(['BUNNY_STREAM_API_KEY', 'BUNNY_STREAM_LIBRARY_ID'])(
    'reports every id as failed when %s is missing',
    async (missing) => {
      vi.stubEnv(missing, undefined);

      const result = await cleanupBunnyStreamVideosBestEffort(
        bunnyRefs('bunny-video-id-1', 'bunny-video-id-2')
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        attempted: 2,
        failed: 2,
        failedIds: ['bunny-video-id-1', 'bunny-video-id-2'],
      });
    }
  );
});

describe('how each response is scored', () => {
  it('counts a 2xx as deleted', async () => {
    const result = await cleanupBunnyStreamVideosBestEffort(bunnyRefs('bunny-video-id-1'));

    expect(result).toEqual({ attempted: 1, failed: 0, failedIds: [] });
  });

  it('counts a 404 as already deleted rather than a failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    const result = await cleanupBunnyStreamVideosBestEffort(bunnyRefs('bunny-video-id-1'));

    expect(result).toEqual({ attempted: 1, failed: 0, failedIds: [] });
  });

  it.each([401, 403, 429, 500])('counts a %i as a failure', async (status) => {
    fetchMock.mockResolvedValue({ ok: false, status });

    const result = await cleanupBunnyStreamVideosBestEffort(bunnyRefs('bunny-video-id-1'));

    expect(result).toEqual({ attempted: 1, failed: 1, failedIds: ['bunny-video-id-1'] });
  });

  it('counts a rejected request as a failure', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    const result = await cleanupBunnyStreamVideosBestEffort(bunnyRefs('bunny-video-id-1'));

    expect(result).toEqual({ attempted: 1, failed: 1, failedIds: ['bunny-video-id-1'] });
  });

  it('keeps deleting the rest after one id fails', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('bunny-video-id-2') ? { ok: false, status: 500 } : { ok: true, status: 200 }
    );

    const result = await cleanupBunnyStreamVideosBestEffort(
      bunnyRefs('bunny-video-id-1', 'bunny-video-id-2', 'bunny-video-id-3')
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ attempted: 3, failed: 1, failedIds: ['bunny-video-id-2'] });
  });

  it('holds at most five deletes in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    fetchMock.mockImplementation(() => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => {
        release.push(() => {
          inFlight -= 1;
          resolve({ ok: true, status: 200 });
        });
      });
    });

    const ids = Array.from({ length: 12 }, (_unused, index) => `bunny-video-id-${index + 100}`);
    const pending = cleanupBunnyStreamVideosBestEffort(bunnyRefs(...ids));

    // Drain in waves: whatever is queued right now, then whatever that unblocks.
    while (release.length > 0) {
      release.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await pending;

    expect(peak).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });
});

describe('cleanupBunnyStreamVideos', () => {
  it('resolves when every delete succeeded', async () => {
    await expect(cleanupBunnyStreamVideos(bunnyRefs('bunny-video-id-1'))).resolves.toBeUndefined();
  });

  it('resolves when there was nothing to delete', async () => {
    await expect(cleanupBunnyStreamVideos([])).resolves.toBeUndefined();
  });

  it('throws with a count and the first three failed ids', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await expect(
      cleanupBunnyStreamVideos(
        bunnyRefs('bunny-video-id-1', 'bunny-video-id-2', 'bunny-video-id-3', 'bunny-video-id-4')
      )
    ).rejects.toThrow(
      'Bunny cleanup failed for 4 video(s): bunny-video-id-1, bunny-video-id-2, bunny-video-id-3'
    );
  });
});

it('aborts active requests, drains workers and never schedules remaining deletes after the deadline', async () => {
  const controller = new AbortController();
  let active = 0;
  const finishRequests: Array<() => void> = [];
  fetchMock.mockImplementation((_url, options: { signal: AbortSignal }) => {
    active++;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => {
          finishRequests.push(() => {
            active--;
            reject(new Error('aborted'));
          });
        },
        { once: true }
      );
    });
  });
  const ids = Array.from({ length: 12 }, (_, i) => `deadline-video-${i}`);
  const pending = cleanupBunnyStreamVideosBestEffort(bunnyRefs(...ids), controller.signal);
  expect(active).toBe(5);
  let settled = false;
  void pending
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);
  expect(active).toBe(finishRequests.length);
  expect(active).toBeGreaterThan(0);
  for (const finish of finishRequests) finish();
  const result = await pending;
  expect(active).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(result.failedIds).toHaveLength(12);
});
