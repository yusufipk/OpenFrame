import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
