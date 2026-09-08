import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  findCancelableStripeSubscription,
  isCurrentSubscriptionInvoice,
  voidOpenSubscriptionInvoices,
} from '@/lib/billing';

const stripe = vi.hoisted(() => ({
  subscriptions: { list: vi.fn(), retrieve: vi.fn() },
  invoices: { list: vi.fn(), update: vi.fn(), voidInvoice: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/stripe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stripe')>()),
  getStripe: () => stripe,
}));

const START = 1_800_000_000;
const END = 1_802_592_000;

function subscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: 'sub_target',
    customer: 'cus_target',
    status: 'past_due',
    created: 100,
    latest_invoice: 'in_current',
    cancel_at: null,
    cancel_at_period_end: false,
    items: {
      data: [
        {
          price: { id: 'price_plan' },
          current_period_start: START,
          current_period_end: END,
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function line(overrides: Record<string, unknown> = {}) {
  return {
    id: 'il_plan',
    amount: 1900,
    period: { start: START, end: END },
    parent: {
      type: 'subscription_item_details',
      subscription_item_details: { subscription: 'sub_target', proration: false },
    },
    pricing: { price_details: { price: 'price_plan' } },
    ...overrides,
  };
}

function invoice(overrides: Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: 'in_current',
    customer: 'cus_target',
    status: 'open',
    amount_paid: 0,
    amount_due: 1900,
    billing_reason: 'subscription_cycle',
    auto_advance: true,
    parent: { subscription_details: { subscription: 'sub_target' } },
    lines: { data: [line()], has_more: false },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('STRIPE_PRICE_ID', 'price_plan');
  stripe.subscriptions.retrieve.mockResolvedValue(subscription());
  stripe.subscriptions.list.mockResolvedValue({ data: [], has_more: false });
  stripe.invoices.list.mockResolvedValue({ data: [], has_more: false });
  stripe.invoices.update.mockResolvedValue({});
  stripe.invoices.voidInvoice.mockResolvedValue({});
});

describe('subscription invoice cleanup', () => {
  it.each(['subscription_cycle', 'subscription_create'])(
    'voids a complete unpaid current %s invoice and returns its id',
    async (billingReason) => {
      const current = invoice({ billing_reason: billingReason });
      stripe.invoices.list.mockResolvedValue({ data: [current], has_more: false });

      expect(isCurrentSubscriptionInvoice(current, subscription())).toBe(true);
      await expect(voidOpenSubscriptionInvoices('cus_target', 'sub_target')).resolves.toEqual([
        'in_current',
      ]);

      expect(stripe.subscriptions.retrieve).toHaveBeenCalledExactlyOnceWith('sub_target');
      expect(stripe.invoices.update).toHaveBeenCalledExactlyOnceWith('in_current', {
        auto_advance: false,
      });
      expect(stripe.invoices.voidInvoice).toHaveBeenCalledExactlyOnceWith('in_current');
    }
  );

  const retainedInvoices: [string, () => Stripe.Invoice][] = [
    [
      'a different start with the current end',
      () =>
        invoice({
          lines: { data: [line({ period: { start: START - 86400, end: END } })], has_more: false },
        }),
    ],
    [
      'a different end with the current start',
      () =>
        invoice({
          lines: { data: [line({ period: { start: START, end: END + 86400 } })], has_more: false },
        }),
    ],
    ['an older invoice id', () => invoice({ id: 'in_old' })],
    [
      'an older service period',
      () =>
        invoice({
          lines: {
            data: [line({ period: { start: START - 2_592_000, end: START } })],
            has_more: false,
          },
        }),
    ],
    [
      'a mixed invoice containing a manual charge',
      () =>
        invoice({
          lines: {
            data: [
              line(),
              line({
                id: 'il_manual',
                parent: { type: 'invoice_item_details', invoice_item_details: {} },
              }),
            ],
            has_more: false,
          },
        }),
    ],
    [
      'a proration',
      () =>
        invoice({
          lines: {
            data: [
              line({
                parent: {
                  type: 'subscription_item_details',
                  subscription_item_details: { subscription: 'sub_target', proration: true },
                },
              }),
            ],
            has_more: false,
          },
        }),
    ],
    ['a partly paid invoice', () => invoice({ amount_paid: 500, amount_due: 1400 })],
    ['a truncated line item page', () => invoice({ lines: { data: [line()], has_more: true } })],
    [
      'a different price',
      () =>
        invoice({
          lines: {
            data: [line({ pricing: { price_details: { price: 'price_other' } } })],
            has_more: false,
          },
        }),
    ],
    [
      'a line belonging to a different subscription',
      () =>
        invoice({
          lines: {
            data: [
              line({
                parent: {
                  type: 'subscription_item_details',
                  subscription_item_details: { subscription: 'sub_other', proration: false },
                },
              }),
            ],
            has_more: false,
          },
        }),
    ],
    ['an invoice with no lines', () => invoice({ lines: { data: [], has_more: false } })],
    ['a subscription update invoice', () => invoice({ billing_reason: 'subscription_update' })],
  ];

  it.each(retainedInvoices)('retains %s but pauses collection', async (_label, makeInvoice) => {
    const retained = makeInvoice();
    stripe.invoices.list.mockResolvedValue({ data: [retained], has_more: false });

    expect(isCurrentSubscriptionInvoice(retained, subscription())).toBe(false);
    await expect(
      voidOpenSubscriptionInvoices('cus_target', 'sub_target', subscription())
    ).resolves.toEqual([]);
    expect(stripe.invoices.update).toHaveBeenCalledExactlyOnceWith(retained.id, {
      auto_advance: false,
    });
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled();
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('traverses invoice pages using the last unfiltered id and leaves foreign invoices untouched', async () => {
    stripe.invoices.list
      .mockResolvedValueOnce({
        data: [
          invoice({ id: 'in_old' }),
          invoice({
            id: 'in_foreign',
            parent: { subscription_details: { subscription: 'sub_other' } },
          }),
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({ data: [invoice()], has_more: false });

    await expect(
      voidOpenSubscriptionInvoices('cus_target', 'sub_target', subscription())
    ).resolves.toEqual(['in_current']);
    expect(stripe.invoices.list.mock.calls).toEqual([
      [{ customer: 'cus_target', status: 'open', limit: 100 }],
      [{ customer: 'cus_target', status: 'open', limit: 100, starting_after: 'in_foreign' }],
    ]);
    expect(stripe.invoices.update.mock.calls).toEqual([
      ['in_old', { auto_advance: false }],
      ['in_current', { auto_advance: false }],
    ]);
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledExactlyOnceWith('in_current');
  });

  it('voids a current invoice even when collection was already paused before a retry', async () => {
    stripe.invoices.list.mockResolvedValue({
      data: [invoice({ auto_advance: false })],
      has_more: false,
    });

    await expect(
      voidOpenSubscriptionInvoices(
        'cus_target',
        'sub_target',
        subscription({
          status: 'canceled',
          latest_invoice: { id: 'in_current' },
        })
      )
    ).resolves.toEqual(['in_current']);
    expect(stripe.invoices.update).not.toHaveBeenCalled();
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledExactlyOnceWith('in_current');
  });

  it.each(['retrieve', 'list', 'update', 'voidInvoice'] as const)(
    'propagates the Stripe %s failure rather than claiming successful cleanup',
    async (operation) => {
      const failure = new Error(`Stripe ${operation} failed`);
      stripe.invoices.list.mockResolvedValue({ data: [invoice()], has_more: false });
      const failingCall =
        operation === 'retrieve' ? stripe.subscriptions.retrieve : stripe.invoices[operation];
      failingCall.mockRejectedValueOnce(failure);

      await expect(voidOpenSubscriptionInvoices('cus_target', 'sub_target')).rejects.toBe(failure);
      expect(failingCall).toHaveBeenCalledTimes(1);
      if (operation !== 'voidInvoice') expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled();
    }
  );

  it('rejects a subscription snapshot belonging to another customer before touching invoices', async () => {
    await expect(
      voidOpenSubscriptionInvoices(
        'cus_target',
        'sub_target',
        subscription({
          customer: { id: 'cus_other' },
        })
      )
    ).rejects.toThrow('Subscription customer mismatch');
    expect(stripe.invoices.list).not.toHaveBeenCalled();
    expect(stripe.invoices.update).not.toHaveBeenCalled();
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled();
  });
});

describe('cancellation candidate selection', () => {
  it.each([
    { cancel_at: END, cancel_at_period_end: false },
    { cancel_at: null, cancel_at_period_end: true },
  ])(
    'skips a scheduled paid subscription ($cancel_at, $cancel_at_period_end) for an older unscheduled one',
    async (schedule) => {
      stripe.subscriptions.list
        .mockResolvedValueOnce({
          data: [
            subscription({
              id: 'sub_newer',
              status: 'active',
              created: 200,
              ...schedule,
            }),
          ],
          has_more: true,
        })
        .mockResolvedValueOnce({
          data: [
            subscription({
              id: 'sub_older',
              status: 'active',
              created: 100,
            }),
          ],
          has_more: false,
        });

      expect((await findCancelableStripeSubscription('cus_target'))?.id).toBe('sub_older');
      expect(stripe.subscriptions.list.mock.calls).toEqual([
        [{ customer: 'cus_target', status: 'all', limit: 100 }],
        [{ customer: 'cus_target', status: 'all', limit: 100, starting_after: 'sub_newer' }],
      ]);
      expect(stripe.invoices.list).not.toHaveBeenCalled();
    }
  );

  it.each(['past_due', 'unpaid', 'incomplete'] as const)(
    'still selects a scheduled %s subscription for immediate cancellation',
    async (status) => {
      stripe.subscriptions.list.mockResolvedValue({
        data: [subscription({ status, cancel_at: END, cancel_at_period_end: true })],
        has_more: false,
      });

      expect((await findCancelableStripeSubscription('cus_target'))?.id).toBe('sub_target');
      expect(stripe.invoices.list).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['a current invoice still awaiting void', { auto_advance: false }],
    ['an older invoice still collecting', { id: 'in_old', auto_advance: true }],
  ])('selects a canceled subscription with %s for cleanup retry', async (_label, overrides) => {
    stripe.subscriptions.list.mockResolvedValue({
      data: [subscription({ status: 'canceled' })],
      has_more: false,
    });
    stripe.invoices.list.mockResolvedValue({ data: [invoice(overrides)], has_more: false });

    expect((await findCancelableStripeSubscription('cus_target'))?.id).toBe('sub_target');
    expect(stripe.invoices.list).toHaveBeenCalledExactlyOnceWith({
      customer: 'cus_target',
      status: 'open',
      limit: 100,
    });
    expect(stripe.invoices.update).not.toHaveBeenCalled();
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled();
  });

  it('does not offer cleanup again for retained paused debt or a foreign invoice', async () => {
    stripe.subscriptions.list.mockResolvedValue({
      data: [subscription({ status: 'canceled' })],
      has_more: false,
    });
    stripe.invoices.list.mockResolvedValue({
      data: [
        invoice({ id: 'in_old', auto_advance: false }),
        invoice({
          id: 'in_foreign',
          parent: { subscription_details: { subscription: 'sub_other' } },
        }),
      ],
      has_more: false,
    });

    await expect(findCancelableStripeSubscription('cus_target')).resolves.toBeNull();
  });

  it.each(['active', 'canceled'] as const)(
    'ignores a %s subscription for a different product',
    async (status) => {
      stripe.subscriptions.list.mockResolvedValue({
        data: [
          subscription({
            status,
            items: { data: [{ price: { id: 'price_other' } }] },
          }),
        ],
        has_more: false,
      });

      await expect(findCancelableStripeSubscription('cus_target')).resolves.toBeNull();
      expect(stripe.invoices.list).not.toHaveBeenCalled();
    }
  );

  it('propagates invoice lookup failures while finding canceled cleanup candidates', async () => {
    const failure = new Error('Stripe invoice lookup failed');
    stripe.subscriptions.list.mockResolvedValue({
      data: [subscription({ status: 'canceled' })],
      has_more: false,
    });
    stripe.invoices.list.mockRejectedValueOnce(failure);

    await expect(findCancelableStripeSubscription('cus_target')).rejects.toBe(failure);
  });
});
