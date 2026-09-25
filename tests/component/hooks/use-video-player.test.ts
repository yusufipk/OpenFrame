import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVideoPlayer } from '@/components/video-page/hooks/use-video-player';
import type { PlayerAdapter, Version } from '@/components/video-page/types';

type Params = Parameters<typeof useVideoPlayer>[0];

/** Measured from the video element's metadata, so every seek clamps to it. */
const DURATION = 60;
const SPEED_OPTIONS = [0.25, 0.5, 1, 1.5, 2];
/** The timeline the tests drag over: 100px wide, starting at the viewport edge. */
const TIMELINE_LEFT = 0;
const TIMELINE_WIDTH = 100;
/** The hook builds the player inside a 100ms timeout. */
const PLAYER_INIT_DELAY_MS = 100;

type FrameMetadata = { mediaTime: number; presentedFrames: number };
type FrameCallback = (now: number, metadata: FrameMetadata) => void;

/**
 * A stand-in for the HTMLVideoElement the R2 branch of the hook drives. jsdom
 * has no media pipeline at all: it never fires 'play' or 'loadedmetadata', and
 * `duration` is a read-only NaN. This object exposes only the surface the hook
 * touches, and lets a test fire the media events itself so the timing is
 * explicit rather than accidental.
 */
function createVideoStub() {
  const listeners = new Map<string, Set<() => void>>();
  let frameCallback: FrameCallback | null = null;
  let nextFrameCallbackId = 1;

  const video = {
    currentTime: 0,
    duration: DURATION,
    paused: true,
    muted: false,
    playbackRate: 1,
    seeking: false,
    videoWidth: 1920,
    videoHeight: 1080,
    readyState: 2,
    src: '',
    play: vi.fn(() => {
      video.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      video.paused = true;
    }),
    load: vi.fn(),
    removeAttribute: vi.fn(),
    addEventListener: (type: string, handler: () => void) => {
      const forType = listeners.get(type) ?? new Set<() => void>();
      forType.add(handler);
      listeners.set(type, forType);
    },
    removeEventListener: (type: string, handler: () => void) => {
      listeners.get(type)?.delete(handler);
    },
    requestVideoFrameCallback: vi.fn((callback: FrameCallback) => {
      frameCallback = callback;
      return nextFrameCallbackId++;
    }),
    cancelVideoFrameCallback: vi.fn(() => {
      frameCallback = null;
    }),
    /** Deliver a media event to whatever the hook has subscribed. */
    fire: (type: string) => {
      for (const handler of [...(listeners.get(type) ?? [])]) handler();
    },
    /** Deliver one presented-frame sample to the frame-rate tracker. */
    emitFrame: (metadata: FrameMetadata) => {
      const callback = frameCallback;
      frameCallback = null;
      callback?.(0, metadata);
    },
  };

  return video;
}

type VideoStub = ReturnType<typeof createVideoStub>;

function makeVersion(): Version {
  return {
    id: 'ver1',
    versionNumber: 1,
    versionLabel: null,
    providerId: 'r2',
    videoId: 'vid1',
    originalUrl: '/api/upload/video/abc.mp4',
    title: null,
    thumbnailUrl: null,
    // Left unset so the duration under test is the one measured from the
    // element, which is what a real page ends up using.
    duration: null,
    isActive: true,
    _count: { comments: 0 },
  };
}

function makeTimeline(): HTMLDivElement {
  const timeline = document.createElement('div');
  // jsdom does no layout, so every rect is zero unless we supply one.
  timeline.getBoundingClientRect = () =>
    ({ left: TIMELINE_LEFT, width: TIMELINE_WIDTH }) as DOMRect;
  document.body.appendChild(timeline);
  return timeline;
}

