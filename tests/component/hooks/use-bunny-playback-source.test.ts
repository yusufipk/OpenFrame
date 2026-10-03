import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBunnyPlaybackSource } from '@/components/video-page/hooks/use-bunny-playback-source';

// The hook's timings, written out rather than imported so a change to them shows
// up here as a failing expectation.
const ONE_MINUTE_MS = 60 * 1000;
const REFRESH_LEAD_MS = 30 * 60 * 1000;

const ENDPOINT_A = '/api/versions/a/playback';
const ENDPOINT_B = '/api/versions/b/playback';
// 2026-10-01T10:00:00Z
const START_MS = Date.UTC(2026, 9, 1, 10, 0, 0);
const SIX_HOURS_S = 6 * 3600;

let fetchMock: ReturnType<typeof vi.fn>;
let grantCount: number;
let failNext: number;

function grantResponse(baseUrl: string, expiresAt: number | null, serverDate?: Date) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (serverDate) headers.date = serverDate.toUTCString();
  return new Response(JSON.stringify({ data: { baseUrl, expiresAt } }), { status: 200, headers });
}

function hang() {
  let release: (response: Response) => void = () => {};
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
  return (response: Response) => release(response);
}

function callsTo(endpoint: string): number {
  return fetchMock.mock.calls.filter((call) => call[0] === endpoint).length;
}

