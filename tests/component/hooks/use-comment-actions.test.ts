import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState, type ChangeEvent, type ClipboardEvent } from 'react';
import { act, renderHook, type RenderHookResult } from '@testing-library/react';
import { useCommentActions } from '@/components/video-page/hooks/use-comment-actions';
import type { Comment, CommentTag, VideoData } from '@/components/video-page/types';
import { buildLiveWebm, readWebmDuration } from '../../helpers/webm-fixture';

const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

type Params = Parameters<typeof useCommentActions>[0];

const ACTIVE_VERSION = 'ver1';
const TAGS: CommentTag[] = [
  { id: 'tag-audio', name: 'Audio', color: '#f00' },
  { id: 'tag-colour', name: 'Colour', color: '#0f0' },
];

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c1',
    content: 'Existing note',
    timestamp: 5,
    timestampEnd: null,
    voiceUrl: null,
    voiceDuration: null,
    images: [],
    annotationData: null,
    isResolved: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    author: { id: 'user1', name: 'Ada', image: null },
    guestName: null,
    canEdit: true,
    canDelete: true,
    tag: TAGS[0],
    replies: [],
    ...overrides,
  };
}

function makeVideo(): VideoData {
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
        id: ACTIVE_VERSION,
        versionNumber: 1,
        versionLabel: null,
        providerId: 'bunny',
        videoId: 'vid1',
        originalUrl: 'https://cdn.example.com/a.mp4',
        title: null,
        thumbnailUrl: null,
        duration: 600,
        isActive: true,
        _count: { comments: 2 },
        comments: [
          makeComment({
            id: 'c1',
            replies: [
              {
                id: 'r1',
                content: 'Agreed',
                timestamp: 5,
                timestampEnd: null,
                voiceUrl: null,
                voiceDuration: null,
                images: [],
                annotationData: null,
                createdAt: '2026-01-01T00:01:00.000Z',
                author: { id: 'user2', name: 'Linus', image: null },
                guestName: null,
                canEdit: false,
                canDelete: false,
                tag: null,
              },
            ],
          }),
          makeComment({ id: 'c2', content: 'Already handled', isResolved: true, replies: [] }),
        ],
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
        duration: 600,
        isActive: false,
        _count: { comments: 1 },
        comments: [makeComment({ id: 'other', content: 'On another version' })],
      },
    ],
  };
}

function ok(payload: unknown) {
  return { ok: true, json: () => Promise.resolve(payload) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let fetchMock: ReturnType<typeof vi.fn>;
let serverComment: Comment;
let stableDeps: Pick<
  Params,
  | 'setSelectedTagId'
  | 'setAnnotationStrokes'
  | 'setIsAnnotating'
  | 'setViewingAnnotation'
  | 'fetchVersionComments'
  | 'fetchAssets'
>;

function useHarness(overrides: Partial<Params>) {
  const [video, setVideo] = useState<VideoData | null>(makeVideo());
  const activeVersion = video?.versions.find((v) => v.id === ACTIVE_VERSION);
  const actions = useCommentActions({
    videoId: 'vid1',
    setVideo,
    activeVersionId: ACTIVE_VERSION,
    activeVersion,
    currentTime: 12,
    isGuest: false,
    normalizedGuestName: '',
    currentUserName: 'Ada',
    canResolveComments: true,
    availableTags: TAGS,
    selectedTagId: null,
    annotationStrokes: null,
    isAnnotating: false,
    annotationCanvasRef: { current: null },
    editAnnotationCanvasRef: { current: null },
    ...stableDeps,
    ...overrides,
  });
  return { video, actions };
}

type Harness = RenderHookResult<ReturnType<typeof useHarness>, Partial<Params>>;

function renderActions(overrides: Partial<Params> = {}): Harness {
  return renderHook((props: Partial<Params>) => useHarness(props), { initialProps: overrides });
}

function comments(harness: Harness): Comment[] {
  const version = harness.result.current.video?.versions.find((v) => v.id === ACTIVE_VERSION);
  return version?.comments ?? [];
}

function commentIds(harness: Harness): string[] {
  return comments(harness).map((c) => c.id);
}

function findComment(harness: Harness, id: string): Comment | undefined {
  return comments(harness).find((c) => c.id === id);
}

function otherVersionComments(harness: Harness): Comment[] {
  return harness.result.current.video?.versions.find((v) => v.id === 'ver2')?.comments ?? [];
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as { body: string }).body);
}

function callsTo(url: string, method?: string) {
  return fetchMock.mock.calls.filter(
    (call) => call[0] === url && (method === undefined || call[1]?.method === method)
  );
}

