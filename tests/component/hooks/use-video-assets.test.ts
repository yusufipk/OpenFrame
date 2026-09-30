import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, type RenderHookResult } from '@testing-library/react';
import { useVideoAssets } from '@/components/video-page/hooks/use-video-assets';
import type { VideoAsset } from '@/components/video-page/types';
import { unloadGuardCount } from '@/lib/client/unload-guard';

const toastError = vi.fn();
const toastSuccess = vi.fn();
const toastWarning = vi.fn();
const toastLoading = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
    loading: (...args: unknown[]) => toastLoading(...args),
  },
}));

/**
 * The options a toast was last called with for `message`. Sonner merges updates to one
 * id, so a finished toast has to send `description` as undefined to clear the file name
 * the progress toast left there; leaving the key out keeps it.
 */
function expectDescriptionCleared(spy: ReturnType<typeof vi.fn>, message: string) {
  const call = spy.mock.calls.find(([sent]) => sent === message);
  expect(call?.[1]).toMatchObject({ id: `download-all-assets-${VIDEO_ID}` });
  expect(Object.keys(call?.[1] ?? {})).toContain('description');
  expect((call?.[1] as { description?: unknown }).description).toBeUndefined();
}

type Params = Parameters<typeof useVideoAssets>[0];

const VIDEO_ID = 'vid1';
/** The page size the hook hardcodes. */
const PAGE_SIZE = 40;
const FIRST_PAGE_URL = `/api/videos/${VIDEO_ID}/assets?limit=${PAGE_SIZE}&offset=0`;
const POLL_INTERVAL_MS = 10000;

function makeAsset(overrides: Partial<VideoAsset> = {}): VideoAsset {
  return {
    id: 'a1',
    videoId: VIDEO_ID,
    kind: 'IMAGE',
    provider: 'R2_IMAGE',
    displayName: 'Reference frame',
    sourceUrl: '/api/upload/image/proj1/ref.png',
    providerVideoId: null,
    thumbnailUrl: null,
    uploadedByUserId: 'user1',
    uploadedByGuestName: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    uploadedByUser: { id: 'user1', name: 'Ada', image: null },
    canDelete: true,
    ...overrides,
  };
}

interface ListInit {
  ok?: boolean;
  status?: number;
  assets?: VideoAsset[];
  hasMore?: boolean;
  nextOffset?: number | null;
  etag?: string | null;
  error?: string;
}

function listResponse({
  ok = true,
  status = 200,
  assets = [],
  hasMore = false,
  nextOffset = null,
  etag = '"assets-1"',
  error,
}: ListInit = {}) {
  return {
    ok,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null) },
    json: () =>
      Promise.resolve(
        ok
          ? { data: { assets, pagination: { limit: PAGE_SIZE, offset: 0, hasMore, nextOffset } } }
          : { error }
      ),
  };
}

