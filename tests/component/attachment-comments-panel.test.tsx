import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AttachmentCommentsPanel } from '@/components/video-page/attachment-comments-panel';

const target = { type: 'comment-image' as const, id: 'comment-1', url: '/image/a.png' };
const comment = {
  id: 'file-comment-1',
  content: 'Raise the contrast',
  createdAt: '2026-09-26T09:00:00.000Z',
  author: { id: 'reviewer-1', name: 'Ada', image: null },
  guestName: null,
  canDelete: true,
};

function json(data: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => data } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('AttachmentCommentsPanel', () => {
  it('loads the selected image discussion and preserves a draft after a failed post', async () => {
    let posts = 0;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts += 1;
        return posts === 1 ? json({ error: 'Try again' }, 503) : json({ data: { comment } }, 201);
      }
      return json({
        data: {
          comments: posts > 1 ? [comment] : [],
          total: posts > 1 ? 1 : 0,
          hasMore: false,
          canComment: true,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const changed = vi.fn();
    render(
      <AttachmentCommentsPanel
        videoId="video-1"
        target={target}
        guestName="Guest"
        onCommentsChanged={changed}
      />
    );

    const composer = await screen.findByRole('textbox', { name: 'Comment on this file' });
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toContain('targetType=comment-image');
    expect(requestedUrl).toContain('targetId=comment-1');
    expect(requestedUrl).toContain('imageUrl=%2Fimage%2Fa.png');
    fireEvent.change(composer, { target: { value: 'Raise the contrast' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await screen.findByRole('alert');
    expect(composer).toHaveValue('Raise the contrast');
    expect(changed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await screen.findByText('Raise the contrast');
    expect(composer).toHaveValue('');
    expect(changed).toHaveBeenCalledTimes(1);
    const posted = JSON.parse(
      String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body)
    );
    expect(posted).toEqual({ target, content: 'Raise the contrast', guestName: 'Guest' });
  });

  it('hides the composer when the list response denies comments and deletes an allowed row', async () => {
    let removed = false;
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        removed = true;
        return json({ data: { success: true } });
      }
      return json({
        data: {
          comments: removed ? [] : [comment],
          total: removed ? 0 : 1,
          hasMore: false,
          canComment: false,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const changed = vi.fn();
    render(
      <AttachmentCommentsPanel videoId="video-1" target={target} onCommentsChanged={changed} />
    );
    expect(await screen.findByText('Raise the contrast')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Comment on this file' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete comment' }));
    await waitFor(() => expect(screen.queryByText('Raise the contrast')).not.toBeInTheDocument());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(true);
  });
  it('pins playback time while drafting and retrying, seeks a saved time, and supports general comments', async () => {
    let currentTime = 65.5;
    const bodies: Array<{ timestamp: number | null }> = [];
    const timedComment = { ...comment, timestamp: 65.5 };
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        return bodies.length === 1
          ? json({ error: 'Try again' }, 503)
          : json({ data: { comment: timedComment } }, 201);
      }
      return json({
        data: {
          comments: bodies.length > 1 ? [timedComment] : [],
          total: bodies.length > 1 ? 1 : 0,
          hasMore: false,
          canComment: true,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const pause = vi.fn();
    const seek = vi.fn();
    const props = {
      videoId: 'video-1',
      target: { type: 'comment-audio' as const, id: 'voice-1' },
      onCommentsChanged: vi.fn(),
      timedMedia: true,
      getPlaybackTime: () => currentTime,
      onPausePlayback: pause,
      onSeekTimestamp: seek,
    };
    const { rerender } = render(<AttachmentCommentsPanel {...props} playbackTime={currentTime} />);
    const composer = await screen.findByRole('textbox', { name: 'Comment on this file' });
    fireEvent.change(composer, { target: { value: 'Quiet this section' } });
    expect(pause).toHaveBeenCalledTimes(1);
    currentTime = 90;
    rerender(<AttachmentCommentsPanel {...props} playbackTime={currentTime} />);
    expect(screen.getByRole('button', { name: 'Remove timestamp' })).toHaveTextContent('At 1:05');
    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await screen.findByRole('alert');
    expect(bodies[0].timestamp).toBe(65.5);
    currentTime = 120;
    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    const jump = await screen.findByRole('button', { name: 'Jump to 1:05' });
    expect(bodies[1].timestamp).toBe(65.5);
    fireEvent.click(jump);
    expect(seek).toHaveBeenCalledWith(65.5);
    fireEvent.click(screen.getByRole('button', { name: 'Remove timestamp' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Whole file note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2].timestamp).toBeNull();
  });

  it('preserves a zero timestamp and refuses to silently timestamp unavailable playback', async () => {
    let currentTime: number | null = null;
    const bodies: Array<{ timestamp: number | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          bodies.push(JSON.parse(String(init.body)));
          return json({ data: { comment } }, 201);
        }
        return json({ data: { comments: [], total: 0, hasMore: false, canComment: true } });
      })
    );
    render(
      <AttachmentCommentsPanel
        videoId="video-1"
        target={{ type: 'comment-audio', id: 'voice-1' }}
        onCommentsChanged={vi.fn()}
        timedMedia
        getPlaybackTime={() => currentTime}
      />
    );
    const composer = await screen.findByRole('textbox');
    fireEvent.change(composer, { target: { value: 'Start here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await screen.findByRole('alert');
    expect(bodies).toHaveLength(0);
    currentTime = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].timestamp).toBe(0);
  });
});