beforeEach(() => {
  serverComment = makeComment({ id: 'c-server', content: 'Colour is off', timestamp: 12 });
  stableDeps = {
    setSelectedTagId: vi.fn(),
    setAnnotationStrokes: vi.fn(),
    setIsAnnotating: vi.fn(),
    setViewingAnnotation: vi.fn(),
    fetchVersionComments: vi.fn().mockResolvedValue(undefined),
    fetchAssets: vi.fn().mockResolvedValue(undefined),
  };
  fetchMock = vi.fn((url: string) => {
    if (url === '/api/upload/image') {
      return Promise.resolve(ok({ data: { url: 'https://cdn.example.com/note.png' } }));
    }
    if (url === '/api/upload/audio') {
      return Promise.resolve(ok({ data: { url: 'https://cdn.example.com/note.webm' } }));
    }
    if (url === '/api/watch/vid1/upload-token') {
      return Promise.resolve(ok({ data: { token: 'guest-token' } }));
    }
    if (url === `/api/versions/${ACTIVE_VERSION}/comments`) {
      return Promise.resolve(ok({ data: serverComment }));
    }
    return Promise.resolve(ok({ data: {} }));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toastError.mockReset();
  toastSuccess.mockReset();
});

describe('useCommentActions adding a comment', () => {
  it('attaches the current live drawing to the typed comment at its video timestamp', async () => {
    const strokes = [{ points: [{ x: 0.2, y: 0.4 }], color: '#007AFF', width: 5 }];
    const harness = renderActions({
      getAnnotationForComment: () => ({ strokes, timestamp: 18.5 }),
    });
    act(() => harness.result.current.actions.setCommentText('Fix this edge'));
    await act(async () => {
      await harness.result.current.actions.handleAddComment();
    });
    expect(bodyOf(callsTo(`/api/versions/${ACTIVE_VERSION}/comments`, 'POST')[0])).toMatchObject({
      content: 'Fix this edge',
      annotationData: strokes,
      timestamp: 18.5,
    });
    expect(stableDeps.setViewingAnnotation).toHaveBeenCalledWith(null);
  });

  it('does not attach stale normal annotations when the live canvas has no available drawing', async () => {
    const harness = renderActions({
      annotationStrokes: [{ points: [{ x: 0.1, y: 0.1 }], color: '#ff0000', width: 3 }],
      getAnnotationForComment: () => null,
    });
    act(() => harness.result.current.actions.setCommentText('Plain live comment'));
    await act(async () => {
      await harness.result.current.actions.handleAddComment();
    });
    expect(
      bodyOf(callsTo(`/api/versions/${ACTIVE_VERSION}/comments`, 'POST')[0])
    ).not.toHaveProperty('annotationData');
  });

  it('shows the comment before the server answers, then swaps in the saved row', async () => {
    const pendingRequest = deferred<unknown>();
    fetchMock.mockReturnValue(pendingRequest.promise);
    const harness = renderActions();

    act(() => harness.result.current.actions.setCommentText('Colour is off'));

    let submitted: Promise<void> | undefined;
    act(() => {
      submitted = harness.result.current.actions.handleAddComment();
    });

    expect(commentIds(harness)).toHaveLength(3);
    const optimistic = comments(harness)[2];
    expect(optimistic.id).toMatch(/^temp-/);
    expect(optimistic.content).toBe('Colour is off');
    expect(optimistic.timestamp).toBe(12);
    expect(optimistic.isResolved).toBe(false);
    expect(optimistic.author).toEqual({ id: 'current-user', name: 'Ada', image: null });
    expect(harness.result.current.actions.commentText).toBe('');
    expect(harness.result.current.actions.isSubmittingComment).toBe(true);

    await act(async () => {
      pendingRequest.resolve(ok({ data: serverComment }));
      await submitted;
    });

    expect(commentIds(harness)).toEqual(['c1', 'c2', 'c-server']);
    expect(harness.result.current.actions.isSubmittingComment).toBe(false);
  });

  it('posts the text, timestamp and tag to the active version', async () => {
    const harness = renderActions({ selectedTagId: 'tag-colour' });

    act(() => harness.result.current.actions.setCommentText('Colour is off'));
    await act(async () => {
      await harness.result.current.actions.handleAddComment();
    });

    const call = callsTo(`/api/versions/${ACTIVE_VERSION}/comments`, 'POST')[0];
    expect(bodyOf(call)).toEqual({
      content: 'Colour is off',
      timestamp: 12,
      tagId: 'tag-colour',
    });
  });

  it('rolls the comment back out of the list when the server rejects it', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    const harness = renderActions();

    act(() => harness.result.current.actions.setCommentText('Colour is off'));
    await act(async () => {
      await harness.result.current.actions.handleAddComment();
    });

    expect(commentIds(harness)).toEqual(['c1', 'c2']);
    expect(toastError).toHaveBeenCalledWith('Failed to add comment');
    expect(harness.result.current.actions.isSubmittingComment).toBe(false);
  });

  // The attachment goes up before the comment does, so a full account fails on
  // the image and never reaches the comment at all. Reporting that as a comment
  // that would not post told the uploader to try again, which is the one thing
  // that cannot work.
  it('reads out the storage error the attachment upload came back with', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/upload/image') {
        return Promise.resolve({
          ok: false,
          status: 507,
          json: () =>
            Promise.resolve({
              error: 'Storage limit exceeded. Please delete some files to free up space.',
            }),
        });
      }
      return Promise.resolve(ok({ data: serverComment }));
    });
    const harness = renderActions();

    // A one-pixel PNG header is enough: the client only sniffs the magic bytes.
    const png = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      'n.png',
      {
        type: 'image/png',
      }
    );
    await act(async () => {
      await harness.result.current.actions.handleImageSelect({
        target: { files: [png] },
      } as unknown as ChangeEvent<HTMLInputElement>);
    });

    act(() => harness.result.current.actions.setCommentText('Colour is off'));
    await act(async () => {
      await harness.result.current.actions.handleAddComment();
    });

    expect(toastError).toHaveBeenCalledWith(
      'Storage limit exceeded. Please delete some files to free up space.'
    );
    expect(commentIds(harness)).toEqual(['c1', 'c2']);
  });

  it('reads out the storage error the comment itself came back with', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 507,
      json: () =>
        Promise.resolve({
          error: 'Storage limit exceeded. Please delete some files to free up space.',
        }),
    });
    const harness = renderActions();

    act(() => harness.result.current.actions.setCommentText('Colour is off'));
    await act(async () => {
      await harness.result.current.actions.handleAddComment();
    });

    expect(toastError).toHaveBeenCalledWith(
      'Storage limit exceeded. Please delete some files to free up space.'
    );
  });

  it('rolls the comment back out of the list when the request throws', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const harness = renderActions();

    act(() => harness.result.current.actions.setCommentText('Colour is off'));
    await act(async () => {
      await harness.result.current.actions.handleAddComment();
    });

    expect(commentIds(harness)).toEqual(['c1', 'c2']);
    expect(toastError).toHaveBeenCalledWith('Failed to add comment');
  });

  it('leaves other versions untouched on both success and rollback', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    const harness = renderActions();

    act(() => harness.result.current.actions.setCommentText('Colour is off'));
    await act(async () => {
      await harness.result.current.actions.handleAddComment();
    });

    expect(otherVersionComments(harness).map((c) => c.id)).toEqual(['other']);
  });

  it('refuses to post an empty or whitespace-only comment', async () => {
    const harness = renderActions();

    act(() => harness.result.current.actions.setCommentText('   '));
    await act(async () => {
      await harness.result.current.actions.handleAddComment();
    });

    expect(callsTo(`/api/versions/${ACTIVE_VERSION}/comments`, 'POST')).toHaveLength(0);
    expect(commentIds(harness)).toEqual(['c1', 'c2']);
  });

  it('does nothing while no version is loaded', async () => {
    const harness = renderActions({ activeVersion: undefined });

    act(() => harness.result.current.actions.setCommentText('Colour is off'));
    await act(async () => {
      await harness.result.current.actions.handleAddComment();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resets the tag picker to the first tag rather than to none', async () => {
    const harness = renderActions({ selectedTagId: 'tag-colour' });

    act(() => harness.result.current.actions.setCommentText('Colour is off'));
    await act(async () => {
      await harness.result.current.actions.handleAddComment();
    });

    expect(stableDeps.setSelectedTagId).toHaveBeenCalledWith('tag-audio');
  });

  it('identifies a guest by name instead of by author', async () => {
    const harness = renderActions({ isGuest: true, normalizedGuestName: 'Kerem' });

    act(() => harness.result.current.actions.setCommentText('Nice'));

    let submitted: Promise<void> | undefined;
    act(() => {
      submitted = harness.result.current.actions.handleAddComment();
    });

    const optimistic = comments(harness)[2];
    expect(optimistic.author).toBeNull();
    expect(optimistic.guestName).toBe('Kerem');

    await act(async () => {
      await submitted;
    });

    const call = callsTo(`/api/versions/${ACTIVE_VERSION}/comments`, 'POST')[0];
    expect(bodyOf(call).guestName).toBe('Kerem');
  });

  it('sends a range comment with both ends', async () => {
    const harness = renderActions();

    // First toggle opens the range at the current time, second closes it.
    act(() => harness.result.current.actions.toggleCommentRangeSelection());
    harness.rerender({ currentTime: 30 });
    act(() => harness.result.current.actions.toggleCommentRangeSelection());

    expect(harness.result.current.actions.commentRangeStart).toBe(12);
    expect(harness.result.current.actions.commentRangeEnd).toBe(30);

    act(() => harness.result.current.actions.setCommentText('Fix this stretch'));
    await act(async () => {
      await harness.result.current.actions.handleAddComment();
    });

    const call = callsTo(`/api/versions/${ACTIVE_VERSION}/comments`, 'POST')[0];
    expect(bodyOf(call)).toMatchObject({ timestamp: 12, timestampEnd: 30 });
    expect(harness.result.current.actions.commentRangeStart).toBeNull();
    expect(harness.result.current.actions.commentRangeEnd).toBeNull();
  });

  it('orders a backwards range selection low to high', () => {
    const harness = renderActions({ currentTime: 30 });

    act(() => harness.result.current.actions.toggleCommentRangeSelection());
    harness.rerender({ currentTime: 10 });
    act(() => harness.result.current.actions.toggleCommentRangeSelection());

    expect(harness.result.current.actions.commentRangeStart).toBe(10);
    expect(harness.result.current.actions.commentRangeEnd).toBe(30);
  });

  it('restarts the range when toggled a third time', () => {
    const harness = renderActions();

    act(() => harness.result.current.actions.toggleCommentRangeSelection());
    harness.rerender({ currentTime: 30 });
    act(() => harness.result.current.actions.toggleCommentRangeSelection());
    harness.rerender({ currentTime: 44 });
    act(() => harness.result.current.actions.toggleCommentRangeSelection());

    expect(harness.result.current.actions.commentRangeStart).toBe(44);
    expect(harness.result.current.actions.commentRangeEnd).toBeNull();
  });
});

