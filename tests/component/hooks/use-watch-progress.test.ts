import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWatchProgress } from '@/components/video-page/hooks/use-watch-progress';
import type { PlayerAdapter } from '@/components/video-page/types';

type Params = Parameters<typeof useWatchProgress>[0];

/** The interval the hook polls the player on, and the debounce before a write. */
const SAVE_INTERVAL_MS = 5000;
const SAVE_DEBOUNCE_MS = 800;

function makePlayer(overrides: Partial<PlayerAdapter> = {}): PlayerAdapter {
  return {
    playVideo: vi.fn(),
    pauseVideo: vi.fn(),
    seekTo: vi.fn(),
    mute: vi.fn(),
    unMute: vi.fn(),
    isMuted: () => false,
    getCurrentTime: () => 0,
    getDuration: () => 600,
    getPlayerState: () => 1,
    setPlaybackRate: vi.fn(),
    destroy: vi.fn(),
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let loadedProgress: { progress: number; percentage: number };
let loadOk: boolean;

/** Every POST to the progress endpoint, in order, already JSON-parsed. */
function saves() {
  return fetchMock.mock.calls
    .filter((call) => call[1]?.method === 'POST')
    .map((call) => JSON.parse(call[1].body as string));
}

function loads() {
  return fetchMock.mock.calls.filter((call) => call[1]?.method !== 'POST');
}

function baseParams(overrides: Partial<Params> = {}): Params {
  return {
    videoId: 'vid1',
    activeVersionId: 'ver1',
    isAuthenticated: true,
    pathname: '/watch/vid1',
    playerRef: { current: makePlayer() },
    isReady: true,
    currentTime: 0,
    videoDuration: 600,
    ...overrides,
  };
}

async function renderWatchProgress(params: Params) {
  const rendered = renderHook((props: Params) => useWatchProgress(props), {
    initialProps: params,
  });
  // Let the mount-time progress load settle before any assertion.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return rendered;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  loadedProgress = { progress: 0, percentage: 0 };
  loadOk = true;
  fetchMock = vi.fn((_url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return Promise.resolve({ ok: true });
    return Promise.resolve({
      ok: loadOk,
      json: () => Promise.resolve({ data: loadedProgress }),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useWatchProgress resume prompt', () => {
  it('does not offer or apply a saved seek while joined to a room', async () => {
    loadedProgress = { progress: 123.5, percentage: 42 };
    const player = makePlayer();
    const { result } = await renderWatchProgress(
      baseParams({ isJoined: true, playerRef: { current: player } })
    );

    expect(result.current.showResumePrompt).toBe(false);
    let returned: number | null = 1;
    act(() => {
      returned = result.current.handleResumeFromSaved();
    });
    expect(returned).toBeNull();
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  it('offers to resume from a part-watched position', async () => {
    loadedProgress = { progress: 123.5, percentage: 42 };
    const { result } = await renderWatchProgress(baseParams());

    expect(loads()[0][0]).toBe('/api/watch/vid1/progress');
    expect(loads()[0][1]).toEqual({ cache: 'no-store' });
    expect(result.current.savedProgress).toBe(123.5);
    expect(result.current.showResumePrompt).toBe(true);
  });

  it('stays silent for a video barely started', async () => {
    loadedProgress = { progress: 10, percentage: 5 };
    const { result } = await renderWatchProgress(baseParams());

    expect(result.current.showResumePrompt).toBe(false);
    expect(result.current.savedProgress).toBeNull();
  });

  it('offers to resume just past the 5 percent floor', async () => {
    loadedProgress = { progress: 31, percentage: 5.1 };
    const { result } = await renderWatchProgress(baseParams());

    expect(result.current.showResumePrompt).toBe(true);
  });

  it('treats 95 percent as watched and does not offer to resume', async () => {
    loadedProgress = { progress: 570, percentage: 95 };
    const { result } = await renderWatchProgress(baseParams());

    expect(result.current.showResumePrompt).toBe(false);
  });

  it('still offers to resume just below the watched boundary', async () => {
    loadedProgress = { progress: 569, percentage: 94.9 };
    const { result } = await renderWatchProgress(baseParams());

    expect(result.current.showResumePrompt).toBe(true);
  });

  it('does not read progress for an anonymous viewer', async () => {
    const { result } = await renderWatchProgress(baseParams({ isAuthenticated: false }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.showResumePrompt).toBe(false);
  });

  it('does not read progress before a version is selected', async () => {
    await renderWatchProgress(baseParams({ activeVersionId: null }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays silent when the read fails', async () => {
    loadOk = false;
    loadedProgress = { progress: 400, percentage: 60 };
    const { result } = await renderWatchProgress(baseParams());

    expect(result.current.showResumePrompt).toBe(false);
  });

  it('stays silent when the read throws', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const { result } = await renderWatchProgress(baseParams());

    expect(result.current.showResumePrompt).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      'Error loading watch progress:',
      expect.objectContaining({ message: 'offline' })
    );
  });

  it('seeks the player and closes the prompt on resume', async () => {
    loadedProgress = { progress: 123.5, percentage: 42 };
    const player = makePlayer();
    const { result } = await renderWatchProgress(baseParams({ playerRef: { current: player } }));

    let returned: number | null = null;
    act(() => {
      returned = result.current.handleResumeFromSaved();
    });

    expect(player.seekTo).toHaveBeenCalledWith(123.5, true);
    expect(returned).toBe(123.5);
    expect(result.current.showResumePrompt).toBe(false);
    expect(result.current.savedProgress).toBeNull();
  });

  it('does nothing on resume when nothing was saved', async () => {
    const player = makePlayer();
    const { result } = await renderWatchProgress(baseParams({ playerRef: { current: player } }));

    let returned: number | null = 1;
    act(() => {
      returned = result.current.handleResumeFromSaved();
    });

    expect(returned).toBeNull();
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  it('closes the prompt without seeking when dismissed', async () => {
    loadedProgress = { progress: 123.5, percentage: 42 };
    const player = makePlayer();
    const { result } = await renderWatchProgress(baseParams({ playerRef: { current: player } }));

    act(() => {
      result.current.handleDismissResume();
    });

    expect(result.current.showResumePrompt).toBe(false);
    expect(result.current.savedProgress).toBeNull();
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  it('re-reads progress when the route changes', async () => {
    const params = baseParams();
    const { rerender } = await renderWatchProgress(params);
    expect(loads()).toHaveLength(1);

    rerender({ ...params, pathname: '/watch/vid2' });
    await advance(0);

    expect(loads()).toHaveLength(2);
  });
});

describe('useWatchProgress throttling', () => {
  it('writes on the 5s poll, after the 800ms debounce, and not before', async () => {
    const player = makePlayer({ getCurrentTime: () => 30 });
    await renderWatchProgress(baseParams({ playerRef: { current: player } }));

    await advance(SAVE_INTERVAL_MS - 1);
    expect(saves()).toHaveLength(0);

    await advance(1);
    expect(saves()).toHaveLength(0); // polled, but still inside the debounce

    await advance(SAVE_DEBOUNCE_MS - 1);
    expect(saves()).toHaveLength(0);

    await advance(1);
    expect(saves()).toHaveLength(1);
  });

  it('sends the player position, duration and version', async () => {
    const player = makePlayer({ getCurrentTime: () => 30, getDuration: () => 610 });
    await renderWatchProgress(baseParams({ playerRef: { current: player } }));

    await advance(SAVE_INTERVAL_MS + SAVE_DEBOUNCE_MS);

    expect(saves()).toEqual([{ progress: 30, duration: 610, versionId: 'ver1' }]);
    const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
    expect(post?.[0]).toBe('/api/watch/vid1/progress');
  });

  it('drops a second poll that has not moved at least 2 seconds on', async () => {
    let now = 30;
    const player = makePlayer({ getCurrentTime: () => now });
    await renderWatchProgress(baseParams({ playerRef: { current: player } }));

    await advance(SAVE_INTERVAL_MS + SAVE_DEBOUNCE_MS);
    expect(saves()).toHaveLength(1);

    now = 31.9; // 1.9s on, below the threshold
    await advance(SAVE_INTERVAL_MS + SAVE_DEBOUNCE_MS);
    expect(saves()).toHaveLength(1);

    now = 32; // exactly 2s on, written
    await advance(SAVE_INTERVAL_MS + SAVE_DEBOUNCE_MS);
    expect(saves()).toHaveLength(2);
    expect(saves()[1].progress).toBe(32);
  });

  it('coalesces several scheduled saves into one write at the highest position', async () => {
    const { result } = await renderWatchProgress(baseParams());

    act(() => {
      result.current.scheduleWatchProgressSave({ progress: 10, duration: 600 });
      result.current.scheduleWatchProgressSave({ progress: 40, duration: 600 });
      result.current.scheduleWatchProgressSave({ progress: 25, duration: 600 });
    });
    await advance(SAVE_DEBOUNCE_MS);

    expect(saves()).toEqual([{ progress: 40, duration: 600, versionId: 'ver1' }]);
  });

  it('writes straight away when asked to be immediate', async () => {
    const { result } = await renderWatchProgress(baseParams());

    await act(async () => {
      result.current.scheduleWatchProgressSave({ progress: 10, immediate: true });
    });

    expect(saves()).toHaveLength(1);
  });

  it('honours force for a move smaller than the 2 second threshold', async () => {
    const { result } = await renderWatchProgress(baseParams());

    await act(async () => {
      result.current.scheduleWatchProgressSave({ progress: 10, immediate: true });
    });
    expect(saves()).toHaveLength(1);

    await act(async () => {
      result.current.scheduleWatchProgressSave({ progress: 10.5, immediate: true });
    });
    expect(saves()).toHaveLength(1);

    await act(async () => {
      result.current.scheduleWatchProgressSave({ progress: 10.5, immediate: true, force: true });
    });
    expect(saves()).toHaveLength(2);
  });

  it('never writes a non-positive position', async () => {
    const { result } = await renderWatchProgress(baseParams());

    await act(async () => {
      result.current.scheduleWatchProgressSave({ progress: 0, immediate: true, force: true });
      result.current.scheduleWatchProgressSave({ progress: -12, immediate: true, force: true });
    });

    expect(saves()).toHaveLength(0);
  });

  it('does not write for an anonymous viewer', async () => {
    const { result } = await renderWatchProgress(baseParams({ isAuthenticated: false }));

    await act(async () => {
      result.current.scheduleWatchProgressSave({ progress: 30, immediate: true, force: true });
    });
    await advance(SAVE_INTERVAL_MS + SAVE_DEBOUNCE_MS);

    expect(saves()).toHaveLength(0);
  });

  it('does not write before a version is selected', async () => {
    const { result } = await renderWatchProgress(baseParams({ activeVersionId: null }));

    await act(async () => {
      result.current.scheduleWatchProgressSave({ progress: 30, immediate: true, force: true });
    });

    expect(saves()).toHaveLength(0);
  });

  it('stops polling once the player is no longer ready', async () => {
    const player = makePlayer({ getCurrentTime: () => 30 });
    const params = baseParams({ playerRef: { current: player } });
    const { rerender } = await renderWatchProgress(params);

    rerender({ ...params, isReady: false });
    await advance(SAVE_INTERVAL_MS * 4);

    expect(saves()).toHaveLength(0);
  });

  it('retries a rejected write on the next poll instead of marking it saved', async () => {
    fetchMock.mockImplementation((_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: false });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: loadedProgress }) });
    });
    let now = 30;
    const player = makePlayer({ getCurrentTime: () => now });
    await renderWatchProgress(baseParams({ playerRef: { current: player } }));

    await advance(SAVE_INTERVAL_MS + SAVE_DEBOUNCE_MS);
    expect(saves()).toHaveLength(1);

    // The write failed, so lastSavedProgress stayed at 0 and a position only
    // 0.5s further along is still 30.5s away from it: it must be retried.
    now = 30.5;
    await advance(SAVE_INTERVAL_MS + SAVE_DEBOUNCE_MS);
    expect(saves()).toHaveLength(2);
  });

  it('resets the saved-position baseline when the version changes', async () => {
    const params = baseParams();
    const { result, rerender } = await renderWatchProgress(params);

    await act(async () => {
      result.current.scheduleWatchProgressSave({ progress: 30, immediate: true });
    });
    expect(saves()).toHaveLength(1);

    rerender({ ...params, activeVersionId: 'ver2' });
    await advance(0);

    await act(async () => {
      result.current.scheduleWatchProgressSave({ progress: 30, immediate: true });
    });
    expect(saves()).toHaveLength(2);
    expect(saves()[1].versionId).toBe('ver2');
  });
});

describe('useWatchProgress leaving the page', () => {
  it('forces an immediate write when the tab is hidden', async () => {
    const player = makePlayer({ getCurrentTime: () => 44 });
    await renderWatchProgress(baseParams({ playerRef: { current: player } }));

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    visibility.mockRestore();

    expect(saves()).toEqual([{ progress: 44, duration: 600, versionId: 'ver1' }]);
  });

  it('does not write when the tab becomes visible again', async () => {
    const player = makePlayer({ getCurrentTime: () => 44 });
    await renderWatchProgress(baseParams({ playerRef: { current: player } }));

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(saves()).toHaveLength(0);
  });

  it('beacons the furthest known position on unload', async () => {
    const beacon = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);
    const player = makePlayer({ getCurrentTime: () => 44, getDuration: () => 600 });
    const { result } = await renderWatchProgress(baseParams({ playerRef: { current: player } }));

    // A pending (debounced) save that is further along than the player must win.
    act(() => {
      result.current.scheduleWatchProgressSave({ progress: 90, duration: 620 });
    });

    await act(async () => {
      window.dispatchEvent(new Event('beforeunload'));
    });

    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0] as [string, Blob];
    expect(url).toBe('/api/watch/vid1/progress');
    expect(JSON.parse(await blob.text())).toEqual({
      progress: 90,
      duration: 620,
      versionId: 'ver1',
    });
  });

  it('does not beacon from the start of the video', async () => {
    const beacon = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);
    const player = makePlayer({ getCurrentTime: () => 0 });
    await renderWatchProgress(
      baseParams({ playerRef: { current: player }, currentTime: 0, videoDuration: 600 })
    );

    await act(async () => {
      window.dispatchEvent(new Event('beforeunload'));
    });

    expect(beacon).not.toHaveBeenCalled();
  });

  it('does not beacon for an anonymous viewer', async () => {
    const beacon = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);
    const player = makePlayer({ getCurrentTime: () => 44 });
    await renderWatchProgress(
      baseParams({ playerRef: { current: player }, isAuthenticated: false })
    );

    await act(async () => {
      window.dispatchEvent(new Event('beforeunload'));
    });

    expect(beacon).not.toHaveBeenCalled();
  });

  it('stops polling after unmount', async () => {
    const player = makePlayer({ getCurrentTime: () => 30 });
    const { unmount } = await renderWatchProgress(baseParams({ playerRef: { current: player } }));

    unmount();
    await advance(SAVE_INTERVAL_MS * 3 + SAVE_DEBOUNCE_MS);

    expect(saves()).toHaveLength(0);
  });
});
