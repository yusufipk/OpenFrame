import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, type RenderHookResult } from '@testing-library/react';
import { useVideoPageData } from '@/components/video-page/hooks/use-video-page-data';
import type { Comment, CommentTag, Version } from '@/components/video-page/types';

type Params = Parameters<typeof useVideoPageData>[0];

const VIDEO_ID = 'vid1';
const PROJECT_ID = 'proj1';
const DASHBOARD_URL = `/api/projects/${PROJECT_ID}/videos/${VIDEO_ID}?includeComments=false`;
const WATCH_URL = `/api/watch/${VIDEO_ID}`;
const TAGS_URL = `/api/projects/${PROJECT_ID}/tags?videoId=${VIDEO_ID}`;
/** The page size the hook hardcodes when walking the comment list. */
const COMMENT_PAGE_SIZE = 200;

function commentsUrl(versionId: string, offset: number) {
  return `/api/versions/${versionId}/comments?includeResolved=true&limit=${COMMENT_PAGE_SIZE}&offset=${offset}`;
}

function makeVersion(overrides: Partial<Version> = {}): Version {
  return {
    id: 'ver1',
    versionNumber: 1,
    versionLabel: null,
    providerId: 'bunny',
    videoId: VIDEO_ID,
    originalUrl: 'https://cdn.example.test/a.mp4',
    title: null,
    thumbnailUrl: null,
    duration: 600,
    isActive: true,
    _count: { comments: 0 },
    ...overrides,
  };
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c1',
    content: 'Colour is off',
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
    tag: null,
    replies: [],
    ...overrides,
  };
}

const TAGS: CommentTag[] = [
  { id: 'tag-audio', name: 'Audio', color: '#f00' },
  { id: 'tag-colour', name: 'Colour', color: '#0f0' },
];

interface Responder {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
}

function respond({
  ok = true,
  status = 200,
  payload = {} as unknown,
  text = '',
  etag = null as string | null,
}): Responder {
  return {
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(text),
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null) },
  };
}

/** The three endpoints the hook touches, each reassignable per test. */
let videoResponse: Responder;
let commentPages: Responder[];
let tagsResponse: Responder;
let fetchMock: ReturnType<typeof vi.fn>;

function commentsPayload(comments: Comment[], hasMore = false) {
  return { data: { comments, hasMore } };
}

function callsMatching(predicate: (url: string) => boolean) {
  return fetchMock.mock.calls.filter((call) => predicate(call[0] as string));
}

function headersOf(call: unknown[]): Record<string, string> {
  return ((call[1] as { headers?: Record<string, string> }).headers ?? {}) as Record<
    string,
    string
  >;
}

type Harness = RenderHookResult<ReturnType<typeof useVideoPageData>, Params>;