describe('useCommentActions replying', () => {
  const serverReply = {
    id: 'r-server',
    content: 'On it',
    timestamp: 12,
    timestampEnd: null,
    voiceUrl: null,
    voiceDuration: null,
    images: [],
    annotationData: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    author: { id: 'user1', name: 'Ada', image: null },
    guestName: null,
    canEdit: true,
    canDelete: true,
    tag: null,
  };

  it('nests the optimistic reply under its parent, and nowhere else', async () => {
    const pendingRequest = deferred<unknown>();
    fetchMock.mockReturnValue(pendingRequest.promise);
    const harness = renderActions();

    act(() => harness.result.current.actions.setReplyText('On it'));
    let submitted: Promise<void> | undefined;
    act(() => {
      submitted = harness.result.current.actions.handleReplyComment('c1');
    });

    expect(findComment(harness, 'c1')?.replies.map((r) => r.id)).toEqual([
      'r1',
      expect.stringMatching(/^temp-reply-/),
    ]);
    expect(findComment(harness, 'c2')?.replies).toEqual([]);
    expect(harness.result.current.actions.replyText).toBe('');
    expect(harness.result.current.actions.replyingTo).toBeNull();
    expect(harness.result.current.actions.isSubmittingReply).toBe(true);

    await act(async () => {
      pendingRequest.resolve(ok({ data: serverReply }));
      await submitted;
    });

    expect(findComment(harness, 'c1')?.replies.map((r) => r.id)).toEqual(['r1', 'r-server']);
  });

  it('posts the reply with its parent id', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(ok({ data: serverReply })));
    const harness = renderActions();

    act(() => harness.result.current.actions.setReplyText('On it'));
    await act(async () => {
      await harness.result.current.actions.handleReplyComment('c1');
    });

    const call = callsTo(`/api/versions/${ACTIVE_VERSION}/comments`, 'POST')[0];
    expect(bodyOf(call)).toEqual({ content: 'On it', timestamp: 12, parentId: 'c1' });
  });

  it('removes only the failed reply and keeps the parent comment', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    const harness = renderActions();

    act(() => harness.result.current.actions.setReplyText('On it'));
    await act(async () => {
      await harness.result.current.actions.handleReplyComment('c1');
    });

    expect(commentIds(harness)).toEqual(['c1', 'c2']);
    expect(findComment(harness, 'c1')?.replies.map((r) => r.id)).toEqual(['r1']);
    expect(toastError).toHaveBeenCalledWith('Failed to add reply');
  });

  it('removes the failed reply when the request throws', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const harness = renderActions();

    act(() => harness.result.current.actions.setReplyText('On it'));
    await act(async () => {
      await harness.result.current.actions.handleReplyComment('c1');
    });

    expect(findComment(harness, 'c1')?.replies.map((r) => r.id)).toEqual(['r1']);
    expect(toastError).toHaveBeenCalledWith('Failed to add reply');
  });

  it('refuses to post an empty reply', async () => {
    const harness = renderActions();

    act(() => harness.result.current.actions.setReplyText('  '));
    await act(async () => {
      await harness.result.current.actions.handleReplyComment('c1');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(findComment(harness, 'c1')?.replies).toHaveLength(1);
  });

  it('keeps its own range selection separate from the comment composer', () => {
    const harness = renderActions();

    act(() => harness.result.current.actions.toggleReplyRangeSelection());
    harness.rerender({ currentTime: 30 });
    act(() => harness.result.current.actions.toggleReplyRangeSelection());

    expect(harness.result.current.actions.replyRangeStart).toBe(12);
    expect(harness.result.current.actions.replyRangeEnd).toBe(30);
    expect(harness.result.current.actions.commentRangeStart).toBeNull();
  });
});

