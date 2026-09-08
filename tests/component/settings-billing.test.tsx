import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsPage from '@/app/(dashboard)/settings/settings-page-client';

function renderScheduledCancellation(status: 'ACTIVE' | 'TRIALING') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url !== '/api/billing') return { ok: false };
      return {
        ok: true,
        json: async () => ({
          data: {
            isEnabled: true,
            isConfigured: true,
            checkoutAvailable: false,
            portalAvailable: true,
            cancelAvailable: false,
            needsPaymentFix: false,
            openInvoice: null,
            workspaceCreation: { canCreateWorkspace: true, canStartTrial: false },
            subscription: {
              status,
              label: status === 'ACTIVE' ? 'Active' : 'Trialing',
              hasActiveSubscription: true,
              hasRecoverableSubscription: true,
              hasActiveTrial: true,
              hasBillingAccess: true,
              currentPeriodEnd: '2026-10-08T12:00:00Z',
              trialEndsAt: '2026-09-15T12:00:00Z',
              cancelAtPeriodEnd: true,
              cancelAt: '2026-10-08T12:00:00Z',
            },
          },
        }),
      };
    })
  );
  render(<SettingsPage billingOnly />);
}

afterEach(() => vi.unstubAllGlobals());

describe('scheduled cancellation in billing settings', () => {
  it('keeps a paid subscription distinct from its remaining cardless trial', async () => {
    renderScheduledCancellation('ACTIVE');

    expect(
      await screen.findByText(
        'Subscription canceled. Access remains active until the end of the current billing period.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Trial canceled/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Access ends on/)).not.toBeInTheDocument();
    expect(screen.getByText(/Your subscription ends on/)).toHaveTextContent(
      new Date('2026-10-08T12:00:00Z').toLocaleDateString()
    );
    expect(screen.getByText(/Cancellation takes effect on/)).toBeInTheDocument();
    expect(screen.queryByText(/Cancellation was scheduled on/)).not.toBeInTheDocument();
  });

  it('still explains the trial end for a Stripe trial subscription', async () => {
    renderScheduledCancellation('TRIALING');

    expect(
      await screen.findByText('Trial canceled. Access remains active until the trial ends.')
    ).toBeInTheDocument();
    expect(screen.getByText(/Access ends on/)).toHaveTextContent(
      new Date('2026-09-15T12:00:00Z').toLocaleDateString()
    );
  });
});

function renderPastDue(hasBillingAccess: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url !== '/api/billing') return { ok: false };
      return {
        ok: true,
        json: async () => ({
          data: {
            isEnabled: true,
            isConfigured: true,
            checkoutAvailable: false,
            portalAvailable: true,
            cancelAvailable: true,
            cancelIsImmediate: true,
            needsPaymentFix: true,
            openInvoice: null,
            workspaceCreation: { canCreateWorkspace: hasBillingAccess, canStartTrial: false },
            subscription: {
              status: 'PAST_DUE',
              label: 'Past due',
              hasActiveSubscription: false,
              hasRecoverableSubscription: true,
              hasActiveTrial: false,
              hasBillingAccess,
              currentPeriodEnd: '2026-10-08T12:00:00Z',
              trialEndsAt: null,
              cancelAtPeriodEnd: false,
              cancelAt: null,
            },
          },
        }),
      };
    })
  );
  render(<SettingsPage billingOnly />);
}

describe('past-due access in billing settings', () => {
  it('opens immediate unpaid cancellation copy and waits for confirmation', async () => {
    const user = userEvent.setup();
    renderPastDue(true);

    await user.click(await screen.findByRole('button', { name: 'Cancel subscription' }));

    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/This subscription ends immediately\./)).toHaveTextContent(
      'Canceling does not extend access to your workspaces.'
    );
    expect(dialog.getByText(/Automatic collection stops/)).toHaveTextContent(
      'charges for prior service and other items may still be owed.'
    );
    expect(dialog.queryByText(/Everything stays on until/)).not.toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Cancel subscription' })).toBeEnabled();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/billing/cancel')).toBe(false);

    await user.click(dialog.getByRole('button', { name: 'Keep subscription' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/billing/cancel')).toBe(false);
  });

  it('shows continued workspace access during payment grace without an active trial', async () => {
    renderPastDue(true);

    expect(
      await screen.findByText('Workspace access remains available while you resolve your payment.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Billing access has ended.')).not.toBeInTheDocument();
    expect(screen.queryByText('Free trial, no card required.')).not.toBeInTheDocument();
  });

  it('shows access has ended when payment grace has expired and no trial remains', async () => {
    renderPastDue(false);

    expect(await screen.findByText('Billing access has ended.')).toBeInTheDocument();
    expect(
      screen.queryByText('Workspace access remains available while you resolve your payment.')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Free trial, no card required.')).not.toBeInTheDocument();
  });
});