/** Lets the fetch promise chain inside the hook settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(START_MS);
  grantCount = 0;
  failNext = 0;
  fetchMock = vi.fn(async (url: string) => {
    if (failNext > 0) {
      failNext -= 1;
      return new Response('{}', { status: 429 });
    }
    grantCount += 1;
    const expiresAt = Math.floor(Date.now() / 1000) + SIX_HOURS_S;
    return grantResponse(`https://cdn.test/grant-${grantCount}${url}/`, expiresAt);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useBunnyPlaybackSource', () => {
  it('exposes the first grant and keeps it when a refresh brings a newer one', async () => {
    const { result } = renderHook(() => useBunnyPlaybackSource(ENDPOINT_A));
    await flush();
    const first = result.current.baseUrl;
    expect(first).toBe(`https://cdn.test/grant-1${ENDPOINT_A}/`);

    vi.setSystemTime(START_MS + 2 * ONE_MINUTE_MS);
    await act(async () => {
      await result.current.refresh();
    });

    // The player is keyed on baseUrl and must not restart; reloads read the latest.
    expect(result.current.baseUrl).toBe(first);
    expect(result.current.getLatestBaseUrl()).toBe(`https://cdn.test/grant-2${ENDPOINT_A}/`);
  });

  it('refreshes on its own before the grant expires', async () => {
    renderHook(() => useBunnyPlaybackSource(ENDPOINT_A));
    await flush();
    expect(callsTo(ENDPOINT_A)).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(SIX_HOURS_S * 1000 - REFRESH_LEAD_MS - 1000);
    });
    expect(callsTo(ENDPOINT_A)).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await flush();
    expect(callsTo(ENDPOINT_A)).toBe(2);
  });

  it('makes at most one request a minute however often a player asks', async () => {
    const { result } = renderHook(() => useBunnyPlaybackSource(ENDPOINT_A));
    await flush();

    for (let i = 0; i < 10; i += 1) {
      vi.setSystemTime(START_MS + i * 3000);
      await act(async () => {
        await result.current.refresh();
      });
    }

    expect(callsTo(ENDPOINT_A)).toBe(1);
  });

  it('throttles after a failed attempt too, so a refusing route is not hammered', async () => {
    const { result } = renderHook(() => useBunnyPlaybackSource(ENDPOINT_A));
    await flush();
    failNext = 100;

    vi.setSystemTime(START_MS + 2 * ONE_MINUTE_MS);
    await act(async () => {
      await result.current.refresh();
    });
    expect(callsTo(ENDPOINT_A)).toBe(2);

    for (let i = 1; i <= 10; i += 1) {
      vi.setSystemTime(START_MS + 2 * ONE_MINUTE_MS + i * 3000);
      await act(async () => {
        await result.current.refresh();
      });
    }

    expect(callsTo(ENDPOINT_A)).toBe(2);
  });

  it('reports a failed first fetch and recovers when a retry succeeds', async () => {
    failNext = 1;
    const { result } = renderHook(() => useBunnyPlaybackSource(ENDPOINT_A));
    await flush();
    expect(result.current.failed).toBe(true);
    expect(result.current.baseUrl).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(ONE_MINUTE_MS);
    });
    await flush();

    expect(result.current.failed).toBe(false);
    expect(result.current.baseUrl).toBe(`https://cdn.test/grant-1${ENDPOINT_A}/`);
  });

  it('does not keep refreshing after unmount, even if the grant lands later', async () => {
    let release: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
    const { unmount } = renderHook(() => useBunnyPlaybackSource(ENDPOINT_A));
    unmount();

    release(grantResponse('https://cdn.test/late/', Math.floor(START_MS / 1000) + SIX_HOURS_S));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(24 * 3600 * 1000);
    });
    await flush();

    expect(callsTo(ENDPOINT_A)).toBe(1);
  });

  it('waits for a fresh grant when it comes back to an endpoint it held before', async () => {
    const { result, rerender } = renderHook(({ endpoint }) => useBunnyPlaybackSource(endpoint), {
      initialProps: { endpoint: ENDPOINT_A },
    });
    await flush();
    expect(result.current.baseUrl).toBe(`https://cdn.test/grant-1${ENDPOINT_A}/`);

    rerender({ endpoint: ENDPOINT_B });
    await flush();
    vi.setSystemTime(START_MS + 2 * 3600 * 1000);

    let release: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
    rerender({ endpoint: ENDPOINT_A });

    // The two-hour-old grant for A must not be handed back while the new one loads.
    expect(result.current.baseUrl).toBeNull();

    release(grantResponse('https://cdn.test/fresh-a/', null));
    await flush();
    expect(result.current.baseUrl).toBe('https://cdn.test/fresh-a/');
  });

  it('drops the old grant while it reloads the same endpoint after a pause', async () => {
    const { result, rerender } = renderHook(
      ({ endpoint }: { endpoint: string | null }) => useBunnyPlaybackSource(endpoint),
      { initialProps: { endpoint: ENDPOINT_A as string | null } }
    );
    await flush();
    expect(result.current.baseUrl).not.toBeNull();

    // No other endpoint loads in between, so only the reset hides the old grant.
    rerender({ endpoint: null });
    const release = hang();
    rerender({ endpoint: ENDPOINT_A });

    expect(result.current.baseUrl).toBeNull();
    release(grantResponse('https://cdn.test/fresh-a/', null));
    await flush();
    expect(result.current.baseUrl).toBe('https://cdn.test/fresh-a/');
  });

  it('loads the new endpoint even when the old one is still in flight', async () => {
    hang();
    const { result, rerender } = renderHook(({ endpoint }) => useBunnyPlaybackSource(endpoint), {
      initialProps: { endpoint: ENDPOINT_A },
    });

    rerender({ endpoint: ENDPOINT_B });
    await flush();

    expect(callsTo(ENDPOINT_B)).toBe(1);
    expect(result.current.baseUrl).toBe(`https://cdn.test/grant-1${ENDPOINT_B}/`);
  });

  it('cancels a scheduled refresh on unmount', async () => {
    const { unmount } = renderHook(() => useBunnyPlaybackSource(ENDPOINT_A));
    await flush();
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(24 * 3600 * 1000);
    });
    await flush();

    expect(callsTo(ENDPOINT_A)).toBe(1);
  });

  it('refreshes when the tab comes back with a grant close to expiry', async () => {
    renderHook(() => useBunnyPlaybackSource(ENDPOINT_A));
    await flush();

    // The timer slept with the laptop: only the clock moved.
    vi.setSystemTime(START_MS + SIX_HOURS_S * 1000 - 10 * ONE_MINUTE_MS);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();

    expect(callsTo(ENDPOINT_A)).toBe(2);
  });

  it('waits at least a minute before refreshing a grant that is already near expiry', async () => {
    fetchMock.mockImplementationOnce(async () =>
      grantResponse('https://cdn.test/short/', Math.floor(START_MS / 1000) + 60)
    );
    renderHook(() => useBunnyPlaybackSource(ENDPOINT_A));
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(ONE_MINUTE_MS - 1000);
    });
    await flush();
    expect(callsTo(ENDPOINT_A)).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await flush();
    expect(callsTo(ENDPOINT_A)).toBe(2);
  });

  it('times the refresh by the server clock when the browser clock is hours off', async () => {
    // The browser is six hours fast: by its own clock the grant is already expired.
    const serverNow = new Date(START_MS - 6 * 3600 * 1000);
    fetchMock.mockImplementationOnce(async () =>
      grantResponse(
        'https://cdn.test/skewed/',
        Math.floor(serverNow.getTime() / 1000) + SIX_HOURS_S,
        serverNow
      )
    );
    renderHook(() => useBunnyPlaybackSource(ENDPOINT_A));
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(60 * ONE_MINUTE_MS);
    });
    await flush();

    expect(callsTo(ENDPOINT_A)).toBe(1);
  });
});