describe('useCommentActions resolving', () => {
  it('flips the comment immediately and tells the server the new value', async () => {
    const pendingRequest = deferred<unknown>();
    fetchMock.mockReturnValue(pendingRequest.promise);
    const harness = renderActions();

    let submitted: Promise<void> | undefined;
    act(() => {
      submitted = harness.result.current.actions.handleResolveComment('c1', false);
    });

    expect(findComment(harness, 'c1')?.isResolved).toBe(true);

    await act(async () => {
      pendingRequest.resolve(ok({ data: {} }));
      await submitted;
    });

    const call = callsTo('/api/comments/c1', 'PATCH')[0];
    expect(bodyOf(call)).toEqual({ isResolved: true });
    expect(findComment(harness, 'c1')?.isResolved).toBe(true);
  });

  it('unresolves an already resolved comment', async () => {
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.handleResolveComment('c2', true);
    });

    expect(bodyOf(callsTo('/api/comments/c2', 'PATCH')[0])).toEqual({ isResolved: false });
    expect(findComment(harness, 'c2')?.isResolved).toBe(false);
  });

  it('reverts the flip when the request fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.handleResolveComment('c1', false);
    });

    expect(findComment(harness, 'c1')?.isResolved).toBe(false);
    expect(toastError).toHaveBeenCalledWith('Failed to update comment');
  });

  it('reverts the flip when the request throws', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.handleResolveComment('c1', false);
    });

    expect(findComment(harness, 'c1')?.isResolved).toBe(false);
    expect(toastError).toHaveBeenCalledWith('Failed to update comment');
  });

  it('refuses non-admins without touching state or the network', async () => {
    const harness = renderActions({ canResolveComments: false });

    await act(async () => {
      await harness.result.current.actions.handleResolveComment('c1', false);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(findComment(harness, 'c1')?.isResolved).toBe(false);
    expect(toastError).toHaveBeenCalledWith('Only admins can resolve comments');
  });

  // KNOWN FRAGILITY, pinned rather than fixed. The optimistic flip is relative
  // (`!c.isResolved`) but both the request body and the rollback are absolute,
  // derived from the caller's `currentlyResolved` argument. When the two
  // disagree the rollback restores a value the comment never had: here an
  // unresolved comment ends up resolved after a FAILED request.
  it('rolls back to the caller-supplied value, not the value it started at', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    const harness = renderActions();

    expect(findComment(harness, 'c1')?.isResolved).toBe(false);
    await act(async () => {
      await harness.result.current.actions.handleResolveComment('c1', true);
    });

    expect(bodyOf(callsTo('/api/comments/c1', 'PATCH')[0])).toEqual({ isResolved: false });
    expect(findComment(harness, 'c1')?.isResolved).toBe(true);
  });
});

