import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  editorPluginTarget,
  useCanCreateApiToken,
} from '@/components/video-page/editor-sync-dialog';

afterEach(() => vi.unstubAllGlobals());

function respond(ok: boolean, body: unknown) {
  return vi.fn(async () => ({ ok, json: async () => body }) as Response);
}

// Lets the fetch, its json() and any state update it schedules all finish.
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('useCanCreateApiToken', () => {
  it('reports the answer the token settings give', async () => {
    vi.stubGlobal('fetch', respond(true, { data: { tokens: [], canCreate: true } }));
    const allowed = renderHook(() => useCanCreateApiToken(true));
    await waitFor(() => expect(allowed.result.current).toBe(true));

    vi.stubGlobal('fetch', respond(true, { data: { tokens: [], canCreate: false } }));
    const refused = renderHook(() => useCanCreateApiToken(true));
    await waitFor(() => expect(refused.result.current).toBe(false));
  });

  it('stays unknown when the check is refused, so an error never reads as a no', async () => {
    const failing = respond(false, { error: 'Too many requests' });
    vi.stubGlobal('fetch', failing);
    const { result } = renderHook(() => useCanCreateApiToken(true));
    await settle();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();
  });

  it('stays unknown when the request itself fails', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', offline);
    const { result } = renderHook(() => useCanCreateApiToken(true));
    await settle();
    expect(offline).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();
  });

  it('asks nothing when the plugins are not shown', async () => {
    const fetchMock = respond(true, { data: { canCreate: true } });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCanCreateApiToken(false));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});

describe('editorPluginTarget', () => {
  it('addresses the video on its project page with that page’s download right', () => {
    expect(editorPluginTarget('dashboard', 'p1', 'v1', true)).toEqual({
      projectId: 'p1',
      videoId: 'v1',
      canDownload: true,
    });
    expect(editorPluginTarget('dashboard', 'p1', 'v1', false)).toEqual({
      projectId: 'p1',
      videoId: 'v1',
      canDownload: false,
    });
  });

  it('offers nothing on a watch page, whose download right may come from a share link', () => {
    expect(editorPluginTarget('watch', 'p1', 'v1', true)).toBeUndefined();
  });

  it('offers nothing before the project is known', () => {
    expect(editorPluginTarget('dashboard', undefined, 'v1', true)).toBeUndefined();
  });
});