function renderPlayer(overrides: Partial<Params> = {}) {
  const video = createVideoStub();
  const timeline = makeTimeline();
  const readout = document.createElement('div');
  const playerRef: { current: PlayerAdapter | null } = { current: null };

  const params: Params = {
    activeVersion: makeVersion(),
    activeVersionId: 'ver1',
    activeProviderId: 'r2',
    embedUrl: '/api/upload/video/abc.mp4',
    canInitializePlayer: true,
    iframeRef: { current: null },
    videoRef: { current: video as unknown as HTMLVideoElement },
    bunnyViewportRef: { current: null },
    timelineRef: { current: timeline },
    progressRef: { current: document.createElement('div') },
    playheadRef: { current: document.createElement('div') },
    scrubReadoutRef: { current: readout },
    hlsRef: { current: null },
    playerRef,
    formatTime: (seconds: number) => `${Math.floor(seconds)}s`,
    formatBunnyQualityLabel: () => 'auto',
    speedOptions: SPEED_OPTIONS,
    scheduleWatchProgressSaveRef: { current: vi.fn() },
    setViewingAnnotation: vi.fn(),
    ...overrides,
  };

  const rendered = renderHook((props: Params) => useVideoPlayer(props), { initialProps: params });

  act(() => {
    vi.advanceTimersByTime(PLAYER_INIT_DELAY_MS);
  });
  // Without metadata the hook has no duration, so nothing would clamp.
  act(() => {
    video.fire('loadedmetadata');
  });

  return { ...rendered, params, video, timeline, readout };
}

/** Put the player into the playing state the way the media element would. */
function startPlayback(video: VideoStub) {
  act(() => {
    video.paused = false;
    video.fire('play');
  });
}

function stopPlayback(video: VideoStub) {
  act(() => {
    video.paused = true;
    video.fire('pause');
  });
}

/**
 * Two presented-frame samples one second apart is what the hook needs to derive
 * a rate; the first sample only establishes a baseline.
 */
function measureFrameRate(video: VideoStub, fps: number) {
  act(() => {
    video.emitFrame({ mediaTime: 0, presentedFrames: 0 });
  });
  act(() => {
    video.emitFrame({ mediaTime: 1, presentedFrames: fps });
  });
}

function pressKey(
  code: string,
  options: { shiftKey?: boolean; target?: EventTarget } = {}
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    code,
    shiftKey: options.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    (options.target ?? window).dispatchEvent(event);
  });
  return event;
}

function mouseEventAt(clientX: number) {
  return { clientX } as React.MouseEvent<HTMLDivElement>;
}

