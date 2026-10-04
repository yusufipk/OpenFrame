import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCanCreateApiToken } from '@/components/video-page/editor-sync-dialog';

afterEach(() => vi.unstubAllGlobals());

function respond(ok: boolean, body: unknown) {
  return vi.fn(async () => ({ ok, json: async () => body }) as Response);
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

  it('stays unknown when the check fails, so an error never reads as a refusal', async () => {
    const failing = respond(false, { error: 'Too many requests' });
    vi.stubGlobal('fetch', failing);
    const { result } = renderHook(() => useCanCreateApiToken(true));
    await waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    const offline = renderHook(() => useCanCreateApiToken(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(offline.result.current).toBeNull();
  });

  it('asks nothing when the plugins are not shown', async () => {
    const fetchMock = respond(true, { data: { canCreate: true } });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCanCreateApiToken(false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});
