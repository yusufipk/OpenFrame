import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLiveReview } from '@/components/video-page/hooks/use-live-review';
import type { LiveSnapshot } from '@/lib/live-review/protocol';

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
  });

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  disconnect() {
    this.readyState = 3;
    this.onclose?.();
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
}

function room(overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    sessionId: 'room',
    videoId: 'vid',
    versionId: 'ver',
    status: 'active',
    revision: 1,
    controlEpoch: 1,
    presenterId: 'other',
    playback: { position: 4, playing: false, rate: 1, updatedAt: Date.now() },
    participants: [
      { id: 'self', name: 'Viewer', isManager: false, canComment: true, status: 'ready' },
    ],
    strokes: [],
    canvasEpoch: 0,
    serverTime: Date.now(),
    ...overrides,
  };
}

function videoStub() {
  const listeners = new Map<string, Set<() => void>>();
  const video = {
    currentTime: 0,
    duration: 60,
    readyState: 4,
    playbackRate: 1,
    paused: true,
    play: vi.fn(() => {
      video.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      video.paused = true;
    }),
    addEventListener: (type: string, listener: () => void) => {
      const group = listeners.get(type) ?? new Set<() => void>();
      group.add(listener);
      listeners.set(type, group);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
    fire: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listenerCount: () =>
      Array.from(listeners.values()).reduce((count, group) => count + group.size, 0),
  };
  return video;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  let ticketNumber = 0;
  fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      ticketNumber++;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              ticket: `ticket-${ticketNumber}`,
              participantId: 'self',
              websocketUrl: 'ws://test/ws',
              sessionId: 'room',
              versionId: 'ver',
            },
          }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            enabled: true,
            available: true,
            canStart: true,
            session: { id: 'room', versionId: 'ver' },
          },
        }),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function joinRoom() {
  const video = videoStub();
  const params = {
    videoId: 'vid',
    versionId: 'ver',
    providerId: 'r2',
    videoRef: { current: video as unknown as HTMLVideoElement },
    enabled: true,
  };
  const rendered = renderHook((value) => useLiveReview(value), { initialProps: params });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await rendered.result.current.join();
  });
  const socket = FakeSocket.instances[0];
  act(() => {
    socket.open();
  });
  return { ...rendered, video, socket, params };
}