function jsonResponse(ok: boolean, payload: unknown, status = ok ? 200 : 400) {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(payload),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let fetchMock: ReturnType<typeof vi.fn>;
let clicked: string[];
/** The `download` attribute of each clicked anchor, in click order. */
let clickedDownloadAttrs: (string | null)[];
/** What the assets list endpoint answers with; reassign to change it mid-test. */
let listed: ReturnType<typeof listResponse>;

function callsTo(url: string, method?: string) {
  return fetchMock.mock.calls.filter(
    (call) => call[0] === url && (call[1]?.method ?? undefined) === method
  );
}

function headersOf(call: unknown[]): Record<string, string> {
  return ((call[1] as { headers?: Record<string, string> }).headers ?? {}) as Record<
    string,
    string
  >;
}

function bodyOf(call: unknown[]): unknown {
  return JSON.parse((call[1] as { body: string }).body);
}

type Harness = RenderHookResult<ReturnType<typeof useVideoAssets>, Params>;

async function renderAssets(overrides: Partial<Params> = {}): Promise<Harness> {
  const harness = renderHook((props: Params) => useVideoAssets(props), {
    initialProps: {
      videoId: VIDEO_ID,
      isAuthenticated: true,
      canUploadAssets: true,
      canDownloadAssets: true,
      ...overrides,
    },
  });
  // The mount-time read has to settle before any assertion.
  await act(async () => {
    await Promise.resolve();
  });
  return harness;
}

function assetIds(harness: Harness): string[] {
  return harness.result.current.assets.map((asset) => asset.id);
}

beforeEach(() => {
  clicked = [];
  clickedDownloadAttrs = [];
  listed = listResponse({ assets: [makeAsset()] });
  fetchMock = vi.fn((url: string) => {
    if (typeof url === 'string' && url.startsWith(`/api/videos/${VIDEO_ID}/assets?`)) {
      return Promise.resolve(listed);
    }
    return Promise.resolve(jsonResponse(true, { data: makeAsset({ id: 'a-server' }) }));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked.push(this.getAttribute('href') ?? '');
    clickedDownloadAttrs.push(this.getAttribute('download'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toastError.mockReset();
  toastSuccess.mockReset();
  toastWarning.mockReset();
  toastLoading.mockReset();
});

describe('useVideoAssets reading the list', () => {
  it('reads the first page on mount, bypassing the cache', async () => {
    const harness = await renderAssets();

    const call = callsTo(FIRST_PAGE_URL)[0];
    expect(call[1]).toMatchObject({ cache: 'no-store' });
    expect(assetIds(harness)).toEqual(['a1']);
    expect(harness.result.current.isLoadingAssets).toBe(false);
  });

  it('sends no conditional header before an etag is known', async () => {
    await renderAssets();

    expect(headersOf(callsTo(FIRST_PAGE_URL)[0])).toEqual({});
  });

  it('sends the stored etag back on the next conditional read', async () => {
    const harness = await renderAssets();

    await act(async () => {
      await harness.result.current.fetchAssets({ useEtag: true });
    });

    expect(headersOf(callsTo(FIRST_PAGE_URL)[1])).toEqual({ 'If-None-Match': '"assets-1"' });
  });

  it('omits the etag when the caller wants a fresh read', async () => {
    const harness = await renderAssets();

    await act(async () => {
      await harness.result.current.fetchAssets();
    });

    expect(headersOf(callsTo(FIRST_PAGE_URL)[1])).toEqual({});
  });

  it('leaves the list on screen alone when the server answers 304', async () => {
    const harness = await renderAssets();
    listed = listResponse({ ok: false, status: 304, assets: [] });

    await act(async () => {
      await harness.result.current.fetchAssets({ useEtag: true });
    });

    expect(assetIds(harness)).toEqual(['a1']);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('records how many more assets there are', async () => {
    listed = listResponse({ assets: [makeAsset()], hasMore: true, nextOffset: 40 });
    const harness = await renderAssets();

    expect(harness.result.current.hasMoreAssets).toBe(true);
  });

  it('shows the message the server sent when the read is refused', async () => {
    listed = listResponse({ ok: false, status: 403, error: 'Access denied' });
    const harness = await renderAssets();

    expect(toastError).toHaveBeenCalledWith('Access denied');
    expect(assetIds(harness)).toEqual([]);
    expect(harness.result.current.isLoadingAssets).toBe(false);
  });

  it('falls back to a generic message when a 500 says nothing', async () => {
    listed = listResponse({ ok: false, status: 500 });
    await renderAssets();

    expect(toastError).toHaveBeenCalledWith('Failed to fetch assets');
  });

  it('keeps the list when a later read fails', async () => {
    const harness = await renderAssets();
    listed = listResponse({ ok: false, status: 500 });

    await act(async () => {
      await harness.result.current.fetchAssets();
    });

    expect(assetIds(harness)).toEqual(['a1']);
  });

  it('says nothing at all on a silent read that fails', async () => {
    const harness = await renderAssets();
    listed = listResponse({ ok: false, status: 500, error: 'Access denied' });

    await act(async () => {
      await harness.result.current.fetchAssets({ silent: true });
    });

    expect(toastError).not.toHaveBeenCalled();
  });

  it('leaves the visible spinner alone during a silent read', async () => {
    const pending = deferred<unknown>();
    const harness = await renderAssets();
    fetchMock.mockReturnValue(pending.promise);

    let read: Promise<void> | undefined;
    act(() => {
      read = harness.result.current.fetchAssets({ silent: true });
    });
    expect(harness.result.current.isLoadingAssets).toBe(false);

    await act(async () => {
      pending.resolve(listed);
      await read;
    });
  });

  it('reports a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const harness = await renderAssets();

    expect(toastError).toHaveBeenCalledWith('Failed to fetch assets');
    expect(harness.result.current.isLoadingAssets).toBe(false);
  });
});

describe('useVideoAssets loading more', () => {
  it('does nothing when the first page was the whole list', async () => {
    const harness = await renderAssets();

    await act(async () => {
      await harness.result.current.loadMoreAssets();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks for the offset the server named and appends the page', async () => {
    listed = listResponse({ assets: [makeAsset()], hasMore: true, nextOffset: 40 });
    const harness = await renderAssets();
    listed = listResponse({ assets: [makeAsset({ id: 'a2' })], hasMore: false });

    await act(async () => {
      await harness.result.current.loadMoreAssets();
    });

    expect(callsTo(`/api/videos/${VIDEO_ID}/assets?limit=${PAGE_SIZE}&offset=40`)).toHaveLength(1);
    expect(assetIds(harness)).toEqual(['a1', 'a2']);
    expect(harness.result.current.hasMoreAssets).toBe(false);
    expect(harness.result.current.isLoadingMoreAssets).toBe(false);
  });

  // The background poll can deliver a row the next page also contains.
  it('drops a row the visible page already holds', async () => {
    listed = listResponse({ assets: [makeAsset()], hasMore: true, nextOffset: 40 });
    const harness = await renderAssets();
    listed = listResponse({ assets: [makeAsset(), makeAsset({ id: 'a2' })] });

    await act(async () => {
      await harness.result.current.loadMoreAssets();
    });

    expect(assetIds(harness)).toEqual(['a1', 'a2']);
  });

  it('shows the message the server sent when the next page fails', async () => {
    listed = listResponse({ assets: [makeAsset()], hasMore: true, nextOffset: 40 });
    const harness = await renderAssets();
    listed = listResponse({ ok: false, status: 500, error: 'Too many assets' });

    await act(async () => {
      await harness.result.current.loadMoreAssets();
    });

    expect(toastError).toHaveBeenCalledWith('Too many assets');
    expect(assetIds(harness)).toEqual(['a1']);
    expect(harness.result.current.isLoadingMoreAssets).toBe(false);
  });

  it('reports a network failure while paging', async () => {
    listed = listResponse({ assets: [makeAsset()], hasMore: true, nextOffset: 40 });
    const harness = await renderAssets();
    fetchMock.mockRejectedValue(new Error('offline'));

    await act(async () => {
      await harness.result.current.loadMoreAssets();
    });

    expect(toastError).toHaveBeenCalledWith('Failed to load more assets');
    expect(harness.result.current.isLoadingMoreAssets).toBe(false);
  });
});

describe('useVideoAssets background polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function renderWithTimers(overrides: Partial<Params> = {}) {
    const harness = renderHook((props: Params) => useVideoAssets(props), {
      initialProps: {
        videoId: VIDEO_ID,
        isAuthenticated: true,
        canUploadAssets: true,
        canDownloadAssets: true,
        ...overrides,
      },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    return harness;
  }

  it('re-reads the list silently every 10 seconds', async () => {
    await renderWithTimers();
    expect(callsTo(FIRST_PAGE_URL)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    });
    expect(callsTo(FIRST_PAGE_URL)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(callsTo(FIRST_PAGE_URL)).toHaveLength(2);
    expect(headersOf(callsTo(FIRST_PAGE_URL)[1])).toEqual({ 'If-None-Match': '"assets-1"' });
  });

  it('skips the poll while the tab is hidden', async () => {
    await renderWithTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    });
    expect(callsTo(FIRST_PAGE_URL)).toHaveLength(1);

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(callsTo(FIRST_PAGE_URL)).toHaveLength(2);
  });

  it('skips the poll while a write is still in flight', async () => {
    const harness = await renderWithTimers();
    const pending = deferred<unknown>();
    fetchMock.mockImplementation((url: string) =>
      url.startsWith(`/api/videos/${VIDEO_ID}/assets?`) ? Promise.resolve(listed) : pending.promise
    );

    let created: Promise<unknown> | undefined;
    act(() => {
      created = harness.result.current.createAsset({
        provider: 'R2_IMAGE',
        sourceUrl: '/api/upload/image/proj1/new.png',
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    });
    expect(callsTo(FIRST_PAGE_URL)).toHaveLength(1);

    await act(async () => {
      pending.resolve(jsonResponse(true, { data: makeAsset({ id: 'a-server' }) }));
      await created;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(callsTo(FIRST_PAGE_URL)).toHaveLength(2);
  });

  it('stops polling after unmount', async () => {
    const harness = await renderWithTimers();
    harness.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    });
    expect(callsTo(FIRST_PAGE_URL)).toHaveLength(1);
  });
});

describe('useVideoAssets creating', () => {
  const payload = {
    provider: 'R2_IMAGE' as const,
    displayName: 'New reference',
    sourceUrl: '/api/upload/image/proj1/new.png',
  };

  it('refuses a viewer who cannot upload, without reaching the network', async () => {
    const harness = await renderAssets({ canUploadAssets: false });
    fetchMock.mockClear();

    let created: VideoAsset | null | undefined;
    await act(async () => {
      created = await harness.result.current.createAsset(payload);
    });

    expect(created).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('You do not have permission to upload assets');
  });

  it('posts the payload to the assets route and prepends the saved row', async () => {
    const harness = await renderAssets();

    let created: VideoAsset | null | undefined;
    await act(async () => {
      created = await harness.result.current.createAsset(payload);
    });

    const post = callsTo(`/api/videos/${VIDEO_ID}/assets`, 'POST')[0];
    expect(bodyOf(post)).toEqual(payload);
    expect(created?.id).toBe('a-server');
    expect(assetIds(harness)).toEqual(['a-server', 'a1']);
    expect(harness.result.current.isCreatingAsset).toBe(false);
  });

  it('signs a guest upload with the trimmed guest name', async () => {
    const harness = await renderAssets({ isAuthenticated: false, guestName: '  Kerem  ' });

    await act(async () => {
      await harness.result.current.createAsset(payload);
    });

    expect(bodyOf(callsTo(`/api/videos/${VIDEO_ID}/assets`, 'POST')[0])).toEqual({
      ...payload,
      guestName: 'Kerem',
    });
  });

  it('falls back to "Guest" when the viewer never gave a name', async () => {
    const harness = await renderAssets({ isAuthenticated: false, guestName: '   ' });

    await act(async () => {
      await harness.result.current.createAsset(payload);
    });

    expect(bodyOf(callsTo(`/api/videos/${VIDEO_ID}/assets`, 'POST')[0])).toMatchObject({
      guestName: 'Guest',
    });
  });

  it('sends no guest name for a signed-in uploader', async () => {
    const harness = await renderAssets({ isAuthenticated: true, guestName: 'Kerem' });

    await act(async () => {
      await harness.result.current.createAsset(payload);
    });

    expect(bodyOf(callsTo(`/api/videos/${VIDEO_ID}/assets`, 'POST')[0])).toEqual(payload);
  });

  it('leaves the list untouched when the server refuses the upload', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith(`/api/videos/${VIDEO_ID}/assets?`)
        ? Promise.resolve(listed)
        : Promise.resolve(jsonResponse(false, { error: 'Asset limit reached' }, 403))
    );
    const harness = await renderAssets();

    let created: VideoAsset | null | undefined;
    await act(async () => {
      created = await harness.result.current.createAsset(payload);
    });

    expect(created).toBeNull();
    expect(assetIds(harness)).toEqual(['a1']);
    expect(toastError).toHaveBeenCalledWith('Asset limit reached');
    expect(harness.result.current.isCreatingAsset).toBe(false);
  });

  // A 2xx with an empty body would otherwise push `undefined` into the list.
  it('treats a success with no row in it as a failure', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith(`/api/videos/${VIDEO_ID}/assets?`)
        ? Promise.resolve(listed)
        : Promise.resolve(jsonResponse(true, {}))
    );
    const harness = await renderAssets();

    let created: VideoAsset | null | undefined;
    await act(async () => {
      created = await harness.result.current.createAsset(payload);
    });

    expect(created).toBeNull();
    expect(assetIds(harness)).toEqual(['a1']);
    expect(toastError).toHaveBeenCalledWith('Failed to create asset');
  });

  it('reports a network failure without hanging the busy flag', async () => {
    const harness = await renderAssets();
    fetchMock.mockRejectedValue(new Error('offline'));

    let created: VideoAsset | null | undefined;
    await act(async () => {
      created = await harness.result.current.createAsset(payload);
    });

    expect(created).toBeNull();
    expect(toastError).toHaveBeenCalledWith('Failed to create asset');
    expect(harness.result.current.isCreatingAsset).toBe(false);
  });
});

describe('useVideoAssets deleting', () => {
  it('deletes through the asset route and drops the row', async () => {
    listed = listResponse({ assets: [makeAsset(), makeAsset({ id: 'a2' })] });
    const harness = await renderAssets();

    let deleted: boolean | undefined;
    await act(async () => {
      deleted = await harness.result.current.deleteAsset('a1');
    });

    expect(callsTo(`/api/videos/${VIDEO_ID}/assets/a1`, 'DELETE')).toHaveLength(1);
    expect(deleted).toBe(true);
    expect(assetIds(harness)).toEqual(['a2']);
    expect(harness.result.current.deletingAssetIds).toEqual([]);
  });

  it('marks which row is being deleted while the request runs', async () => {
    const harness = await renderAssets();
    const pending = deferred<unknown>();
    fetchMock.mockReturnValue(pending.promise);

    let removal: Promise<boolean> | undefined;
    act(() => {
      removal = harness.result.current.deleteAsset('a1');
    });
    expect(harness.result.current.deletingAssetIds).toEqual(['a1']);

    await act(async () => {
      pending.resolve(jsonResponse(true, {}));
      await removal;
    });
    expect(harness.result.current.deletingAssetIds).toEqual([]);
  });

  it('keeps the row when the server refuses the delete', async () => {
    const harness = await renderAssets();
    fetchMock.mockResolvedValue(
      jsonResponse(false, { error: 'Only the uploader can delete' }, 403)
    );

    let deleted: boolean | undefined;
    await act(async () => {
      deleted = await harness.result.current.deleteAsset('a1');
    });

    expect(deleted).toBe(false);
    expect(assetIds(harness)).toEqual(['a1']);
    expect(toastError).toHaveBeenCalledWith('Only the uploader can delete');
    expect(harness.result.current.deletingAssetIds).toEqual([]);
  });

  it('keeps the row when the delete throws', async () => {
    const harness = await renderAssets();
    fetchMock.mockRejectedValue(new Error('offline'));

    let deleted: boolean | undefined;
    await act(async () => {
      deleted = await harness.result.current.deleteAsset('a1');
    });

    expect(deleted).toBe(false);
    expect(assetIds(harness)).toEqual(['a1']);
    expect(toastError).toHaveBeenCalledWith('Failed to delete asset');
  });

  it('removes both rows when two deletes are fired back to back', async () => {
    listed = listResponse({ assets: [makeAsset(), makeAsset({ id: 'a2' })] });
    const harness = await renderAssets();

    await act(async () => {
      await Promise.all([
        harness.result.current.deleteAsset('a1'),
        harness.result.current.deleteAsset('a2'),
      ]);
    });

    expect(assetIds(harness)).toEqual([]);
    expect(harness.result.current.deletingAssetIds).toEqual([]);
  });

  // A single slot meant the second delete cleared the first one's spinner, so the first
  // row stopped indicating progress while its request was still in flight.
  it('marks both rows while two deletes overlap', async () => {
    listed = listResponse({ assets: [makeAsset(), makeAsset({ id: 'a2' })] });
    const harness = await renderAssets();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    let removals: Promise<boolean[]> | undefined;
    act(() => {
      removals = Promise.all([
        harness.result.current.deleteAsset('a1'),
        harness.result.current.deleteAsset('a2'),
      ]);
    });

    expect(harness.result.current.deletingAssetIds).toEqual(['a1', 'a2']);

    await act(async () => {
      first.resolve(jsonResponse(true, {}));
      second.resolve(jsonResponse(true, {}));
      await removals;
    });

    expect(harness.result.current.deletingAssetIds).toEqual([]);
  });
});

describe('useVideoAssets downloading', () => {
  const downloadUrl = `/api/videos/${VIDEO_ID}/assets/a1/download`;

  it('refuses a guest who cannot download', async () => {
    const harness = await renderAssets({ canDownloadAssets: false });

    await act(async () => {
      await harness.result.current.downloadAsset(makeAsset());
    });

    expect(clicked).toEqual([]);
    expect(toastError).toHaveBeenCalledWith('Asset downloads require an authenticated account');
  });

  it('refuses a YouTube asset, which has no file behind it', async () => {
    const harness = await renderAssets();

    await act(async () => {
      await harness.result.current.downloadAsset(makeAsset({ provider: 'YOUTUBE' }));
    });

    expect(clicked).toEqual([]);
    expect(toastError).toHaveBeenCalledWith('YouTube assets cannot be downloaded');
  });

  it('navigates straight to the download route for an R2 asset', async () => {
    const harness = await renderAssets();
    fetchMock.mockClear();

    await act(async () => {
      await harness.result.current.downloadAsset(makeAsset());
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(clicked).toEqual([downloadUrl]);
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('asks Bunny to prepare the file before navigating', async () => {
    const harness = await renderAssets();

    await act(async () => {
      await harness.result.current.downloadAsset(makeAsset({ provider: 'BUNNY' }), 'original');
    });

    expect(callsTo(`${downloadUrl}?source=original&prepare=1`)[0][1]).toEqual({
      cache: 'no-store',
    });
    expect(clicked).toEqual([`${downloadUrl}?source=original`]);
  });

  it('defaults a Bunny asset to the compressed file', async () => {
    const harness = await renderAssets();

    await act(async () => {
      await harness.result.current.downloadAsset(makeAsset({ provider: 'BUNNY' }));
    });

    expect(clicked).toEqual([`${downloadUrl}?source=compressed`]);
  });

  it('shows the message Bunny sent and navigates nowhere when preparing fails', async () => {
    const harness = await renderAssets();
    fetchMock.mockResolvedValue(jsonResponse(false, { error: 'Still encoding' }, 409));

    await act(async () => {
      await harness.result.current.downloadAsset(makeAsset({ provider: 'BUNNY' }));
    });

    expect(clicked).toEqual([]);
    expect(toastError).toHaveBeenCalledWith('Still encoding');
    expect(harness.result.current.activeDownloadAssetId).toBeNull();
  });

  it('reports a network failure while preparing', async () => {
    const harness = await renderAssets();
    fetchMock.mockRejectedValue(new Error('offline'));

    await act(async () => {
      await harness.result.current.downloadAsset(makeAsset({ provider: 'BUNNY' }));
    });

    expect(toastError).toHaveBeenCalledWith('Failed to start download');
    expect(harness.result.current.activeDownloadAssetId).toBeNull();
  });
});

describe('useVideoAssets downloading every asset', () => {
  const pageUrl = (offset: number) => `/api/videos/${VIDEO_ID}/assets?limit=100&offset=${offset}`;
  const downloadUrlOf = (id: string) => `/api/videos/${VIDEO_ID}/assets/${id}/download`;

  beforeEach(() => {
    // The run waits between files and for the rate-limit window; real time would make
    // the pacing tests take minutes.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Answers the bulk read by URL, and every other call with the given response. */
  function routeFetch(
    pages: Record<string, ReturnType<typeof listResponse>>,
    other: (url: string) => unknown = () => jsonResponse(true, { data: {} })
  ) {
    fetchMock.mockImplementation((url: string) => {
      if (url in pages) return Promise.resolve(pages[url]);
      if (url.startsWith(`/api/videos/${VIDEO_ID}/assets?`)) return Promise.resolve(listed);
      return Promise.resolve(other(url));
    });
  }

  /** Starts a run and lets fake time pass until it settles. */
  async function runDownloadAll(harness: Harness, advanceMs = 5 * 60 * 1000) {
    await act(async () => {
      const run = harness.result.current.downloadAllAssets();
      await vi.advanceTimersByTimeAsync(advanceMs);
      await run;
    });
  }

  function images(count: number) {
    return Array.from({ length: count }, (_, i) => makeAsset({ id: `img${i + 1}` }));
  }

  it('refuses a viewer who cannot download, without reading the list', async () => {
    const harness = await renderAssets({ canDownloadAssets: false });
    fetchMock.mockClear();

    // No time passes, so the background poll cannot account for a fetch.
    await runDownloadAll(harness, 0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(clicked).toEqual([]);
    expect(toastError).toHaveBeenCalledWith('Asset downloads require an authenticated account');
  });

  it('reads past the pages on screen and downloads every file, skipping YouTube', async () => {
    const harness = await renderAssets();
    routeFetch({
      [pageUrl(0)]: listResponse({
        assets: [makeAsset({ id: 'img1' }), makeAsset({ id: 'yt1', provider: 'YOUTUBE' })],
        hasMore: true,
        nextOffset: 100,
      }),
      [pageUrl(100)]: listResponse({
        assets: [makeAsset({ id: 'aud1', provider: 'R2_AUDIO', kind: 'AUDIO' })],
      }),
    });

    await runDownloadAll(harness);

    expect(callsTo(pageUrl(100))).toHaveLength(1);
    expect(clicked).toEqual([downloadUrlOf('img1'), downloadUrlOf('aud1')]);
    // An empty download attribute keeps the tab in place if a route answers with an error.
    expect(clickedDownloadAttrs).toEqual(['', '']);
    expectDescriptionCleared(toastSuccess, 'Started 2 downloads');
    expect(harness.result.current.isDownloadingAll).toBe(false);
  });

  it('downloads a row once when two pages both return it', async () => {
    const harness = await renderAssets();
    routeFetch({
      [pageUrl(0)]: listResponse({
        assets: [makeAsset({ id: 'img1' })],
        hasMore: true,
        nextOffset: 100,
      }),
      [pageUrl(100)]: listResponse({
        assets: [makeAsset({ id: 'img1' }), makeAsset({ id: 'img2' })],
      }),
    });

    await runDownloadAll(harness);

    expect(clicked).toEqual([downloadUrlOf('img1'), downloadUrlOf('img2')]);
  });

  it('stops paging when the server names the offset it just served', async () => {
    const harness = await renderAssets();
    routeFetch({
      [pageUrl(0)]: listResponse({
        assets: [makeAsset({ id: 'img1' })],
        hasMore: true,
        nextOffset: 0,
      }),
    });

    await runDownloadAll(harness);

    expect(callsTo(pageUrl(0))).toHaveLength(1);
    expect(clicked).toEqual([downloadUrlOf('img1')]);
  });

  it('stops paging when the server points back to an earlier page', async () => {
    const harness = await renderAssets();
    routeFetch({
      [pageUrl(0)]: listResponse({
        assets: [makeAsset({ id: 'img1' })],
        hasMore: true,
        nextOffset: 100,
      }),
      [pageUrl(100)]: listResponse({
        assets: [makeAsset({ id: 'img2' })],
        hasMore: true,
        nextOffset: 0,
      }),
    });

    await runDownloadAll(harness);

    expect(callsTo(pageUrl(0))).toHaveLength(1);
    expect(callsTo(pageUrl(100))).toHaveLength(1);
    expect(clicked).toEqual([downloadUrlOf('img1'), downloadUrlOf('img2')]);
  });

  it('leaves a gap between two downloads so the browser keeps both', async () => {
    const harness = await renderAssets();
    routeFetch({ [pageUrl(0)]: listResponse({ assets: images(2) }) });

    await act(async () => {
      const run = harness.result.current.downloadAllAssets();
      await vi.advanceTimersByTimeAsync(499);
      expect(clicked).toEqual([downloadUrlOf('img1')]);
      await vi.advanceTimersByTimeAsync(1);
      expect(clicked).toEqual([downloadUrlOf('img1'), downloadUrlOf('img2')]);
      await run;
    });
  });

  it('holds the eleventh download until the rate-limit window has passed', async () => {
    const harness = await renderAssets();
    routeFetch({ [pageUrl(0)]: listResponse({ assets: images(11) }) });

    await act(async () => {
      const run = harness.result.current.downloadAllAssets();
      // Ten downloads 500 ms apart go out by 4.5 s. The eleventh finishes its own gap at
      // 5 s and then waits until 61 s after the first one: the server's 60 s window plus
      // one second of margin.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(clicked).toHaveLength(10);
      expect(toastLoading).toHaveBeenLastCalledWith('Downloading asset 11/11', {
        id: `download-all-assets-${VIDEO_ID}`,
        description: 'Waiting 56s for the download limit',
      });
      await vi.advanceTimersByTimeAsync(55_999);
      expect(clicked).toHaveLength(10);
      await vi.advanceTimersByTimeAsync(1);
      expect(clicked).toHaveLength(11);
      // Once the wait is over the toast names the file again.
      expect(toastLoading).toHaveBeenLastCalledWith('Downloading asset 11/11', {
        id: `download-all-assets-${VIDEO_ID}`,
        description: 'Reference frame',
      });
      await run;
    });
  });

  it('counts a Bunny prepare call against the same limit', async () => {
    const harness = await renderAssets();
    const bunnies = Array.from({ length: 6 }, (_, i) =>
      makeAsset({ id: `bn${i + 1}`, provider: 'BUNNY' })
    );
    routeFetch({ [pageUrl(0)]: listResponse({ assets: bunnies }) });

    await act(async () => {
      const run = harness.result.current.downloadAllAssets();
      // Five prepares and five downloads fill the budget by 2 s; the sixth prepare has to
      // wait until 61 s after the first request, and its download follows 500 ms later.
      await vi.advanceTimersByTimeAsync(60_999);
      expect(callsTo(`${downloadUrlOf('bn6')}?prepare=1`)).toHaveLength(0);
      expect(clicked).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(callsTo(`${downloadUrlOf('bn6')}?prepare=1`)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(499);
      expect(clicked).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(clicked).toHaveLength(6);
      await run;
    });
  });

  it('prepares a Bunny video and downloads it from the default source', async () => {
    const harness = await renderAssets();
    routeFetch({
      [pageUrl(0)]: listResponse({ assets: [makeAsset({ id: 'bn1', provider: 'BUNNY' })] }),
    });

    await runDownloadAll(harness);

    expect(callsTo(`${downloadUrlOf('bn1')}?prepare=1`)).toHaveLength(1);
    expect(clicked).toEqual([downloadUrlOf('bn1')]);
  });

  it('skips a Bunny video that cannot be prepared and says how many were left out', async () => {
    const harness = await renderAssets();
    routeFetch(
      {
        [pageUrl(0)]: listResponse({
          assets: [makeAsset({ id: 'bn1', provider: 'BUNNY' }), makeAsset({ id: 'img1' })],
        }),
      },
      (url) =>
        url === `${downloadUrlOf('bn1')}?prepare=1`
          ? jsonResponse(false, { error: 'Download file not found' }, 404)
          : jsonResponse(true, { data: {} })
    );

    await runDownloadAll(harness);

    expect(clicked).toEqual([downloadUrlOf('img1')]);
    expectDescriptionCleared(toastWarning, 'Started 1 of 2 downloads. 1 could not be prepared.');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('skips a Bunny video whose prepare call fails on the network and keeps going', async () => {
    const harness = await renderAssets();
    fetchMock.mockImplementation((url: string) => {
      if (url === pageUrl(0)) {
        return Promise.resolve(
          listResponse({
            assets: [makeAsset({ id: 'bn1', provider: 'BUNNY' }), makeAsset({ id: 'img1' })],
          })
        );
      }
      if (url === `${downloadUrlOf('bn1')}?prepare=1`) return Promise.reject(new Error('offline'));
      return Promise.resolve(listed);
    });

    await runDownloadAll(harness);

    expect(clicked).toEqual([downloadUrlOf('img1')]);
    expectDescriptionCleared(toastWarning, 'Started 1 of 2 downloads. 1 could not be prepared.');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('reports an error, with no stale file name under it, when nothing could be prepared', async () => {
    const harness = await renderAssets();
    routeFetch(
      { [pageUrl(0)]: listResponse({ assets: [makeAsset({ id: 'bn1', provider: 'BUNNY' })] }) },
      () => jsonResponse(false, { error: 'Download file not found' }, 404)
    );

    await runDownloadAll(harness);

    expect(clicked).toEqual([]);
    expectDescriptionCleared(toastError, 'None of the assets could be prepared for download');
  });

  it('downloads nothing when the list read is refused', async () => {
    const harness = await renderAssets();
    routeFetch({
      [pageUrl(0)]: listResponse({ ok: false, status: 403, error: 'Access denied' }),
    });

    await runDownloadAll(harness);

    expect(clicked).toEqual([]);
    expect(toastError).toHaveBeenCalledWith('Access denied');
    expect(harness.result.current.isDownloadingAll).toBe(false);
  });

  it('recovers from a network failure and can be run again', async () => {
    const harness = await renderAssets();
    fetchMock.mockImplementation((url: string) =>
      url === pageUrl(0) ? Promise.reject(new Error('offline')) : Promise.resolve(listed)
    );

    await runDownloadAll(harness);

    expectDescriptionCleared(toastError, 'Failed to download assets');
    expect(harness.result.current.isDownloadingAll).toBe(false);

    routeFetch({ [pageUrl(0)]: listResponse({ assets: [makeAsset({ id: 'img1' })] }) });
    await runDownloadAll(harness);
    expect(clicked).toEqual([downloadUrlOf('img1')]);
  });

  it('says so when the only assets are YouTube links', async () => {
    const harness = await renderAssets();
    routeFetch({
      [pageUrl(0)]: listResponse({ assets: [makeAsset({ id: 'yt1', provider: 'YOUTUBE' })] }),
    });

    await runDownloadAll(harness);

    expect(clicked).toEqual([]);
    expect(toastError).toHaveBeenCalledWith('No downloadable assets on this video');
  });

  it('marks the run busy and guards the tab while files are queued, then releases both', async () => {
    const harness = await renderAssets();
    routeFetch({ [pageUrl(0)]: listResponse({ assets: images(2) }) });
    expect(unloadGuardCount()).toBe(0);

    let run!: Promise<void>;
    await act(async () => {
      run = harness.result.current.downloadAllAssets();
      await vi.advanceTimersByTimeAsync(100);
    });
    // The button reads this flag to disable itself and show the spinner.
    expect(harness.result.current.isDownloadingAll).toBe(true);
    expect(unloadGuardCount()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await run;
    });

    expect(harness.result.current.isDownloadingAll).toBe(false);
    expect(unloadGuardCount()).toBe(0);
  });

  it('ignores a second click while the first run is still going', async () => {
    const harness = await renderAssets();
    const firstPage = deferred<ReturnType<typeof listResponse>>();
    fetchMock.mockImplementation((url: string) =>
      url === pageUrl(0) ? firstPage.promise : Promise.resolve(listed)
    );

    await act(async () => {
      const first = harness.result.current.downloadAllAssets();
      const second = harness.result.current.downloadAllAssets();
      firstPage.resolve(listResponse({ assets: [makeAsset({ id: 'img1' })] }));
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.all([first, second]);
    });

    expect(callsTo(pageUrl(0))).toHaveLength(1);
    expect(clicked).toEqual([downloadUrlOf('img1')]);
  });
});

describe('useVideoAssets guest upload tokens', () => {
  it('needs no token for a signed-in uploader', async () => {
    const harness = await renderAssets({ isAuthenticated: true });
    fetchMock.mockClear();

    let token: string | null | undefined;
    await act(async () => {
      token = await harness.result.current.getGuestUploadToken('image');
    });

    expect(token).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks the watch route for a token scoped to the intent', async () => {
    const harness = await renderAssets({ isAuthenticated: false });
    fetchMock.mockResolvedValue(jsonResponse(true, { data: { token: 'guest-token' } }));

    let token: string | null | undefined;
    await act(async () => {
      token = await harness.result.current.getGuestUploadToken('audio');
    });

    const post = callsTo(`/api/watch/${VIDEO_ID}/upload-token`, 'POST')[0];
    expect(bodyOf(post)).toEqual({ intent: 'audio' });
    expect(token).toBe('guest-token');
  });

  it('throws the message the server sent when the grant is refused', async () => {
    const harness = await renderAssets({ isAuthenticated: false });
    fetchMock.mockResolvedValue(jsonResponse(false, { error: 'Guest uploads are disabled' }, 403));

    await expect(harness.result.current.getGuestUploadToken('image')).rejects.toThrow(
      'Guest uploads are disabled'
    );
  });

  it('throws when a 200 comes back with no token in it', async () => {
    const harness = await renderAssets({ isAuthenticated: false });
    fetchMock.mockResolvedValue(jsonResponse(true, { data: {} }));

    await expect(harness.result.current.getGuestUploadToken('image')).rejects.toThrow(
      'Failed to prepare upload'
    );
  });
});
