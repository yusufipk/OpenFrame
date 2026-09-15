import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VideoSharePageClient from '@/app/(dashboard)/projects/[projectId]/videos/[videoId]/share/video-share-page-client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => vi.unstubAllGlobals());

describe('video sharing access', () => {
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
      expect(screen.getByRole('button', { name: 'Restrict access' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restrict access' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm access change' }));
    await waitFor(() =>
      expect(screen.queryByDisplayValue('https://example.com/s/review')).not.toBeInTheDocument()
    );
    expect(await screen.findByText('Create Review Link')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/share'))).toHaveLength(2);
  });
});