describe('useCommentActions deleting', () => {
  it('removes the comment at once and keeps it gone when the server agrees', async () => {
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.handleDeleteComment('c1');
    });

    expect(callsTo('/api/comments/c1', 'DELETE')).toHaveLength(1);
    expect(commentIds(harness)).toEqual(['c2']);
  });

  it('removes a reply by id without removing its parent', async () => {
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.handleDeleteComment('r1');
    });

    expect(commentIds(harness)).toEqual(['c1', 'c2']);
    expect(findComment(harness, 'c1')?.replies).toEqual([]);
  });

  it('puts the comment back when the delete fails', async () => {
    fetchMock.mockResolvedValue({ ok: false });
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.handleDeleteComment('c1');
    });

    expect(commentIds(harness)).toEqual(['c1', 'c2']);
    expect(findComment(harness, 'c1')?.replies.map((r) => r.id)).toEqual(['r1']);
  });

  it('puts the comment back when the delete throws', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.handleDeleteComment('c1');
    });

    expect(commentIds(harness)).toEqual(['c1', 'c2']);
  });
});

describe('useCommentActions editing', () => {
  it('applies the new text only after the server confirms', async () => {
    const pendingRequest = deferred<unknown>();
    fetchMock.mockReturnValue(pendingRequest.promise);
    const harness = renderActions();

    act(() => {
      harness.result.current.actions.setEditingCommentId('c1');
      harness.result.current.actions.setEditText('Reworded note');
    });

    let submitted: Promise<void> | undefined;
    act(() => {
      submitted = harness.result.current.actions.handleEditComment('c1');
    });

    // No optimistic update here: the old text is still on screen.
    expect(findComment(harness, 'c1')?.content).toBe('Existing note');
    expect(harness.result.current.actions.isSubmittingEdit).toBe(true);

    await act(async () => {
      pendingRequest.resolve(ok({ data: {} }));
      await submitted;
    });

    expect(findComment(harness, 'c1')?.content).toBe('Reworded note');
    expect(harness.result.current.actions.editingCommentId).toBeNull();
    expect(harness.result.current.actions.editText).toBe('');
  });

  it('leaves the comment alone when the edit fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    const harness = renderActions();

    act(() => harness.result.current.actions.setEditText('Reworded note'));
    await act(async () => {
      await harness.result.current.actions.handleEditComment('c1');
    });

    expect(findComment(harness, 'c1')?.content).toBe('Existing note');
    expect(harness.result.current.actions.isSubmittingEdit).toBe(false);
  });

  it('edits a reply by id', async () => {
    const harness = renderActions();

    act(() => harness.result.current.actions.setEditText('Reworded reply'));
    await act(async () => {
      await harness.result.current.actions.handleEditComment('r1');
    });

    expect(findComment(harness, 'c1')?.replies[0].content).toBe('Reworded reply');
  });

  it('refuses an edit that would blank the comment', async () => {
    const harness = renderActions();

    act(() => harness.result.current.actions.setEditText('   '));
    await act(async () => {
      await harness.result.current.actions.handleEditComment('c1');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(findComment(harness, 'c1')?.content).toBe('Existing note');
  });

  // `editTagId` was initialised to `null`, so the `editTagId !== undefined` guard could
  // never be false: every edit PATCH carried a `tagId` and every success overwrote the
  // comment's tag. The comment editor seeds the value from the comment, but the reply
  // editor sets only editingCommentId and editText, so editing a reply's text silently
  // cleared its tag or applied a stale one. `undefined` now means "not managed here".
  it('sends no tagId when the caller never set one, and leaves the tag alone', async () => {
    const harness = renderActions();

    act(() => harness.result.current.actions.setEditText('Reworded note'));
    await act(async () => {
      await harness.result.current.actions.handleEditComment('c1');
    });

    expect(bodyOf(callsTo('/api/comments/c1', 'PATCH')[0])).toEqual({
      content: 'Reworded note',
      imageUrls: [],
    });
    expect(findComment(harness, 'c1')?.tag).toEqual(TAGS[0]);
  });

  it('sends tagId: null when the editor explicitly clears the tag', async () => {
    const harness = renderActions();

    act(() => {
      harness.result.current.actions.setEditText('Reworded note');
      harness.result.current.actions.setEditTagId(null);
    });
    await act(async () => {
      await harness.result.current.actions.handleEditComment('c1');
    });

    expect(bodyOf(callsTo('/api/comments/c1', 'PATCH')[0])).toEqual({
      content: 'Reworded note',
      imageUrls: [],
      tagId: null,
    });
    expect(findComment(harness, 'c1')?.tag).toBeNull();
  });

  it('keeps the tag when the editor seeded editTagId from the comment', async () => {
    const harness = renderActions();

    act(() => {
      harness.result.current.actions.setEditText('Reworded note');
      harness.result.current.actions.setEditTagId('tag-audio');
    });
    await act(async () => {
      await harness.result.current.actions.handleEditComment('c1');
    });

    expect(bodyOf(callsTo('/api/comments/c1', 'PATCH')[0]).tagId).toBe('tag-audio');
    expect(findComment(harness, 'c1')?.tag).toEqual(TAGS[0]);
  });
});

// A screenshot batch arrives as several clipboard items in one paste, and the
// composer used to keep only the first of them.
describe('useCommentActions image attachments', () => {
  // A one-pixel PNG header is enough: the client only sniffs the magic bytes.
  function pngFile(name: string): File {
    return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], name, {
      type: 'image/png',
    });
  }

  function pasteOf(files: File[]) {
    return {
      clipboardData: {
        items: files.map((file) => ({ type: file.type, getAsFile: () => file })),
      },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent<HTMLTextAreaElement>;
  }

  beforeEach(() => {
    let uploaded = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/upload/image') {
        uploaded += 1;
        return Promise.resolve(ok({ data: { url: `/api/upload/image/shot-${uploaded}.png` } }));
      }
      if (url === `/api/versions/${ACTIVE_VERSION}/comments`) {
        return Promise.resolve(ok({ data: serverComment }));
      }
      return Promise.resolve(ok({ data: {} }));
    });
  });

  it('stages every image in a single paste', async () => {
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.handlePaste(
        pasteOf([pngFile('a.png'), pngFile('b.png'), pngFile('c.png')])
      );
    });

    expect(harness.result.current.actions.imageFiles.map((file) => file.name)).toEqual([
      'a.png',
      'b.png',
      'c.png',
    ]);
  });

  it('stops at the cap and says so', async () => {
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.handlePaste(
        pasteOf(['a', 'b', 'c', 'd', 'e', 'f'].map((name) => pngFile(`${name}.png`)))
      );
    });

    expect(harness.result.current.actions.imageFiles).toHaveLength(5);
    expect(toastError).toHaveBeenCalledWith('Only 5 more images fit on this comment');
  });

  it('uploads each staged image and posts the whole list', async () => {
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.handlePaste(
        pasteOf([pngFile('a.png'), pngFile('b.png')])
      );
    });
    act(() => harness.result.current.actions.setCommentText('Two shots'));
    await act(async () => {
      await harness.result.current.actions.handleAddComment();
    });

    expect(callsTo('/api/upload/image', 'POST')).toHaveLength(2);
    expect(bodyOf(callsTo(`/api/versions/${ACTIVE_VERSION}/comments`, 'POST')[0])).toEqual({
      content: 'Two shots',
      timestamp: 12,
      imageUrls: ['/api/upload/image/shot-1.png', '/api/upload/image/shot-2.png'],
    });
    expect(harness.result.current.actions.imageFiles).toEqual([]);
  });

  it('sends the images a reply was pasted into', async () => {
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.handlePaste(
        pasteOf([pngFile('a.png'), pngFile('b.png')]),
        'reply'
      );
    });
    act(() => harness.result.current.actions.setReplyText('Same here'));
    await act(async () => {
      await harness.result.current.actions.handleReplyComment('c1');
    });

    const body = bodyOf(callsTo(`/api/versions/${ACTIVE_VERSION}/comments`, 'POST')[0]);
    expect(body.parentId).toBe('c1');
    expect(body.imageUrls).toEqual([
      '/api/upload/image/shot-1.png',
      '/api/upload/image/shot-2.png',
    ]);
    // The composer's own staging must not have been touched by a reply paste.
    expect(harness.result.current.actions.imageFiles).toEqual([]);
  });

  it('seeds the editor from the comment and saves only the images left on it', async () => {
    const harness = renderActions();
    const existing = makeComment({
      id: 'c1',
      images: [
        { id: 'i1', url: '/api/upload/image/kept.png' },
        { id: 'i2', url: '/api/upload/image/dropped.png' },
      ],
    });

    act(() => harness.result.current.actions.startEditingComment(existing));
    expect(harness.result.current.actions.editImageUrls).toEqual([
      '/api/upload/image/kept.png',
      '/api/upload/image/dropped.png',
    ]);

    act(() => harness.result.current.actions.removeEditImageUrl('/api/upload/image/dropped.png'));
    await act(async () => {
      await harness.result.current.actions.handleEditComment('c1');
    });

    expect(bodyOf(callsTo('/api/comments/c1', 'PATCH')[0]).imageUrls).toEqual([
      '/api/upload/image/kept.png',
    ]);
    expect(findComment(harness, 'c1')?.images.map((image) => image.url)).toEqual([
      '/api/upload/image/kept.png',
    ]);
  });

  it('uploads an image pasted into an open editor and appends it to the comment', async () => {
    const harness = renderActions();
    const existing = makeComment({
      id: 'c1',
      images: [{ id: 'i1', url: '/api/upload/image/kept.png' }],
    });

    act(() => harness.result.current.actions.startEditingComment(existing));
    await act(async () => {
      await harness.result.current.actions.handlePaste(pasteOf([pngFile('new.png')]), 'edit');
    });

    expect(harness.result.current.actions.editImageFiles).toHaveLength(1);

    await act(async () => {
      await harness.result.current.actions.handleEditComment('c1');
    });

    expect(callsTo('/api/upload/image', 'POST')).toHaveLength(1);
    expect(bodyOf(callsTo('/api/comments/c1', 'PATCH')[0]).imageUrls).toEqual([
      '/api/upload/image/kept.png',
      '/api/upload/image/shot-1.png',
    ]);
    // The editor closes on a successful save, so its staging has to be empty.
    expect(harness.result.current.actions.editImageFiles).toEqual([]);
    expect(harness.result.current.actions.editingCommentId).toBeNull();
  });

  it('counts the images already on the comment against the cap', async () => {
    const harness = renderActions();
    const existing = makeComment({
      id: 'c1',
      images: [
        { id: 'i1', url: '/api/upload/image/one.png' },
        { id: 'i2', url: '/api/upload/image/two.png' },
        { id: 'i3', url: '/api/upload/image/three.png' },
        { id: 'i4', url: '/api/upload/image/four.png' },
      ],
    });

    act(() => harness.result.current.actions.startEditingComment(existing));
    await act(async () => {
      await harness.result.current.actions.handlePaste(
        pasteOf([pngFile('a.png'), pngFile('b.png'), pngFile('c.png')]),
        'edit'
      );
    });

    expect(harness.result.current.actions.editImageFiles).toHaveLength(1);
    expect(toastError).toHaveBeenCalledWith('Only 1 more image fits on this comment');
  });
});