beforeEach(() => {
  vi.useFakeTimers();
  // The hook injects the YouTube iframe API before the first <script> on the
  // page. Next always renders one; jsdom renders none, and the hook would
  // dereference undefined.
  document.head.appendChild(document.createElement('script'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.onYouTubeIframeAPIReady = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('useVideoPlayer seeking', () => {
  it('blocks local playback, timestamp seek and speed changes for a follower', () => {
    const { result, video } = renderPlayer({ playbackLocked: true });
    act(() => {
      result.current.handlePlayPause();
      result.current.handleSeekToTimestamp(20);
      result.current.handleSpeedChange(1.5);
    });
    pressKey('Space');
    pressKey('ArrowRight');
    expect(video.play).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(0);
    expect(video.playbackRate).toBe(1);
    expect(result.current.currentTime).toBe(0);
    pressKey('KeyM');
    expect(video.muted).toBe(true);
  });

  it('takes its duration from the loaded metadata', () => {
    const { result } = renderPlayer();

    expect(result.current.isReady).toBe(true);
    expect(result.current.videoDuration).toBe(DURATION);
  });

  it('associates measured duration with the version that supplied it', () => {
    const { result, rerender, params, video } = renderPlayer();
    expect(result.current.durationVersionId).toBe('ver1');

    rerender({
      ...params,
      activeVersion: { ...makeVersion(), id: 'ver2', videoId: 'vid2' },
      activeVersionId: 'ver2',
      embedUrl: '/api/upload/video/other.mp4',
    });

    expect(result.current.videoDuration).toBe(0);
    act(() => vi.advanceTimersByTime(PLAYER_INIT_DELAY_MS));
    video.duration = 17;
    act(() => video.fire('loadedmetadata'));

    expect(result.current.videoDuration).toBe(17);
    expect(result.current.durationVersionId).toBe('ver2');
  });

  it('clamps a backwards skip at the start of the video', () => {
    const { result, video } = renderPlayer();

    act(() => result.current.handleSeekToTimestamp(3));
    act(() => result.current.handleSkip(-5));

    expect(result.current.currentTime).toBe(0);
    expect(video.currentTime).toBe(0);
  });

  it('clamps a forwards skip at the end of the video', () => {
    const { result, video } = renderPlayer();

    act(() => result.current.handleSeekToTimestamp(58));
    act(() => result.current.handleSkip(5));

    expect(result.current.currentTime).toBe(DURATION);
    expect(video.currentTime).toBe(DURATION);
  });

  it('seeks by the requested amount away from the ends', () => {
    const { result, video } = renderPlayer();

    act(() => result.current.handleSeekToTimestamp(20));
    act(() => result.current.handleSkip(5));
    expect(result.current.currentTime).toBe(25);

    act(() => result.current.handleSkip(-5));
    expect(result.current.currentTime).toBe(20);
    expect(video.currentTime).toBe(20);
  });

  it('leaves a paused video paused after a seek, and a playing one playing', () => {
    const { result, video } = renderPlayer();

    act(() => result.current.handleSkip(5));
    expect(video.pause).toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();

    startPlayback(video);
    act(() => result.current.handleSkip(5));
    expect(video.play).toHaveBeenCalled();
  });
});

describe('useVideoPlayer frame stepping', () => {
  it('derives the frame rate from presented-frame samples', () => {
    const { result, video } = renderPlayer();
    startPlayback(video);

    expect(result.current.frameStepLabel).toBe('1s');

    measureFrameRate(video, 25);

    expect(result.current.frameStepSeconds).toBe(0.04);
    expect(result.current.frameStepLabel).toBe('1f');
  });

  it('ignores samples taken across a seek', () => {
    // Frames presented either side of a seek come from two different points in
    // the timeline, so their ratio is not a frame rate.
    const { result, video } = renderPlayer();
    startPlayback(video);
    video.seeking = true;

    measureFrameRate(video, 25);

    expect(result.current.frameStepLabel).toBe('1s');
  });

  it('moves exactly one frame per step once a rate is known', () => {
    const { result, video } = renderPlayer();
    startPlayback(video);
    measureFrameRate(video, 25);
    stopPlayback(video);

    act(() => result.current.handleFrameModeToggle());
    act(() => result.current.handleSeekToTimestamp(10));

    // A 5-second skip request collapses to a single 1/25s frame.
    act(() => result.current.handleSkip(5));
    expect(result.current.currentTime).toBeCloseTo(10.04, 10);
    expect(video.currentTime).toBeCloseTo(10.04, 10);

    act(() => result.current.handleSkip(5));
    expect(result.current.currentTime).toBeCloseTo(10.08, 10);

    act(() => result.current.handleSkip(-5));
    expect(result.current.currentTime).toBeCloseTo(10.04, 10);
  });

  it('steps a whole second while no frame rate has been measured', () => {
    const { result } = renderPlayer();

    act(() => result.current.handleFrameModeToggle());
    act(() => result.current.handleSeekToTimestamp(10));
    act(() => result.current.handleSkip(5));

    expect(result.current.frameStepLabel).toBe('1s');
    expect(result.current.currentTime).toBe(11);
  });

  it('skips the full requested amount while frame mode is off', () => {
    const { result, video } = renderPlayer();
    startPlayback(video);
    measureFrameRate(video, 25);

    act(() => result.current.handleSeekToTimestamp(10));
    act(() => result.current.handleSkip(5));

    expect(result.current.isFrameMode).toBe(false);
    expect(result.current.currentTime).toBe(15);
  });
});

describe('useVideoPlayer scrubbing', () => {
  it('cancels a drag when playback control moves to another participant', () => {
    const { result, video, params, rerender } = renderPlayer();
    act(() => result.current.handleTimelineMouseDown(mouseEventAt(10)));
    expect(result.current.isDragging).toBe(true);
    expect(video.currentTime).toBe(6);

    rerender({ ...params, playbackLocked: true });
    expect(result.current.isDragging).toBe(false);
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 90 }));
      video.currentTime = 2;
      video.fire('timeupdate');
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(result.current.currentTime).toBe(2);
    expect(video.currentTime).toBe(2);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('seeks to the fraction of the duration the pointer landed on', () => {
    const { result, video } = renderPlayer();

    act(() => result.current.handleTimelineMouseDown(mouseEventAt(TIMELINE_WIDTH / 2)));

    expect(result.current.isDragging).toBe(true);
    expect(result.current.currentTime).toBe(DURATION / 2);
    // The drag previews live, so the element is seeked before release.
    expect(video.currentTime).toBe(DURATION / 2);
  });

  it('clamps a drag dragged off either end of the timeline', () => {
    const { result } = renderPlayer();

    act(() => result.current.handleTimelineMouseDown(mouseEventAt(-500)));
    expect(result.current.currentTime).toBe(0);

    act(() => result.current.handleTimelineMouseMove(mouseEventAt(5000)));
    expect(result.current.currentTime).toBe(DURATION);
  });

  it('tracks the pointer even when it leaves the timeline', () => {
    const { result } = renderPlayer();

    act(() => result.current.handleTimelineMouseDown(mouseEventAt(10)));
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 75 }));
    });

    expect(result.current.currentTime).toBe(45);
  });

  it('commits the final position to the video element on release', () => {
    const { result, video } = renderPlayer();

    act(() => result.current.handleTimelineMouseDown(mouseEventAt(10)));
    act(() => result.current.handleTimelineMouseMove(mouseEventAt(90)));
    act(() => result.current.handleTimelineMouseUp());

    expect(result.current.isDragging).toBe(false);
    expect(result.current.currentTime).toBe(54);
    expect(video.currentTime).toBe(54);
  });

  it('freezes playback for the length of the drag and resumes it after', () => {
    const { result, video } = renderPlayer();
    startPlayback(video);
    video.play.mockClear();

    act(() => result.current.handleTimelineMouseDown(mouseEventAt(50)));
    expect(video.pause).toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();

    act(() => result.current.handleTimelineMouseUp());
    expect(video.play).toHaveBeenCalled();
  });

  it('leaves a paused video paused after a drag', () => {
    const { result, video } = renderPlayer();

    act(() => result.current.handleTimelineMouseDown(mouseEventAt(50)));
    act(() => result.current.handleTimelineMouseUp());

    expect(video.play).not.toHaveBeenCalled();
  });

  it('shows the frame number under the cursor while dragging', () => {
    const { result, video, readout } = renderPlayer();
    startPlayback(video);
    measureFrameRate(video, 25);
    stopPlayback(video);

    act(() => result.current.handleTimelineMouseDown(mouseEventAt(TIMELINE_WIDTH / 2)));

    // Halfway through a 60s clip at 25fps is second 30, frame 750.
    expect(readout.textContent).toBe('30s · f750');
    expect(result.current.showScrubReadout).toBe(true);
  });
});

