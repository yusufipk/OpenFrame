import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVideoPresence } from '@/components/video-page/hooks/use-video-presence';

const person = {
  id: 'opaque-id',
  name: 'Calm Otter',
  isAnonymous: true,
  isPlaying: false,
  isSelf: true,
};
const fetchMock = vi.fn();
const params = { videoId: 'video-one', enabled: true, isPlaying: false };
const response = (status = 200) => ({
  ok: status === 200,
  status,
  json: async () => ({ data: { participants: [person] } }),
});
const bodies = () => fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body));
const advance = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockResolvedValue(response());
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useVideoPresence', () => {
  it('does not register a loading, denied or gated page', async () => {
    renderHook(() => useVideoPresence({ ...params, enabled: false }));
    await advance(30_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('registers one tab and polls every five seconds without making early requests', async () => {
    const { result } = renderHook(() => useVideoPresence(params));
    await advance();
    expect(result.current).toMatchObject({ participants: [person], status: 'connected' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/videos/video-one/presence');
    expect(bodies()).toEqual([
      { clientId: '11111111-1111-4111-8111-111111111111', action: 'heartbeat', isPlaying: false },
    ]);
    await advance(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports playback transitions promptly using the same tab id', async () => {
    const { rerender } = renderHook(useVideoPresence, { initialProps: params });
    await advance();
    rerender({ ...params, isPlaying: true });
    await advance();
    rerender(params);
    await advance();
    expect(bodies().map((body) => body.isPlaying)).toEqual([false, true, false]);
    expect(new Set(bodies().map((body) => body.clientId)).size).toBe(1);
  });

  it('sends the entered guest name and refreshes a rename without creating another tab', async () => {
    const { rerender } = renderHook(useVideoPresence, {
      initialProps: { ...params, guestName: '  Zoë İpek  ' },
    });
    await advance();
    expect(bodies()[0].guestName).toBe('Zoë İpek');
    rerender({ ...params, guestName: 'Updated Reviewer' });
    await advance();
    expect(bodies().map((body) => body.guestName)).toEqual(['Zoë İpek', 'Updated Reviewer']);
    expect(new Set(bodies().map((body) => body.clientId)).size).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses slower polling in a background tab and refreshes on return', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    renderHook(() => useVideoPresence(params));
    await advance();
    await advance(14_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('coalesces updates while a request is pending and sends the latest playback state', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    const { rerender } = renderHook(useVideoPresence, { initialProps: params });
    rerender({ ...params, isPlaying: true });
    rerender(params);
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(response());
    });
    await advance();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies()[1].isPlaying).toBe(false);
  });

  it('removes stale people on a failure and recovers at the next poll', async () => {
    const { result } = renderHook(() => useVideoPresence(params));
    await advance();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await advance(5_000);
    expect(result.current).toMatchObject({ status: 'unavailable', participants: [] });
    await advance(5_000);
    expect(result.current.status).toBe('connected');
  });

  it('stops polling after access is revoked', async () => {
    fetchMock.mockResolvedValue(response(403));
    const { result } = renderHook(() => useVideoPresence(params));
    await advance(30_000);
    expect(result.current).toMatchObject({ status: 'unavailable', participants: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends a keepalive leave on unmount and cancels the poll', async () => {
    const { unmount } = renderHook(() => useVideoPresence(params));
    await advance();
    unmount();
    await advance(30_000);
    expect(bodies().map((body) => body.action)).toEqual(['heartbeat', 'leave']);
    expect(fetchMock.mock.calls[1][1].keepalive).toBe(true);
  });

  it('ignores an old video response and leaves after its pending heartbeat completes', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    const { rerender, result } = renderHook(useVideoPresence, { initialProps: params });
    rerender({ ...params, videoId: 'video-two' });
    await advance();
    expect(result.current).toMatchObject({ videoId: 'video-two', status: 'connected' });
    await act(async () => {
      resolve({
        ...response(),
        json: async () => ({ data: { participants: [{ ...person, name: 'Old Guest' }] } }),
      });
    });
    await advance();
    expect(result.current.participants[0].name).toBe('Calm Otter');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/videos/video-one/presence');
    expect(bodies().at(-1).action).toBe('leave');
  });

  it('leaves on pagehide and re-registers a restored page', async () => {
    renderHook(() => useVideoPresence(params));
    await advance();
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await advance(15_000);
    expect(bodies().map((body) => body.action)).toEqual(['heartbeat', 'leave']);
    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });
    await advance();
    expect(bodies().at(-1).action).toBe('heartbeat');
  });

  it('uses a new lease on restoration so delayed departures cannot remove the resumed tab', async () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    let resolve!: (value: ReturnType<typeof response>) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    renderHook(() => useVideoPresence(params));
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });
    await act(async () => {
      resolve(response());
    });
    await advance();
    const heartbeats = bodies().filter((body) => body.action === 'heartbeat');
    const departures = bodies().filter((body) => body.action === 'leave');
    expect(heartbeats.map((body) => body.clientId)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect(departures).toHaveLength(2);
    expect(
      departures.every((body) => body.clientId === '11111111-1111-4111-8111-111111111111')
    ).toBe(true);
  });

  it('serializes a departure after a pending heartbeat on an unrestored page', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    renderHook(() => useVideoPresence(params));
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(bodies().map((body) => body.action)).toEqual(['heartbeat', 'leave']);
    await act(async () => {
      resolve(response());
    });
    await advance(10_000);
    expect(bodies().map((body) => body.action)).toEqual(['heartbeat', 'leave', 'leave']);
  });
});