/** Mount, then let the video load, the comment load and the tag load chain. */
async function renderPage(overrides: Partial<Params> = {}): Promise<Harness> {
  const harness = renderHook((props: Params) => useVideoPageData(props), {
    initialProps: {
      mode: 'dashboard',
      videoId: VIDEO_ID,
      propProjectId: PROJECT_ID,
      ...overrides,
    } as Params,
  });
  await settle();
  return harness;
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function activeComments(harness: Harness, versionId = 'ver1'): Comment[] {
  return harness.result.current.video?.versions.find((v) => v.id === versionId)?.comments ?? [];
}

beforeEach(() => {
  videoResponse = respond({
    payload: {
      data: {
        id: VIDEO_ID,
        title: 'Cut 3',
        description: null,
        projectId: PROJECT_ID,
        project: { name: 'Ad campaign', ownerId: 'user1' },
        isAuthenticated: true,
        currentUserId: 'user1',
        currentUserName: 'Ada',
        versions: [makeVersion(), makeVersion({ id: 'ver2', versionNumber: 2, isActive: false })],
      },
    },
  });
  commentPages = [respond({ payload: commentsPayload([makeComment()]), etag: 'W/"c-1"' })];
  tagsResponse = respond({ payload: { data: TAGS } });

  fetchMock = vi.fn((url: string) => {
    if (url === DASHBOARD_URL || url === WATCH_URL) return Promise.resolve(videoResponse);
    if (url.includes('/comments?')) {
      // Serve the page the offset asks for, so a test can reassign commentPages
      // and replay the same walk.
      const offset = Number(new URLSearchParams(url.split('?')[1]).get('offset') ?? 0);
      const index = Math.min(offset / COMMENT_PAGE_SIZE, commentPages.length - 1);
      return Promise.resolve(commentPages[index]);
    }
    if (url.includes('/tags')) return Promise.resolve(tagsResponse);
    return Promise.resolve(respond({ payload: { data: {} } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useVideoPageData recording share link opens', () => {
  it('posts one open after the watch page loads and does not repeat on comment updates', async () => {
    const harness = await renderPage({ mode: 'watch', propProjectId: undefined });
    expect(callsMatching((url) => url === `/api/watch/${VIDEO_ID}/open`)).toHaveLength(1);
    expect(callsMatching((url) => url === `/api/watch/${VIDEO_ID}/open`)[0][1]).toEqual({
      method: 'POST',
    });
    await act(async () => harness.result.current.fetchVersionComments('ver1', false));
    expect(callsMatching((url) => url === `/api/watch/${VIDEO_ID}/open`)).toHaveLength(1);
  });

  it('does not record dashboard visits or a denied watch page', async () => {
    await renderPage();
    expect(callsMatching((url) => url.endsWith('/open'))).toHaveLength(0);
    videoResponse = respond({ ok: false, status: 403 });
    const harness = await renderPage({ mode: 'watch', propProjectId: undefined });
    expect(harness.result.current.error).toBe('Video not found or access denied');
    expect(callsMatching((url) => url.endsWith('/open'))).toHaveLength(0);
  });

  it('keeps the watch page usable when recording fails', async () => {
    const original = fetchMock.getMockImplementation() as (url: string) => Promise<Responder>;
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/open') ? Promise.reject(new Error('offline')) : original(url)
    );
    const harness = await renderPage({ mode: 'watch', propProjectId: undefined });
    expect(callsMatching((url) => url.endsWith('/open'))).toHaveLength(1);
    expect(harness.result.current.video?.title).toBe('Cut 3');
    expect(harness.result.current.error).toBe('');
    expect(harness.result.current.loading).toBe(false);
  });
});

describe('useVideoPageData loading the video', () => {
  it('reads the project-scoped route without comments in dashboard mode', async () => {
    const harness = await renderPage();

    expect(callsMatching((url) => url === DASHBOARD_URL)[0][1]).toEqual({ cache: 'no-store' });
    expect(harness.result.current.video?.title).toBe('Cut 3');
    expect(harness.result.current.loading).toBe(false);
    expect(harness.result.current.error).toBe('');
  });

  it('reads the public watch route in watch mode', async () => {
    const harness = await renderPage({ mode: 'watch', propProjectId: undefined });

    expect(callsMatching((url) => url === WATCH_URL)).toHaveLength(1);
    expect(callsMatching((url) => url === DASHBOARD_URL)).toHaveLength(0);
    expect(harness.result.current.video?.id).toBe(VIDEO_ID);
  });

  it('gives every version a comments array even when the route omits one', async () => {
    const harness = await renderPage();

    expect(harness.result.current.video?.versions.map((v) => Array.isArray(v.comments))).toEqual([
      true,
      true,
    ]);
  });

  it('opens the version the server flagged active', async () => {
    videoResponse = respond({
      payload: {
        data: {
          id: VIDEO_ID,
          projectId: PROJECT_ID,
          versions: [
            makeVersion({ id: 'ver1', isActive: false }),
            makeVersion({ id: 'ver2', isActive: true }),
          ],
        },
      },
    });
    const harness = await renderPage();

    expect(harness.result.current.activeVersionId).toBe('ver2');
  });

  it('falls back to the first version when none is flagged', async () => {
    videoResponse = respond({
      payload: {
        data: {
          id: VIDEO_ID,
          projectId: PROJECT_ID,
          versions: [
            makeVersion({ id: 'ver1', isActive: false }),
            makeVersion({ id: 'ver2', isActive: false }),
          ],
        },
      },
    });
    const harness = await renderPage();

    expect(harness.result.current.activeVersionId).toBe('ver1');
  });

  it('opens nothing for a video with no versions yet', async () => {
    videoResponse = respond({
      payload: { data: { id: VIDEO_ID, projectId: PROJECT_ID, versions: [] } },
    });
    const harness = await renderPage();

    expect(harness.result.current.activeVersionId).toBeNull();
    expect(callsMatching((url) => url.includes('/comments?'))).toHaveLength(0);
  });

  it('shows the status and body of a dashboard failure, which an editor can act on', async () => {
    videoResponse = respond({ ok: false, status: 403, text: 'Forbidden' });
    const harness = await renderPage();

    expect(harness.result.current.error).toBe('Failed to load video: 403 Forbidden');
    expect(harness.result.current.video).toBeNull();
    expect(harness.result.current.loading).toBe(false);
  });

  // A share-link viewer must not be told whether the video exists.
  it('says nothing specific about a watch failure', async () => {
    videoResponse = respond({ ok: false, status: 403, text: 'Forbidden' });
    const harness = await renderPage({ mode: 'watch', propProjectId: undefined });

    expect(harness.result.current.error).toBe('Video not found or access denied');
  });

  it('reports a network failure and stops loading', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const harness = await renderPage();

    expect(harness.result.current.error).toBe('Failed to load video');
    expect(harness.result.current.loading).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      'Error fetching video:',
      expect.objectContaining({ message: 'offline' })
    );
  });

  it('re-reads the video when the mode switches', async () => {
    const harness = await renderPage();
    expect(callsMatching((url) => url === DASHBOARD_URL)).toHaveLength(1);

    harness.rerender({ mode: 'watch', videoId: VIDEO_ID, propProjectId: PROJECT_ID });
    await settle();

    expect(callsMatching((url) => url === WATCH_URL)).toHaveLength(1);
  });
});

describe('useVideoPageData loading comments', () => {
  it('reads the active version comments, resolved ones included', async () => {
    const harness = await renderPage();

    expect(callsMatching((url) => url === commentsUrl('ver1', 0))).toHaveLength(1);
    expect(activeComments(harness).map((c) => c.id)).toEqual(['c1']);
  });

  it('walks every page until the server says there are no more', async () => {
    commentPages = [
      respond({ payload: commentsPayload([makeComment({ id: 'c1' })], true), etag: 'W/"c-1"' }),
      respond({ payload: commentsPayload([makeComment({ id: 'c2' })], true) }),
      respond({ payload: commentsPayload([makeComment({ id: 'c3' })], false) }),
    ];
    const harness = await renderPage();

    expect(callsMatching((url) => url.includes('/comments?')).map((call) => call[0])).toEqual([
      commentsUrl('ver1', 0),
      commentsUrl('ver1', 200),
      commentsUrl('ver1', 400),
    ]);
    expect(activeComments(harness).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('counts replies towards the badge on the version', async () => {
    commentPages = [
      respond({
        payload: commentsPayload([
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
          makeComment({ id: 'c2' }),
        ]),
      }),
    ];
    const harness = await renderPage();

    const version = harness.result.current.video?.versions.find((v) => v.id === 'ver1');
    expect(version?._count).toEqual({ comments: 3 });
  });

  it('touches only the version it was asked about', async () => {
    const harness = await renderPage();

    commentPages = [respond({ payload: commentsPayload([makeComment({ id: 'c-other' })]) })];
    await act(async () => {
      await harness.result.current.fetchVersionComments('ver2', false);
    });

    expect(activeComments(harness, 'ver1').map((c) => c.id)).toEqual(['c1']);
    expect(activeComments(harness, 'ver2').map((c) => c.id)).toEqual(['c-other']);
  });

  it('sends no conditional header before an etag is known', async () => {
    await renderPage();

    expect(headersOf(callsMatching((url) => url === commentsUrl('ver1', 0))[0])).toEqual({});
  });

  it('sends the stored etag back on the next conditional read', async () => {
    const harness = await renderPage();

    await act(async () => {
      await harness.result.current.fetchVersionComments('ver1', true);
    });

    const reads = callsMatching((url) => url === commentsUrl('ver1', 0));
    expect(headersOf(reads[1])).toEqual({ 'If-None-Match': 'W/"c-1"' });
  });

  it('omits the etag when the caller wants the list unconditionally', async () => {
    const harness = await renderPage();

    await act(async () => {
      await harness.result.current.fetchVersionComments('ver1', false);
    });

    const reads = callsMatching((url) => url === commentsUrl('ver1', 0));
    expect(headersOf(reads[1])).toEqual({});
  });

  it('never sends a conditional header on a follow-up page', async () => {
    commentPages = [
      respond({ payload: commentsPayload([makeComment()], true), etag: 'W/"c-1"' }),
      respond({ payload: commentsPayload([makeComment({ id: 'c2' })], false) }),
    ];
    const harness = await renderPage();

    commentPages = [
      respond({ payload: commentsPayload([makeComment()], true), etag: 'W/"c-2"' }),
      respond({ payload: commentsPayload([makeComment({ id: 'c2' })], false) }),
    ];
    await act(async () => {
      await harness.result.current.fetchVersionComments('ver1', true);
    });

    expect(headersOf(callsMatching((url) => url === commentsUrl('ver1', 200))[1])).toEqual({});
  });

  // A real 304 and a real 403 carry no comment list. These fakes do, so that
  // the assertion proves the status is what stops the write rather than the
  // body happening to be empty.
  it('leaves the comments alone when the server answers 304', async () => {
    const harness = await renderPage();

    commentPages = [
      respond({ ok: false, status: 304, payload: commentsPayload([makeComment({ id: 'c-304' })]) }),
    ];
    await act(async () => {
      await harness.result.current.fetchVersionComments('ver1', true);
    });

    expect(activeComments(harness).map((c) => c.id)).toEqual(['c1']);
  });

  it('leaves the comments alone when the read is refused', async () => {
    const harness = await renderPage();

    commentPages = [
      respond({ ok: false, status: 403, payload: commentsPayload([makeComment({ id: 'c-403' })]) }),
    ];
    await act(async () => {
      await harness.result.current.fetchVersionComments('ver1', false);
    });

    expect(activeComments(harness).map((c) => c.id)).toEqual(['c1']);
  });

  it('leaves the comments alone when the body carries no list', async () => {
    const harness = await renderPage();

    commentPages = [respond({ payload: { data: {} } })];
    await act(async () => {
      await harness.result.current.fetchVersionComments('ver1', false);
    });

    expect(activeComments(harness).map((c) => c.id)).toEqual(['c1']);
  });

  it('re-reads comments when the caller switches version', async () => {
    const harness = await renderPage();

    act(() => harness.result.current.setActiveVersionId('ver2'));
    await settle();

    expect(callsMatching((url) => url === commentsUrl('ver2', 0))).toHaveLength(1);
  });
});

describe('useVideoPageData loading tags', () => {
  it('reads the project tags scoped to this video', async () => {
    await renderPage();

    expect(callsMatching((url) => url === TAGS_URL).length).toBeGreaterThan(0);
  });

  it('preselects the first tag for the composer', async () => {
    const harness = await renderPage();

    expect(harness.result.current.availableTags).toEqual(TAGS);
    expect(harness.result.current.selectedTagId).toBe('tag-audio');
  });

  it('does not override a tag the editor already picked', async () => {
    const harness = await renderPage();

    act(() => harness.result.current.setSelectedTagId('tag-colour'));
    await settle();

    expect(harness.result.current.selectedTagId).toBe('tag-colour');
  });

  // selectedTagId used to be in the effect's dependency list purely so the auto-select
  // could read it, so the moment the first tag was selected the whole effect re-ran and
  // the tag list was fetched a second time on every page load. It is read from a ref now.
  it('reads the tag list once even though the auto-select sets a tag', async () => {
    const harness = await renderPage();

    expect(harness.result.current.selectedTagId).toBe('tag-audio');
    expect(callsMatching((url) => url === TAGS_URL)).toHaveLength(1);
  });

  it('selects nothing when the project has no tags', async () => {
    tagsResponse = respond({ payload: { data: [] } });
    const harness = await renderPage();

    expect(harness.result.current.availableTags).toEqual([]);
    expect(harness.result.current.selectedTagId).toBeNull();
    expect(callsMatching((url) => url === TAGS_URL)).toHaveLength(1);
  });

  it('swallows a refused tag read rather than blocking the page', async () => {
    tagsResponse = respond({ ok: false, status: 403 });
    const harness = await renderPage();

    expect(harness.result.current.availableTags).toEqual([]);
    expect(harness.result.current.error).toBe('');
    expect(harness.result.current.video?.title).toBe('Cut 3');
  });

  it('takes the project from the loaded video in watch mode', async () => {
    const harness = await renderPage({ mode: 'watch', propProjectId: undefined });

    expect(harness.result.current.projectId).toBe(PROJECT_ID);
    expect(callsMatching((url) => url === TAGS_URL).length).toBeGreaterThan(0);
  });

  it('asks for no tags while the video is still unknown', async () => {
    videoResponse = respond({ ok: false, status: 404, text: 'Not found' });
    const harness = await renderPage({ mode: 'watch', propProjectId: undefined });

    expect(harness.result.current.projectId).toBeUndefined();
    expect(callsMatching((url) => url.includes('/tags'))).toHaveLength(0);
  });
});