describe('useVideoPlayer cursor idling', () => {
  /** The hook hides the cursor and the overlay after this much stillness. */
  const IDLE_DELAY_MS = 1000;

  it('goes idle when playback starts under a cursor that never moves again', () => {
    const { result, video } = renderPlayer();
    act(() => result.current.handleVideoMouseMove());

    startPlayback(video);
    expect(result.current.cursorIdle).toBe(false);

    act(() => vi.advanceTimersByTime(IDLE_DELAY_MS));
    expect(result.current.cursorIdle).toBe(true);
  });

  it('stays awake through a scrub and idles again once the cursor returns', () => {
    const { result, video } = renderPlayer();
    act(() => result.current.handleVideoMouseMove());
    startPlayback(video);
    act(() => vi.advanceTimersByTime(IDLE_DELAY_MS));
    expect(result.current.cursorIdle).toBe(true);

    // The timeline sits outside the player, so reaching it leaves the player
    // first; the element then reports the pause the scrub asked for and the
    // resume on release.
    act(() => result.current.handleVideoMouseLeave());
    act(() => result.current.handleTimelineMouseDown(mouseEventAt(50)));
    stopPlayback(video);
    act(() => result.current.handleTimelineMouseUp());
    startPlayback(video);
    act(() => vi.advanceTimersByTime(IDLE_DELAY_MS * 5));
    expect(result.current.cursorIdle).toBe(false);

    act(() => result.current.handleVideoMouseMove());
    act(() => vi.advanceTimersByTime(IDLE_DELAY_MS));
    expect(result.current.cursorIdle).toBe(true);
  });

  it('wakes on movement and idles again after the same delay', () => {
    const { result, video } = renderPlayer();
    act(() => result.current.handleVideoMouseMove());
    startPlayback(video);
    act(() => vi.advanceTimersByTime(IDLE_DELAY_MS));

    act(() => result.current.handleVideoMouseMove());
    expect(result.current.cursorIdle).toBe(false);

    act(() => vi.advanceTimersByTime(IDLE_DELAY_MS - 1));
    expect(result.current.cursorIdle).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.cursorIdle).toBe(true);
  });

  it('never idles while paused', () => {
    const { result } = renderPlayer();
    act(() => result.current.handleVideoMouseMove());

    act(() => vi.advanceTimersByTime(IDLE_DELAY_MS * 5));
    expect(result.current.cursorIdle).toBe(false);
  });

  it('stays awake once the cursor has left the player', () => {
    const { result, video } = renderPlayer();
    act(() => result.current.handleVideoMouseMove());
    act(() => result.current.handleVideoMouseLeave());

    startPlayback(video);
    act(() => vi.advanceTimersByTime(IDLE_DELAY_MS * 5));
    expect(result.current.cursorIdle).toBe(false);
  });

  it('stays idle across a pause and play the element emits on its own', () => {
    const { result, video } = renderPlayer();
    act(() => result.current.handleVideoMouseMove());
    startPlayback(video);
    act(() => vi.advanceTimersByTime(IDLE_DELAY_MS));
    expect(result.current.cursorIdle).toBe(true);

    // A rebuffer or a source switch pauses and resumes without any pointer
    // activity, so the cursor must not come back for a second on every stall.
    stopPlayback(video);
    startPlayback(video);
    expect(result.current.cursorIdle).toBe(true);
  });
});

