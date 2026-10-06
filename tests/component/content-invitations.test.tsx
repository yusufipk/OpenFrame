import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { ContentAccessControls } from '@/components/content-access-controls';
import { MembersManagementPage } from '@/components/members-management-page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type Pending = {
  id: string;
  email: string;
  role: string;
  invitationUrl: string;
  expiresAt: string;
  invitedBy: { name: string };
};
let pending: Pending[];
let emailSent: boolean;
let requests: Array<{ email: string; role: string }>;
let failRefresh: boolean;
let failedEmails: string[];
beforeEach(() => {
  pending = [];
  emailSent = true;
  requests = [];
  failRefresh = false;
  failedEmails = [];
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const body = init?.body ? JSON.parse(init.body) : { action: 'members' };
      if (body.action === 'members' && failRefresh && requests.length)
        return Response.json({ error: 'Failed to load members' }, { status: 500 });
      if (body.action === 'members')
        return Response.json({
          data: {
            members: [],
            invitations: pending,
            pendingInvitations: pending,
            owner: null,
            accessMode: 'RESTRICTED',
          },
        });
      requests.push({ email: body.email, role: body.role });
      if (failedEmails.includes(body.email)) throw new Error('offline');
      let invitation = pending.find((row) => row.email === body.email);
      if (!invitation) {
        invitation = {
          id: body.email,
          email: body.email,
          role: body.role,
          invitationUrl: `https://example.test/accept?email=${body.email}`,
          expiresAt: '2026-10-13T00:00:00Z',
          invitedBy: { name: 'Owner' },
        };
        pending.push(invitation);
      }
      return Response.json({ data: { invitationUrl: invitation.invitationUrl, emailSent } });
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('content invitation dialog', () => {
  it('reports a partial batch without claiming the failed invitation was created', async () => {
    failedEmails = ['two@example.com'];
    const user = userEvent.setup();
    render(<ContentAccessControls projectId="project" folderId="folder" share />);
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await user.type(screen.getByLabelText('Invitation email'), 'one@example.com,two@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitations' }));
    expect(await screen.findByText('Invitation email sent to one@example.com.')).toBeVisible();
    expect(
      screen.queryByText(
        'Invitation created for two@example.com, but email could not be sent. Copy the link to share it.'
      )
    ).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(
      'two@example.com: Could not send invitation. Try again.'
    );
    expect(screen.getByLabelText('Invitation email')).toHaveValue('two@example.com');
    expect(screen.getAllByRole('button', { name: 'Copy link' })).toHaveLength(1);
  });
  it('invites several recipients, keeps every link, and resends with the original role', async () => {
    const user = userEvent.setup();
    render(<ContentAccessControls projectId="project" folderId="folder" share />);
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send invitations' })).toBeEnabled()
    );
    await user.type(screen.getByLabelText('Invitation email'), 'one@example.com,two@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitations' }));
    expect(await screen.findByText('Invitation email sent to one@example.com.')).toBeVisible();
    expect(screen.getByText('Invitation email sent to two@example.com.')).toBeVisible();
    expect(screen.getByLabelText('Invitation link for one@example.com')).toHaveValue(
      'https://example.test/accept?email=one@example.com'
    );
    expect(screen.getByLabelText('Invitation link for two@example.com')).toHaveValue(
      'https://example.test/accept?email=two@example.com'
    );
    expect(screen.getAllByRole('button', { name: 'Copy link' })).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: 'Copy link' })[0]);
    await expect(navigator.clipboard.readText()).resolves.toBe(
      'https://example.test/accept?email=one@example.com'
    );
    await user.click(screen.getAllByRole('button', { name: 'Resend' })[0]);
    await waitFor(() =>
      expect(requests).toEqual([
        { email: 'one@example.com', role: 'COMMENTATOR' },
        { email: 'two@example.com', role: 'COMMENTATOR' },
        { email: 'one@example.com', role: 'COMMENTATOR' },
      ])
    );
    expect(screen.getByLabelText('Invitation link for one@example.com')).toHaveValue(
      'https://example.test/accept?email=one@example.com'
    );
  });

  it('reports email failure and retains a copyable fallback', async () => {
    emailSent = false;
    const user = userEvent.setup();
    render(<ContentAccessControls projectId="project" videoId="video" share />);
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send invitations' })).toBeEnabled()
    );
    await user.type(screen.getByLabelText('Invitation email'), 'one@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitations' }));
    expect(
      await screen.findByText(
        'Invitation created for one@example.com, but email could not be sent. Copy the link to share it.'
      )
    ).toBeVisible();
    expect(screen.getByLabelText('Invitation link')).toHaveValue(
      'https://example.test/accept?email=one@example.com'
    );
  });
});

describe.each(['content', 'members'] as const)('%s fallback links', (target) => {
  it('keeps every POST link when email and subsequent list refresh fail', async () => {
    emailSent = false;
    failRefresh = true;
    const user = userEvent.setup();
    if (target === 'content') {
      render(<ContentAccessControls projectId="project" folderId="folder" share />);
      await user.click(screen.getByRole('button', { name: 'Share' }));
    } else
      render(
        <MembersManagementPage
          apiBasePath="/api/projects/project"
          backHref="/dashboard"
          backLabel="Back"
          title="Members"
          subtitle="Project members"
          membersDescription="Manage members"
        />
      );
    const email = await screen.findByLabelText(
      target === 'content' ? 'Invitation email' : 'Email Addresses'
    );
    const button = screen.getByRole('button', {
      name: target === 'content' ? 'Send invitations' : 'Invite',
    });
    await user.type(email, 'one@example.com,two@example.com');
    await user.click(button);
    expect(await screen.findByLabelText('Invitation link for one@example.com')).toHaveValue(
      'https://example.test/accept?email=one@example.com'
    );
    expect(screen.getByLabelText('Invitation link for two@example.com')).toHaveValue(
      'https://example.test/accept?email=two@example.com'
    );
    expect(screen.getAllByRole('button', { name: 'Copy link' })).toHaveLength(2);
  });
});

describe('project and workspace invitations', () => {
  it('supports newline separated recipients and per-row resend links', async () => {
    const user = userEvent.setup();
    render(
      <MembersManagementPage
        apiBasePath="/api/projects/project"
        backHref="/dashboard"
        backLabel="Back"
        title="Members"
        subtitle="Project members"
        membersDescription="Manage members"
      />
    );
    await user.type(
      await screen.findByLabelText('Email Addresses'),
      'one@example.com\ntwo@example.com'
    );
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    await screen.findByLabelText('Invitation link for two@example.com');
    expect(screen.getByLabelText('Invitation link for one@example.com')).toHaveValue(
      'https://example.test/accept?email=one@example.com'
    );
    const row = screen.getByText('one@example.com', { exact: true }).parentElement!.parentElement!;
    await user.click(within(row).getByRole('button', { name: 'Resend' }));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]).toEqual({ email: 'one@example.com', role: 'COMMENTATOR' });
  });
});
