import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useCueFontSize,
  useSubtitleAppearance,
  type SubtitleSize,
} from '@/components/video-page/hooks/subtitle-appearance';

const STORAGE_KEY = 'openframe:subtitle-appearance';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

/** A <video> with a laid-out box and a picture of the given shape. */
function makeVideo(
  box: { width: number; height: number },
  picture: { width: number; height: number }
) {
  const video = document.createElement('video');
  Object.defineProperty(video, 'clientWidth', { get: () => box.width });
  Object.defineProperty(video, 'clientHeight', { get: () => box.height });
  Object.defineProperty(video, 'videoWidth', { get: () => picture.width });
  Object.defineProperty(video, 'videoHeight', { get: () => picture.height });
  return video;
}

describe('useCueFontSize', () => {
  let observed: Element[] = [];

  beforeEach(() => {
    observed = [];
    // The setup stub never fires; this one reports the size on observe(), as browsers do.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          observed.push(target);
          this.callback([], this as unknown as ResizeObserver);
        }
        unobserve() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sizes cues from the picture as soon as the player is observed', () => {
    const video = makeVideo({ width: 1280, height: 1000 }, { width: 1920, height: 1080 });
    const ref = { current: video };

    const { result } = renderHook(() => useCueFontSize(ref, 'v1', 'medium'));

    expect(observed).toEqual([video]);
    // A 16:9 picture letterboxed in that box is 720 px high.
    expect(result.current).toBe(36);
  });

  it('follows a new size choice', () => {
    const video = makeVideo({ width: 1280, height: 720 }, { width: 1920, height: 1080 });
    const ref = { current: video };
    const { result, rerender } = renderHook(
      ({ size }: { size: SubtitleSize }) => useCueFontSize(ref, 'v1', size),
      { initialProps: { size: 'medium' as SubtitleSize } }
    );

    rerender({ size: 'xlarge' });

    expect(result.current).toBe(63);
  });

  // The element's box stays the same here, so only the media event can report it.
  it('measures again when the picture changes shape mid-stream', () => {
    const picture = { width: 1920, height: 1080 };
    const video = makeVideo({ width: 1280, height: 1000 }, picture);
    const ref = { current: video };
    const { result } = renderHook(() => useCueFontSize(ref, 'v1', 'medium'));

    picture.width = 1000;
    picture.height = 1000;
    act(() => {
      video.dispatchEvent(new Event('resize'));
    });

    expect(result.current).toBe(50);
  });

  // Every version mounts a new <video>, so the old observer and listeners must let go.
  it('moves to the new element when the version changes', () => {
    const first = makeVideo({ width: 1280, height: 720 }, { width: 1920, height: 1080 });
    const second = makeVideo({ width: 1280, height: 1000 }, { width: 1000, height: 1000 });
    const ref: { current: HTMLVideoElement | null } = { current: first };
    const { result, rerender } = renderHook(
      ({ versionId }: { versionId: string }) => useCueFontSize(ref, versionId, 'medium'),
      { initialProps: { versionId: 'v1' } }
    );
    expect(result.current).toBe(36);

    ref.current = second;
    rerender({ versionId: 'v2' });

    expect(observed).toEqual([first, second]);
    expect(result.current).toBe(50);

    // A late event from the old element must not overwrite the new size.
    act(() => {
      first.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toBe(50);
  });

  it('stays unset while there is no video element', () => {
    const ref = { current: null };
    const { result } = renderHook(() => useCueFontSize(ref, 'v1', 'large'));

    expect(observed).toEqual([]);
    expect(result.current).toBeNull();
  });
});

describe('useSubtitleAppearance', () => {
  it('starts from the stored choice', () => {
    window.localStorage.setItem(STORAGE_KEY, '{"size":"large","background":"solid"}');

    const { result } = renderHook(() => useSubtitleAppearance());

    expect(result.current.subtitleAppearance).toEqual({ size: 'large', background: 'solid' });
  });

  it('changes one field, keeps the other and stores both', () => {
    window.localStorage.setItem(STORAGE_KEY, '{"size":"small","background":"none"}');
    const { result } = renderHook(() => useSubtitleAppearance());

    act(() => result.current.setSubtitleAppearance({ size: 'xlarge' }));

    expect(result.current.subtitleAppearance).toEqual({ size: 'xlarge', background: 'none' });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      size: 'xlarge',
      background: 'none',
    });
  });

  // The CC menu and the <video> read the choice through separate hook calls on the page.
  it('updates every mounted reader in the same tab', () => {
    const menu = renderHook(() => useSubtitleAppearance());
    const player = renderHook(() => useSubtitleAppearance());

    act(() => menu.result.current.setSubtitleAppearance({ background: 'solid' }));

    expect(player.result.current.subtitleAppearance).toEqual({
      size: 'medium',
      background: 'solid',
    });
  });

  // Kept last: the refused write leaves the in-memory fallback set for this module.
  it('still applies a choice for this page when storage refuses the write', () => {
    // An older choice still in storage must not win over the one just made.
    window.localStorage.setItem(STORAGE_KEY, '{"size":"large","background":"box"}');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const { result } = renderHook(() => useSubtitleAppearance());

    act(() => result.current.setSubtitleAppearance({ size: 'small' }));

    expect(result.current.subtitleAppearance).toEqual({ size: 'small', background: 'box' });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('{"size":"large","background":"box"}');
  });
});