describe('useVideoPlayer keyboard shortcuts', () => {
  it('starts and stops playback on space', () => {
    const { video } = renderPlayer();

    const first = pressKey('Space');
    expect(video.play).toHaveBeenCalledTimes(1);
    // Otherwise the page scrolls under the player.
    expect(first.defaultPrevented).toBe(true);

    startPlayback(video);
    pressKey('Space');
    expect(video.pause).toHaveBeenCalledTimes(1);
  });

  it('treats K the same as space', () => {
    const { video } = renderPlayer();

    pressKey('KeyK');

    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('skips five seconds with the left and right arrows', () => {
    const { result } = renderPlayer();

    act(() => result.current.handleSeekToTimestamp(20));

    pressKey('ArrowRight');
    expect(result.current.currentTime).toBe(25);

    pressKey('ArrowLeft');
    expect(result.current.currentTime).toBe(20);
  });

  it('jumps ten seconds with J and L, clamped to the media', () => {
    const { result, video } = renderPlayer();

    act(() => result.current.handleSeekToTimestamp(20));

    pressKey('KeyL');
    expect(result.current.currentTime).toBe(30);
    expect(video.currentTime).toBe(30);

    pressKey('KeyJ');
    expect(result.current.currentTime).toBe(20);

    act(() => result.current.handleSeekToTimestamp(5));
    pressKey('KeyJ');
    expect(result.current.currentTime).toBe(0);

    act(() => result.current.handleSeekToTimestamp(55));
    pressKey('KeyL');
    expect(result.current.currentTime).toBe(DURATION);
  });

  it('toggles mute on the element with M', () => {
    const { result, video } = renderPlayer();

    pressKey('KeyM');
    expect(video.muted).toBe(true);
    expect(result.current.isMuted).toBe(true);

    pressKey('KeyM');
    expect(video.muted).toBe(false);
    expect(result.current.isMuted).toBe(false);
  });

  it('steps the speed ladder with the up and down arrows, stopping at the ends', () => {
    const { result, video } = renderPlayer();

    pressKey('ArrowUp');
    expect(result.current.playbackSpeed).toBe(1.5);
    expect(video.playbackRate).toBe(1.5);

    pressKey('ArrowUp');
    expect(result.current.playbackSpeed).toBe(2);

    // 2x is the top of the ladder: the shortcut must not wrap around.
    pressKey('ArrowUp');
    expect(result.current.playbackSpeed).toBe(2);

    pressKey('ArrowDown');
    expect(result.current.playbackSpeed).toBe(1.5);
    expect(video.playbackRate).toBe(1.5);
  });

  it('steps the speed ladder with shifted comma and period', () => {
    const { result } = renderPlayer();

    pressKey('Period', { shiftKey: true });
    expect(result.current.playbackSpeed).toBe(1.5);

    pressKey('Comma', { shiftKey: true });
    expect(result.current.playbackSpeed).toBe(1);
  });

  it('leaves an unshifted comma alone so it can still be typed', () => {
    const { result } = renderPlayer();

    const event = pressKey('Comma');

    expect(result.current.playbackSpeed).toBe(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('requests fullscreen with F', async () => {
    const { result } = renderPlayer();
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;

    pressKey('KeyF');
    await act(async () => {});

    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(result.current.isFullscreenMode).toBe(true);
    // Fullscreen is for watching, so the comments pane gets out of the way.
    expect(result.current.showComments).toBe(false);
  });

  it('ignores a shortcut typed into a text field', () => {
    const { result, video } = renderPlayer();
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => result.current.handleSeekToTimestamp(20));

    const space = pressKey('Space', { target: input });
    pressKey('ArrowRight', { target: input });

    expect(video.play).not.toHaveBeenCalled();
    expect(result.current.currentTime).toBe(20);
    // Nothing was claimed, so the keystroke still reaches the field.
    expect(space.defaultPrevented).toBe(false);
  });

  it('ignores a shortcut typed into a rich text editor', () => {
    const { video } = renderPlayer();
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(editor, 'isContentEditable', { value: true });
    document.body.appendChild(editor);

    pressKey('Space', { target: editor });

    expect(video.play).not.toHaveBeenCalled();
  });

  it('ignores every shortcut while a dialog is open', () => {
    const { result, video } = renderPlayer();
    const dialog = document.createElement('div');
    dialog.setAttribute('data-slot', 'dialog-content');
    document.body.appendChild(dialog);
    act(() => result.current.handleSeekToTimestamp(20));

    pressKey('Space');
    pressKey('ArrowRight');
    pressKey('KeyM');

    expect(video.play).not.toHaveBeenCalled();
    expect(result.current.currentTime).toBe(20);
    expect(video.muted).toBe(false);
  });
});
