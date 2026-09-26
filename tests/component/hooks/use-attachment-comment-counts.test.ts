import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAttachmentCommentCounts } from '@/components/video-page/hooks/use-attachment-comment-counts';

afterEach(() => vi.unstubAllGlobals());

describe('useAttachmentCommentCounts', () => {
  it('keeps counts from the current version when an older response arrives last', async () => {
    const pending = new Map<string, (response: Response) => void>();
    const fetchMock = vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          pending.set(new URL(url, 'http://localhost').searchParams.get('versionId')!, resolve);
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(
      ({ versionId }) => useAttachmentCommentCounts('video-1', versionId),
      { initialProps: { versionId: 'version-1' } }
    );

    await waitFor(() => expect(pending.has('version-1')).toBe(true));
    rerender({ versionId: 'version-2' });
    await waitFor(() => expect(pending.has('version-2')).toBe(true));
    await act(async () => {
      pending.get('version-2')!({
        ok: true,
        json: async () => ({ data: { counts: { 'asset:new': 3 } } }),
      } as Response);
    });
    await waitFor(() => expect(result.current.counts).toEqual({ 'asset:new': 3 }));
    await act(async () => {
      pending.get('version-1')!({
        ok: true,
        json: async () => ({ data: { counts: { 'asset:old': 9 } } }),
      } as Response);
    });
    expect(result.current.counts).toEqual({ 'asset:new': 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
