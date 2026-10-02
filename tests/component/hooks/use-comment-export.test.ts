import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCommentExport } from '@/components/video-page/hooks/use-comment-export';

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

interface FakeResponseInit {
  ok?: boolean;
  disposition?: string | null;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok = true, disposition = null, json }: FakeResponseInit = {}) {
  return {
    ok,
    headers: { get: (name: string) => (name === 'content-disposition' ? disposition : null) },
    blob: () => Promise.resolve(new Blob(['id,content\n'], { type: 'text/csv' })),
    json: json ?? (() => Promise.reject(new SyntaxError('not json'))),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let clicked: { download: string; href: string }[];
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clicked = [];
  fetchMock = vi.fn().mockResolvedValue(fakeResponse());
  vi.stubGlobal('fetch', fetchMock);
  // The hook logs every failure. Silence it here so the suite output stays
  // readable; one test below asserts the log still happens.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  // jsdom would try to navigate on a real anchor click. Record the anchor the
  // hook built instead, which is also the only way to observe the filename.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked.push({ download: this.download, href: this.getAttribute('href') ?? '' });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('useCommentExport', () => {
  it('requests the chosen format and the current resolved filter', async () => {
    const { result } = renderHook(() =>
      useCommentExport({ activeVersionId: 'ver1', showResolved: true })
    );

    await act(async () => {
      await result.current.exportComments('csv');
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/versions/ver1/comments/export?format=csv&includeResolved=true'
    );
  });

  it('passes includeResolved=false when resolved comments are hidden', async () => {
    const { result } = renderHook(() =>
      useCommentExport({ activeVersionId: 'ver1', showResolved: false })
    );

    await act(async () => {
      await result.current.exportComments('pdf');
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/versions/ver1/comments/export?format=pdf&includeResolved=false'
    );
  });

  it('does nothing without an active version', async () => {
    const { result } = renderHook(() =>
      useCommentExport({ activeVersionId: null, showResolved: false })
    );

    await act(async () => {
      await result.current.exportComments('csv');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.isExportingCsv).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('downloads under the filename the server sent', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ disposition: 'attachment; filename="Ad campaign-v2-comments.csv"' })
    );
    const { result } = renderHook(() =>
      useCommentExport({ activeVersionId: 'ver1', showResolved: false })
    );

    await act(async () => {
      await result.current.exportComments('csv');
    });

    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('Ad campaign-v2-comments.csv');
    expect(clicked[0].href).toBe('blob:openframe-test');
  });

  it('accepts an unquoted filename too', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ disposition: 'attachment; filename=report.pdf' }));
    const { result } = renderHook(() =>
      useCommentExport({ activeVersionId: 'ver1', showResolved: false })
    );

    await act(async () => {
      await result.current.exportComments('pdf');
    });

    expect(clicked[0].download).toBe('report.pdf');
  });

  it('falls back to comments.<format> when no filename was sent', async () => {
    const { result } = renderHook(() =>
      useCommentExport({ activeVersionId: 'ver1', showResolved: false })
    );

    await act(async () => {
      await result.current.exportComments('pdf');
    });

    expect(clicked[0].download).toBe('comments.pdf');
  });

  it('leaves no anchor and no object URL behind', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { result } = renderHook(() =>
      useCommentExport({ activeVersionId: 'ver1', showResolved: false })
    );

    await act(async () => {
      await result.current.exportComments('csv');
    });

    expect(document.querySelectorAll('a')).toHaveLength(0);
    expect(revoke).toHaveBeenCalledWith('blob:openframe-test');
    expect(toastSuccess).toHaveBeenCalledWith('Comments exported as CSV');
  });

  it('tracks csv and pdf progress independently', async () => {
    let release: (value: unknown) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const { result } = renderHook(() =>
      useCommentExport({ activeVersionId: 'ver1', showResolved: false })
    );

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.exportComments('csv');
    });

    expect(result.current.isExportingCsv).toBe(true);
    expect(result.current.isExportingPdf).toBe(false);

    await act(async () => {
      release(fakeResponse());
      await pending;
    });

    expect(result.current.isExportingCsv).toBe(false);
  });

  it('surfaces the server error message and clears the busy flag', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ ok: false, json: () => Promise.resolve({ error: 'Too many comments' }) })
    );
    const { result } = renderHook(() =>
      useCommentExport({ activeVersionId: 'ver1', showResolved: false })
    );

    await act(async () => {
      await result.current.exportComments('csv');
    });

    expect(toastError).toHaveBeenCalledWith('Too many comments');
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(0);
    expect(result.current.isExportingCsv).toBe(false);
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: false }));
    const { result } = renderHook(() =>
      useCommentExport({ activeVersionId: 'ver1', showResolved: false })
    );

    await act(async () => {
      await result.current.exportComments('csv');
    });

    expect(toastError).toHaveBeenCalledWith('Failed to export comments');
  });

  it('falls back to a generic message when the error body has no error string', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ ok: false, json: () => Promise.resolve({ error: { code: 500 } }) })
    );
    const { result } = renderHook(() =>
      useCommentExport({ activeVersionId: 'ver1', showResolved: false })
    );

    await act(async () => {
      await result.current.exportComments('csv');
    });

    expect(toastError).toHaveBeenCalledWith('Failed to export comments');
  });

  it('reports a network failure instead of hanging on the busy flag', async () => {
    fetchMock.mockRejectedValue(new Error('Network down'));
    const { result } = renderHook(() =>
      useCommentExport({ activeVersionId: 'ver1', showResolved: false })
    );

    await act(async () => {
      await result.current.exportComments('pdf');
    });

    await waitFor(() => expect(result.current.isExportingPdf).toBe(false));
    expect(toastError).toHaveBeenCalledWith('Network down');
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to export comments:',
      expect.objectContaining({ message: 'Network down' })
    );
  });
});

describe('NLE downloads', () => {
  it('encodes rational FPS, origin and DF options and uses the XML filename', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ disposition: 'attachment; filename="markers.xml"' })
    );
    const { result } = renderHook(() =>
      useCommentExport({ activeVersionId: 'ver1', showResolved: false })
    );
    await act(async () => {
      await result.current.exportComments('xml', {
        fps: '30000/1001',
        origin: '01:00:00;00',
        dropFrame: true,
      });
    });
    const url = new URL(fetchMock.mock.calls[0][0], 'https://example.com');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      format: 'xml',
      includeResolved: 'false',
      fps: '30000/1001',
      origin: '01:00:00;00',
      dropFrame: 'true',
    });
    expect(clicked).toEqual([{ download: 'markers.xml', href: 'blob:openframe-test' }]);
    expect(result.current.isExportingNle).toBe(false);
  });
  it('tracks a pending EDL export and clears it after refusal without downloading', async () => {
    let finish!: (response: ReturnType<typeof fakeResponse>) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const { result } = renderHook(() =>
      useCommentExport({ activeVersionId: 'ver1', showResolved: true })
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.exportComments('edl', {
        fps: '24',
        origin: '00:00:00:00',
        dropFrame: false,
      });
    });
    expect(result.current.isExportingNle).toBe(true);
    expect(result.current.isExportingPdf).toBe(false);
    await act(async () => {
      finish(fakeResponse({ ok: false, json: async () => ({ error: 'Too many markers' }) }));
      await pending;
    });
    expect(result.current.isExportingNle).toBe(false);
    expect(clicked).toHaveLength(0);
    expect(toastError).toHaveBeenCalledWith('Too many markers');
  });
});
