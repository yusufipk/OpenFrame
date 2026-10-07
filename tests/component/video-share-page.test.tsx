import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VideoSharePageClient from '@/app/(dashboard)/projects/[projectId]/videos/[videoId]/share/video-share-page-client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => vi.unstubAllGlobals());

describe('video sharing access', () => {
  it('ignores an old activity response that finishes after link regeneration', async () => {
    let finishRefresh!: (response: Response) => void;
    let finishRegeneration!: (response: Response) => void;
    const oldPayload = {
      data: {
        link: {
          hasPassword: false,
          allowDownloads: false,
          firstOpenedAt: '2026-10-06T08:00:00.000Z',
          lastOpenedAt: '2026-10-06T08:00:00.000Z',
        },
        shareUrl: 'https://example.com/s/old',
      },
    };
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options?: RequestInit) => {
        if (options?.method === 'POST')
          return new Promise<Response>((resolve) => {
            finishRegeneration = resolve;
          });
        if (reads++ === 0) return Promise.resolve(Response.json(oldPayload));
        return new Promise<Response>((resolve) => {
          finishRefresh = resolve;
        });
      })
    );
    render(<VideoSharePageClient projectId="project" videoId="video" />);
    await screen.findByDisplayValue('https://example.com/s/old');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh activity' }));
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate Link' }));
    });
    await act(async () =>
      finishRegeneration(
        Response.json({
          data: {
            link: {
              hasPassword: false,
              allowDownloads: false,
              firstOpenedAt: null,
              lastOpenedAt: null,
            },
            shareUrl: 'https://example.com/s/new',
          },
        })
      )
    );
    await act(async () => finishRefresh(Response.json(oldPayload)));
    expect(screen.getByDisplayValue('https://example.com/s/new')).toBeInTheDocument();
    expect(screen.getByText('No opens recorded yet')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('https://example.com/s/old')).not.toBeInTheDocument();
  });

  it('refreshes recorded opens and clears them when regenerating the link', async () => {
    let refreshCount = 0;
    const firstOpenedAt = '2026-10-06T08:00:00.000Z';
    const lastOpenedAt = '2026-10-06T09:00:00.000Z';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options?: RequestInit) => {
        const opened = options?.method !== 'POST' && refreshCount++ > 0;
        return Response.json({
          data: {
            link: {
              hasPassword: false,
              allowDownloads: false,
              firstOpenedAt: opened ? firstOpenedAt : null,
              lastOpenedAt: opened ? lastOpenedAt : null,
            },
            shareUrl: 'https://example.com/s/review',
          },
        });
      })
    );
    const { container } = render(<VideoSharePageClient projectId="project" videoId="video" />);
    expect(await screen.findByText('No opens recorded yet')).toBeInTheDocument();
    expect(screen.getByText(/not who opened the link or whether they watched/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activity' }));
    expect(await screen.findByText('First recorded open')).toBeInTheDocument();
    expect(screen.getByText('Last recorded open')).toBeInTheDocument();
    expect(Array.from(container.querySelectorAll('time'), (element) => element.dateTime)).toEqual([
      firstOpenedAt,
      lastOpenedAt,
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate Link' }));
    expect(await screen.findByText('No opens recorded yet')).toBeInTheDocument();
    expect(container.querySelectorAll('time')).toHaveLength(0);
  });

  it('manages members from Share Video and reloads the link after restricting access', async () => {
    let revoked = false;
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/share')) {
        return Response.json({
          data: {
            link: revoked ? null : { hasPassword: false, allowDownloads: false },
            shareUrl: revoked ? null : 'https://example.com/s/review',
          },
        });
      }
      const body = JSON.parse(String(options?.body));
      if (body.action === 'members') {
        return Response.json({ data: { accessMode: 'INHERIT', members: [], invitations: [] } });
      }
      if (!body.confirmationToken) {
        return Response.json({
          data: { needsConfirmation: true, confirmationToken: 'confirm', message: 'Revoke link?' },
        });
      }
      revoked = true;
      return Response.json({ data: { accessMode: 'RESTRICTED' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<VideoSharePageClient projectId="project" videoId="video" />);
    await screen.findByDisplayValue('https://example.com/s/review');
    expect(screen.queryByRole('button', { name: 'Manage access' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Members' }));
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Only invited people' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only invited people' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm access change' }));
    await waitFor(() =>
      expect(screen.queryByDisplayValue('https://example.com/s/review')).not.toBeInTheDocument()
    );
    expect(await screen.findByText('Create Review Link')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/share'))).toHaveLength(2);
  });
});
