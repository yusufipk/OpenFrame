import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import SettingsPage from '@/app/(dashboard)/settings/settings-page-client';

// API scaling expectations are literal, independent of production Intl logic.
// USD, JPY, KRW: https://docs.stripe.com/currencies#zero-decimal
// ISK, UGX: https://docs.stripe.com/currencies#special-cases
// KWD: https://support.stripe.com/questions/which-payments-methods-and-products-are-available-in-the-uae?locale=en-GB
// KWD support is account/region dependent. This is a synthetic component fixture,
// not evidence that the configured billing account accepts KWD invoices.
const cases = [
  { currency: 'usd', amountDue: 1099, expected: '$10.99' },
  { currency: 'jpy', amountDue: 500, expected: '¥500' },
  { currency: 'krw', amountDue: 500, expected: '₩500' },
  { currency: 'kwd', amountDue: 12340, expected: 'KWD 12.340' },
  { currency: 'isk', amountDue: 500, expected: 'ISK 5' },
  { currency: 'ugx', amountDue: 500, expected: 'UGX 5' },
];

const NumberFormat = Intl.NumberFormat;

beforeEach(() => {
  // Pin the locale while retaining the real currency precision and formatting.
  vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (locales, options) {
    return new NumberFormat(locales ?? 'en-US', options);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('actual Settings invoice display against Stripe currency contract', () => {
  it.each(cases)('$currency amount_due=$amountDue displays $expected', async (fixture) => {
    expect(new Intl.NumberFormat().resolvedOptions().locale).toBe('en-US');
    const fetchMock = vi.fn(async (url: string) => {
      if (url !== '/api/billing') return { ok: false };
      return {
        ok: true,
        json: async () => ({
          data: {
            isEnabled: true,
            isConfigured: true,
            status: 'ready',
            checkoutAvailable: false,
            portalAvailable: false,
            cancelAvailable: false,
            cancelIsImmediate: true,
            needsPaymentFix: true,
            openInvoice: {
              id: 'in_currency_fixture',
              hostedInvoiceUrl: null,
              amountDue: fixture.amountDue,
              currency: fixture.currency,
              attemptCount: 1,
              nextPaymentAttempt: null,
            },
            workspaceCreation: { canCreateWorkspace: true, canStartTrial: false },
            subscription: {
              status: 'PAST_DUE',
              label: 'Past due',
              hasActiveSubscription: false,
              hasRecoverableSubscription: true,
              hasActiveTrial: false,
              hasBillingAccess: true,
              isPaid: false,
              priceId: null,
              currentPeriodEnd: null,
              cancelAtPeriodEnd: false,
              cancelAt: null,
              trialEndsAt: null,
              billingAccessEndedAt: null,
              storageCleanupEligibleAt: null,
            },
          },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<SettingsPage billingOnly />);
    const banner = await screen.findByText(/^A payment of .* did not go through$/);
    const actual = banner.textContent!.replace(/\s+/g, ' ');
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/billing')).toBe(true);
    expect(actual).toBe(`A payment of ${fixture.expected} did not go through`);
  });
});
