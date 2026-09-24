import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useVersionDurationSync } from '@/components/video-page/hooks/use-version-duration-sync';
import type { VideoData } from '@/components/video-page/types';

type Params = Parameters<typeof useVersionDurationSync>[0];

function makeVideo(versionDuration: number | null): VideoData {
  return {
    id: 'vid1',
    title: 'Cut 3',
    description: null,
    projectId: 'proj1',
    project: { name: 'Ad campaign', ownerId: 'user1' },
    isAuthenticated: true,
    currentUserId: 'user1',
    currentUserName: 'Ada',
    versions: [
      {
        id: 'ver1',
        versionNumber: 1,
        versionLabel: null,
        providerId: 'bunny',
        videoId: 'vid1',
        originalUrl: 'https://cdn.example.com/a.mp4',
        title: null,
        thumbnailUrl: null,
        duration: versionDuration,
        isActive: true,
        _count: { comments: 0 },
        comments: [],
      },
      {
        id: 'ver2',
        versionNumber: 2,
        versionLabel: null,
        providerId: 'bunny',
        videoId: 'vid1',
        originalUrl: 'https://cdn.example.com/b.mp4',
        title: null,
        thumbnailUrl: null,
        duration: 999,
        isActive: false,
        _count: { comments: 0 },
        comments: [],
      },
    ],
  };
}

function baseParams(overrides: Partial<Params> = {}): Params {
  return {
    videoDuration: 42.4,
    durationVersionId: 'ver1',
    activeVersionDuration: null,
    activeVersionId: 'ver1',
    propProjectId: 'proj1',
    videoId: 'vid1',
    setVideo: vi.fn(),
    ...overrides,
  };
}

/** Mirrors what React's useState does with a functional updater. */
function makeStore(initial: VideoData | null) {
  const store: { current: VideoData | null } = { current: initial };
  const setVideo = vi.fn((updater: unknown) => {
    store.current =
      typeof updater === 'function'
        ? (updater as (prev: VideoData | null) => VideoData | null)(store.current)
        : (updater as VideoData | null);
  });
  return { store, setVideo: setVideo as unknown as Params['setVideo'], spy: setVideo };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useVersionDurationSync', () => {
  it('PATCHes the measured duration, rounded, to the active version', async () => {
    renderHook(() => useVersionDurationSync(baseParams({ videoDuration: 42.4 })));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects/proj1/videos/vid1/versions/ver1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ duration: 42 });
  });

  it('rounds to the nearest second rather than truncating', async () => {
    renderHook(() => useVersionDurationSync(baseParams({ videoDuration: 42.6 })));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ duration: 43 });
  });

  it('writes the rounded duration onto the active version only', async () => {
    const { store, setVideo, spy } = makeStore(makeVideo(null));

    renderHook(() => useVersionDurationSync(baseParams({ videoDuration: 42.4, setVideo })));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(store.current?.versions[0].duration).toBe(42);
    expect(store.current?.versions[1].duration).toBe(999);
  });

  it('does not save the previous version duration during a version switch', () => {
    const setVideo = vi.fn();
    renderHook(() =>
      useVersionDurationSync(
        baseParams({
          activeVersionId: 'ver2',
          durationVersionId: 'ver1',
          videoDuration: 17,
          setVideo,
        })
      )
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setVideo).not.toHaveBeenCalled();
  });

  it.each([
    [17, 1228],
    [1230, 17],
  ])('corrects cached duration %s to measured duration %s', async (cached, measured) => {
    const { store, setVideo } = makeStore(makeVideo(cached));
    renderHook(() =>
      useVersionDurationSync(
        baseParams({ videoDuration: measured, activeVersionDuration: cached, setVideo })
      )
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ duration: measured });
    await waitFor(() => expect(store.current?.versions[0].duration).toBe(measured));
  });

  it('leaves state null when the video has not loaded yet', async () => {
    const { store, setVideo, spy } = makeStore(null);

    renderHook(() => useVersionDurationSync(baseParams({ setVideo })));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(store.current).toBeNull();
  });

  it('does nothing until a duration has been measured', () => {
    const setVideo = vi.fn();
    renderHook(() => useVersionDurationSync(baseParams({ videoDuration: 0, setVideo })));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setVideo).not.toHaveBeenCalled();
  });

  it('does nothing without an active version', () => {
    const setVideo = vi.fn();
    renderHook(() => useVersionDurationSync(baseParams({ activeVersionId: null, setVideo })));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setVideo).not.toHaveBeenCalled();
  });

  it('does nothing on a share page, where there is no project id', () => {
    const setVideo = vi.fn();
    renderHook(() => useVersionDurationSync(baseParams({ propProjectId: undefined, setVideo })));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setVideo).not.toHaveBeenCalled();
  });

  it('skips the write when the stored duration matches playback', () => {
    const setVideo = vi.fn();
    renderHook(() => useVersionDurationSync(baseParams({ activeVersionDuration: 42, setVideo })));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setVideo).not.toHaveBeenCalled();
  });

  it('treats a stored duration of 0 as missing and backfills it', async () => {
    renderHook(() => useVersionDurationSync(baseParams({ activeVersionDuration: 0 })));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('keeps the cached duration when the PATCH fails', async () => {
    fetchMock.mockResolvedValue({ ok: false });
    const { store, setVideo } = makeStore(makeVideo(null));

    renderHook(() => useVersionDurationSync(baseParams({ setVideo })));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(store.current?.versions[0].duration).toBeNull();
  });

  it('finishes an older duration write before sending the corrected duration', async () => {
    let finishFirstWrite: ((response: { ok: boolean }) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirstWrite = resolve;
        })
    );
    const setVideo = vi.fn();
    const initial = baseParams({ videoDuration: 17, setVideo });
    const { rerender } = renderHook((props: Params) => useVersionDurationSync(props), {
      initialProps: initial,
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ ...initial, videoDuration: 1228 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => finishFirstWrite?.({ ok: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({ duration: 1228 });
  });

  it('writes once per measurement, not on every re-render', async () => {
    const params = baseParams();
    const { rerender } = renderHook(() => useVersionDurationSync(params));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender();
    rerender();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('writes again when the active version changes', async () => {
    const setVideo = vi.fn();
    const { rerender } = renderHook((props: Params) => useVersionDurationSync(props), {
      initialProps: baseParams({ setVideo }),
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(baseParams({ activeVersionId: 'ver2', durationVersionId: 'ver2', setVideo }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe('/api/projects/proj1/videos/vid1/versions/ver2');
  });
});