describe('useCommentActions background refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-reads the comment list every 10 seconds', async () => {
    renderActions();

    expect(stableDeps.fetchVersionComments).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9999);
    });
    expect(stableDeps.fetchVersionComments).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(stableDeps.fetchVersionComments).toHaveBeenCalledWith(ACTIVE_VERSION, true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(stableDeps.fetchVersionComments).toHaveBeenCalledTimes(2);
  });

  it('skips the refresh while a write is still in flight', async () => {
    const pendingRequest = deferred<unknown>();
    fetchMock.mockReturnValue(pendingRequest.promise);
    const harness = renderActions();

    act(() => harness.result.current.actions.setCommentText('Colour is off'));
    let submitted: Promise<void> | undefined;
    act(() => {
      submitted = harness.result.current.actions.handleAddComment();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(stableDeps.fetchVersionComments).not.toHaveBeenCalled();

    await act(async () => {
      pendingRequest.resolve(ok({ data: serverComment }));
      await submitted;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(stableDeps.fetchVersionComments).toHaveBeenCalledTimes(1);
  });

  it('skips the refresh while the tab is hidden', async () => {
    renderActions();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(stableDeps.fetchVersionComments).not.toHaveBeenCalled();

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(stableDeps.fetchVersionComments).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });

  it('stops refreshing after unmount', async () => {
    const harness = renderActions();
    harness.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(stableDeps.fetchVersionComments).not.toHaveBeenCalled();
  });
});

// Two bugs lived here. The recording clock counted setInterval ticks, which a
// background tab throttles away, so a recording that kept going looked frozen
// and was saved with the short length. And MediaRecorder writes WebM with no
// duration at all, so the uploaded file played past a length no player knew.
describe('useCommentActions voice recording', () => {
  let recorders: FakeMediaRecorder[];
  let recordedChunk: Uint8Array;

  class FakeMediaRecorder {
    static isTypeSupported = () => true;
    state: 'inactive' | 'recording' = 'inactive';
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor(_stream: unknown, options: { mimeType: string }) {
      this.mimeType = options.mimeType;
      recorders.push(this);
    }

    start() {
      this.state = 'recording';
    }

    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({
        data: new Blob([recordedChunk.buffer as ArrayBuffer], { type: this.mimeType }),
      });
      this.onstop?.();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    recorders = [];
    recordedChunk = buildLiveWebm();
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function durationOf(blob: Blob | null): Promise<number | null> {
    if (!blob) return null;
    return readWebmDuration(new Uint8Array(await blob.arrayBuffer()));
  }

  it('counts the time the tab spent in the background', async () => {
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.startRecording();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(13_000);
    });
    expect(harness.result.current.actions.recordingTime).toBeCloseTo(13, 1);

    // The tab goes to the background: the clock moves on, the interval does not fire.
    vi.setSystemTime(Date.now() + 10_000);
    await act(async () => {
      harness.result.current.actions.stopRecording();
    });

    expect(harness.result.current.actions.recordingTime).toBeCloseTo(23, 1);
  });

  it('saves the comment with the length that was actually recorded', async () => {
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.startRecording();
    });
    vi.setSystemTime(Date.now() + 23_000);
    await act(async () => {
      harness.result.current.actions.stopRecording();
    });
    await act(async () => {
      await harness.result.current.actions.submitCommentWithMedia();
    });

    const [post] = callsTo(`/api/versions/${ACTIVE_VERSION}/comments`, 'POST');
    expect(bodyOf(post).voiceDuration).toBeCloseTo(23, 1);
  });

  it('stamps the recorded length into the uploaded webm', async () => {
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.startRecording();
    });
    expect(await durationOf(new Blob([recordedChunk.buffer as ArrayBuffer]))).toBeNull();

    vi.setSystemTime(Date.now() + 9_000);
    await act(async () => {
      harness.result.current.actions.stopRecording();
    });

    expect(await durationOf(harness.result.current.actions.audioBlob)).toBeCloseTo(9_000, 0);
  });

  it('does the same for a voice reply', async () => {
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.startReplyRecording();
    });
    vi.setSystemTime(Date.now() + 17_000);
    await act(async () => {
      harness.result.current.actions.stopReplyRecording();
    });

    expect(harness.result.current.actions.replyRecordingTime).toBeCloseTo(17, 1);
    expect(await durationOf(harness.result.current.actions.replyAudioBlob)).toBeCloseTo(17_000, 0);
  });

  it('leaves a non-webm recording untouched', async () => {
    recordedChunk = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]); // MP4 'ftyp'
    const originalIsTypeSupported = FakeMediaRecorder.isTypeSupported;
    FakeMediaRecorder.isTypeSupported = () => false;
    const harness = renderActions();

    await act(async () => {
      await harness.result.current.actions.startRecording();
    });
    vi.setSystemTime(Date.now() + 4_000);
    await act(async () => {
      harness.result.current.actions.stopRecording();
    });

    const blob = harness.result.current.actions.audioBlob!;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(recordedChunk);
    FakeMediaRecorder.isTypeSupported = originalIsTypeSupported;
  });
});
