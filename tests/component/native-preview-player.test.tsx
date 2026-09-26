import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NativePreviewPlayer } from '@/components/video-page/native-preview-player';

afterEach(() => vi.restoreAllMocks());

describe('NativePreviewPlayer', () => {
  it('keeps playback usable when pausing aborts a pending play request', async () => {
    let rejectPlay!: (reason: unknown) => void;
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPlay = reject;
        })
    );
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const { container } = render(
      <NativePreviewPlayer src="/audio.wav" title="Recording" kind="AUDIO" />
    );
    const media = container.querySelector('audio')!;
    Object.defineProperty(media, 'duration', { configurable: true, value: 90 });
    Object.defineProperty(media, 'paused', { configurable: true, value: true });
    fireEvent.loadedMetadata(media);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    Object.defineProperty(media, 'paused', { configurable: true, value: false });
    fireEvent.play(media);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(pause).toHaveBeenCalledTimes(1);
    fireEvent.pause(media);
    await act(async () => {
      rejectPlay(new DOMException('Playback interrupted', 'AbortError'));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Seek playback' })).toBeEnabled();
  });
});