describe('useLiveReview', () => {
  it('identifies rejected strokes and clears the rejection on a new canvas epoch', async () => {
    const { result, socket } = await joinRoom();
    act(() => socket.deliver({ type: 'snapshot', snapshot: room() }));
    act(() =>
      socket.deliver({
        type: 'error',
        code: 'CANVAS_LIMIT',
        message: 'CANVAS_LIMIT',
        strokeId: 'stroke-1',
      })
    );
    expect(result.current.rejectedStroke).toEqual({ id: 'stroke-1', sequence: 1 });
    act(() =>
      socket.deliver({ type: 'snapshot', snapshot: room({ revision: 2, canvasEpoch: 1 }) })
    );
    expect(result.current.rejectedStroke).toBeNull();
  });

  it('authenticates first, rejects stale snapshots, and locks follower playback', async () => {
    const { result, socket, video } = await joinRoom();
    expect(socket.sent[0]).toEqual({ type: 'auth', ticket: 'ticket-1' });
    act(() => {
      socket.deliver({ type: 'snapshot', snapshot: room() });
    });
    expect(result.current.connectionStatus).toBe('connected');
    expect(result.current.playbackLocked).toBe(true);
    expect(video.currentTime).toBe(4);
    act(() => {
      socket.deliver({
        type: 'snapshot',
        snapshot: room({
          revision: 0,
          playback: { position: 40, playing: false, rate: 1, updatedAt: Date.now() },
        }),
      });
    });
    expect(result.current.snapshot?.revision).toBe(1);
    expect(video.currentTime).toBe(4);
    act(() => {
      video.currentTime = 20;
      video.fire('seeked');
    });
    expect(video.currentTime).toBe(4);
    expect(
      socket.sent.filter((message) => (message as { type: string }).type === 'playback')
    ).toHaveLength(0);
  });

  it('reconnects with a fresh ticket and waits for a new snapshot', async () => {
    const { result, socket, video, unmount } = await joinRoom();
    act(() => {
      socket.deliver({ type: 'snapshot', snapshot: room() });
    });
    act(() => {
      socket.disconnect();
    });
    expect(result.current.connectionStatus).toBe('reconnecting');
    expect(video.pause).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const replacement = FakeSocket.instances[1];
    act(() => {
      replacement.open();
    });
    expect(replacement.sent[0]).toEqual({ type: 'auth', ticket: 'ticket-2' });
    expect(result.current.snapshot).toBeNull();
    unmount();
    expect(replacement.close).toHaveBeenCalled();
    expect(video.listenerCount()).toBe(0);
  });

  it('reports blocked autoplay and resumes after a user action', async () => {
    const { result, socket, video } = await joinRoom();
    video.play.mockRejectedValueOnce(new Error('NotAllowedError'));
    await act(async () => {
      socket.deliver({
        type: 'snapshot',
        snapshot: room({
          playback: { position: 4, playing: true, rate: 1, updatedAt: Date.now() },
        }),
      });
      await Promise.resolve();
    });
    expect(result.current.autoplayBlocked).toBe(true);
    expect(socket.sent).toContainEqual({ type: 'status', status: 'blocked' });
    await act(async () => {
      result.current.retryPlayback();
      await Promise.resolve();
    });
    expect(result.current.autoplayBlocked).toBe(false);
    expect(video.play).toHaveBeenCalledTimes(2);
  });

  it('keeps gentle drift correction local without echoing a presenter command', async () => {
    const { socket, video } = await joinRoom();
    await act(async () => {
      socket.deliver({
        type: 'snapshot',
        snapshot: room({
          playback: { position: 0, playing: true, rate: 1, updatedAt: Date.now() },
        }),
      });
      await Promise.resolve();
    });
    video.currentTime = 0.7;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(video.playbackRate).toBeGreaterThan(1);
    act(() => {
      video.fire('ratechange');
    });
    expect(video.currentTime).toBe(0.7);
    expect(
      socket.sent.filter((message) => (message as { type: string }).type === 'playback')
    ).toHaveLength(0);
  });

  it('caps follower drift correction at the native 16x speed ceiling', async () => {
    const { socket, video } = await joinRoom();
    await act(async () => {
      socket.deliver({
        type: 'snapshot',
        snapshot: room({
          playback: { position: 0, playing: true, rate: 16, updatedAt: Date.now() },
        }),
      });
      await Promise.resolve();
    });
    video.currentTime = 15.7;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(video.playbackRate).toBe(16);
  });

  it('applies an authoritative pause after the presenter reports buffering', async () => {
    const { socket, video } = await joinRoom();
    await act(async () => {
      socket.deliver({
        type: 'snapshot',
        snapshot: room({
          presenterId: 'self',
          playback: { position: 0, playing: true, rate: 1, updatedAt: Date.now() },
        }),
      });
      await Promise.resolve();
    });
    expect(video.paused).toBe(false);
    act(() => {
      video.fire('waiting');
    });
    expect(socket.sent).toContainEqual({ type: 'status', status: 'buffering' });
    act(() => {
      socket.deliver({
        type: 'snapshot',
        snapshot: room({
          revision: 2,
          presenterId: 'self',
          playback: { position: 0, playing: false, rate: 1, updatedAt: Date.now() },
        }),
      });
    });
    expect(video.paused).toBe(true);
  });

  it('keeps a pending presenter seek across an unrelated participant snapshot', async () => {
    const { socket, video } = await joinRoom();
    act(() => {
      socket.deliver({
        type: 'snapshot',
        snapshot: room({
          presenterId: 'self',
          playback: { position: 0, playing: false, rate: 1, updatedAt: Date.now() },
        }),
      });
      video.currentTime = 0.7;
      video.fire('seeked');
      socket.deliver({
        type: 'snapshot',
        snapshot: room({
          revision: 2,
          presenterId: 'self',
          playback: { position: 0, playing: false, rate: 1, updatedAt: Date.now() },
        }),
      });
    });
    expect(video.currentTime).toBe(0.7);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(socket.sent).toContainEqual(
      expect.objectContaining({ type: 'playback', position: 0.7, playing: false })
    );
  });

  it('aligns the player when a follower becomes presenter', async () => {
    const { result, socket, video } = await joinRoom();
    act(() => {
      socket.deliver({ type: 'snapshot', snapshot: room() });
    });
    expect(result.current.isPresenter).toBe(false);
    act(() => {
      socket.deliver({
        type: 'snapshot',
        snapshot: room({
          revision: 2,
          controlEpoch: 2,
          presenterId: 'self',
          playback: { position: 2, playing: false, rate: 1, updatedAt: Date.now() },
        }),
      });
    });
    expect(result.current.isPresenter).toBe(true);
    expect(video.currentTime).toBe(2);
  });
});
