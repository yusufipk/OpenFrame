import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { LiveReviewBar, LiveReviewEntryControl } from '@/components/video-page/live-review-bar';
import {
  LiveReviewCanvas,
  getVideoContentRect,
  pointInContent,
} from '@/components/video-page/live-review-canvas';
import type { LiveDiscovery, LiveStroke } from '@/lib/live-review/protocol';

const box = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;
const own: LiveStroke = {
  id: 'mine',
  participantId: 'me',
  points: [
    { x: 0.1, y: 0.2 },
    { x: 0.3, y: 0.4 },
  ],
  color: '#ff0000',
  width: 3,
};
const other: LiveStroke = { ...own, id: 'theirs', participantId: 'other' };

describe('live review drawing coordinates', () => {
  it('maps a portrait image inside a letterboxed video and ignores black bars', () => {
    const video = document.createElement('video');
    const container = document.createElement('div');
    Object.defineProperties(video, { videoWidth: { value: 1080 }, videoHeight: { value: 1920 } });
    video.getBoundingClientRect = () => box(100, 50, 800, 600);
    container.getBoundingClientRect = () => box(100, 50, 800, 600);
    expect(getVideoContentRect(video, container)).toEqual({
      left: 231.25,
      top: 0,
      width: 337.5,
      height: 600,
    });
    expect(pointInContent(200, 350, box(331.25, 50, 337.5, 600))).toBeNull();
    expect(pointInContent(500, 350, box(331.25, 50, 337.5, 600))).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('LiveReviewCanvas', () => {
  const video = document.createElement('video');
  const videoRef = createRef<HTMLVideoElement>();
  Object.defineProperty(videoRef, 'current', { value: video });
  const onStroke = vi.fn();
  const onUndo = vi.fn();
  const onClear = vi.fn();
  const onSave = vi.fn().mockResolvedValue(undefined);
  const controlsContainer = document.createElement('div');
  beforeEach(() => document.body.append(controlsContainer));
  const base = {
    controlsContainer,
    strokes: [own, other],
    canvasEpoch: 1,
    participantId: 'me',
    canDraw: true,
    isPaused: true,
    isManager: false,
    videoRef,
    onStroke,
    onUndo,
    onClear,
    onSave,
  };
  const originalBounds = Element.prototype.getBoundingClientRect;

  afterEach(() => {
    controlsContainer.remove();
    Element.prototype.getBoundingClientRect = originalBounds;
    vi.restoreAllMocks();
    onStroke.mockReset();
    onUndo.mockReset();
    onClear.mockReset();
    onSave.mockClear();
  });

  it('saves only the participant own strokes at the paused timestamp', async () => {
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
      currentTime: { configurable: true, value: 12.5 },
    });
    Element.prototype.getBoundingClientRect = () => box(0, 0, 800, 450);
    render(<LiveReviewCanvas {...base} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save drawing as comment' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([own], 12.5));
    const saved = await screen.findByRole('button', { name: 'Saved as comment' });
    expect(saved).toBeDisabled();
    fireEvent.click(saved);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('keeps controls outside the video and only captures strokes in Stroke Mode', async () => {
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    Element.prototype.getBoundingClientRect = () => box(0, 0, 800, 450);
    const { container } = render(<LiveReviewCanvas {...base} strokes={[]} />);
    const canvas = await screen.findByLabelText('Shared drawing canvas');
    expect(container.querySelector('button')).toBeNull();
    expect(controlsContainer.querySelectorAll('button')).toHaveLength(3);
    expect(canvas).toHaveClass('pointer-events-none');
    fireEvent.pointerDown(canvas, { clientX: 80, clientY: 45, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 160, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 160, clientY: 90, pointerId: 1 });
    expect(onStroke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stroke Mode' }));
    expect(canvas).toHaveClass('pointer-events-auto');
    fireEvent.pointerDown(canvas, { clientX: 80, clientY: 45, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 160, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 160, clientY: 90, pointerId: 1 });
    expect(onStroke).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stroke Mode' }));
    expect(canvas).toHaveClass('pointer-events-none');
  });

  it('exits Stroke Mode when the comments composer unmounts', async () => {
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    Element.prototype.getBoundingClientRect = () => box(0, 0, 800, 450);
    const { rerender } = render(<LiveReviewCanvas {...base} />);
    const canvas = await screen.findByLabelText('Shared drawing canvas');
    fireEvent.click(screen.getByRole('button', { name: 'Stroke Mode' }));
    expect(canvas).toHaveClass('pointer-events-auto');
    rerender(<LiveReviewCanvas {...base} controlsContainer={null} />);
    expect(canvas).toHaveClass('pointer-events-none');
    rerender(<LiveReviewCanvas {...base} />);
    expect(screen.getByRole('button', { name: 'Stroke Mode' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(canvas).toHaveClass('pointer-events-none');
  });

  it('discards local drawing when the canvas epoch changes', async () => {
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    Element.prototype.getBoundingClientRect = () => box(0, 0, 800, 450);
    const { rerender } = render(<LiveReviewCanvas {...base} strokes={[]} />);
    const canvas = await screen.findByLabelText('Shared drawing canvas');
    fireEvent.click(screen.getByRole('button', { name: 'Stroke Mode' }));
    fireEvent.pointerDown(canvas, { clientX: 80, clientY: 45, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 160, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 160, clientY: 90, pointerId: 1 });
    expect(canvas.querySelectorAll('path')).toHaveLength(1);
    rerender(<LiveReviewCanvas {...base} strokes={[]} canvasEpoch={2} />);
    await waitFor(() => expect(canvas.querySelectorAll('path')).toHaveLength(0));
    expect(onStroke.mock.calls.at(-1)?.[1]).toBe(1);
  });

  it('removes a rejected stroke during drag and does not restore it on pointer release', async () => {
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    Element.prototype.getBoundingClientRect = () => box(0, 0, 800, 450);
    vi.spyOn(performance, 'now').mockReturnValue(100);
    const { rerender } = render(<LiveReviewCanvas {...base} strokes={[]} />);
    const canvas = await screen.findByLabelText('Shared drawing canvas');
    fireEvent.click(screen.getByRole('button', { name: 'Stroke Mode' }));
    fireEvent.pointerDown(canvas, { clientX: 80, clientY: 45, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 160, clientY: 90, pointerId: 1 });
    const strokeId = onStroke.mock.calls[0]?.[0].id as string;
    expect(strokeId).toBeTruthy();
    rerender(
      <LiveReviewCanvas {...base} strokes={[]} rejectedStroke={{ id: strokeId, sequence: 1 }} />
    );
    await waitFor(() => expect(canvas.querySelectorAll('path')).toHaveLength(0));
    fireEvent.pointerUp(canvas, { clientX: 160, clientY: 90, pointerId: 1 });
    expect(canvas.querySelectorAll('path')).toHaveLength(0);
    expect(onStroke).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Save drawing as comment' })).toBeDisabled();
  });

  it('does not offer drawing controls while playback is running', () => {
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    Element.prototype.getBoundingClientRect = () => box(0, 0, 800, 450);
    render(<LiveReviewCanvas {...base} isPaused={false} />);
    expect(screen.getByRole('button', { name: 'Save drawing as comment' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stroke Mode' })).toBeDisabled();
  });

  it('keeps a drawing click from toggling the underlying player', async () => {
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    Element.prototype.getBoundingClientRect = () => box(0, 0, 800, 450);
    const onPlayerClick = vi.fn();
    render(
      <div onClick={onPlayerClick}>
        <LiveReviewCanvas {...base} />
      </div>
    );
    fireEvent.click(await screen.findByLabelText('Shared drawing canvas'));
    expect(onPlayerClick).not.toHaveBeenCalled();
  });
});

describe('LiveReviewBar', () => {
  const discovery: LiveDiscovery = {
    enabled: true,
    available: true,
    canStart: true,
    session: null,
  };
  const actions = {
    onStart: vi.fn(),
    onJoin: vi.fn(),
    onLeave: vi.fn(),
    onTransfer: vi.fn(),
    onEnd: vi.fn(),
    onRetryPlayback: vi.fn(),
  };
  const base = {
    discovery,
    provider: 'r2',
    snapshot: null,
    participantId: null,
    connection: 'idle' as const,
    isJoined: false,
    ...actions,
  };

  it('keeps idle controls in the header without a room bar', () => {
    const { rerender } = render(
      <>
        <LiveReviewEntryControl {...base} />
        <LiveReviewBar {...base} />
      </>
    );
    expect(screen.queryByRole('region', { name: 'Live review' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start room' }));
    expect(actions.onStart).toHaveBeenCalledTimes(1);
    rerender(<LiveReviewEntryControl {...base} discovery={{ ...discovery, enabled: false }} />);
    expect(screen.queryByRole('button', { name: 'Start room' })).toBeNull();
    rerender(<LiveReviewEntryControl {...base} provider="youtube" />);
    expect(screen.queryByRole('button', { name: 'Start room' })).toBeNull();
  });

  it('blocks room creation while unavailable without an explanatory row', () => {
    render(<LiveReviewEntryControl {...base} discovery={{ ...discovery, available: false }} />);
    const button = screen.getByRole('button', { name: 'Start room' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Live review is unavailable right now');
  });
});
