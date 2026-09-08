import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { BillingSubscriptionStatus, type User } from '@prisma/client';
import { db } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import { POST as cancelRoute } from '@/app/api/billing/cancel/route';
import { GET as billingRoute } from '@/app/api/billing/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { createSubscribedUser, createUser } from '../factories';

const ORIGIN_HEADERS = { origin: 'http://localhost:3000' };
const ENTITLED_PRICE_ID = 'price_test_openframe_dummy';
const DAY = 24 * 60 * 60;
const unix = (offsetSeconds: number) => Math.floor(Date.now() / 1000) + offsetSeconds;

function cancelRequest(body: unknown = {}) {
  return apiRequest('/api/billing/cancel', {
    method: 'POST',
    headers: ORIGIN_HEADERS,
    body,
  });
}

function subscription(user: User, overrides: Partial<Stripe.Subscription> = {}) {
  return {
    id: user.stripeSubscriptionId ?? 'sub_unmirrored',
    customer: user.stripeCustomerId,
    status: 'active',
    created: unix(-30 * DAY),
    cancel_at_period_end: user.stripeCancelAtPeriodEnd,
    cancel_at: null,
    trial_end: null,
    latest_invoice: 'in_renewal',
    items: {
      data: [
        {
          id: 'si_plan',
          price: { id: ENTITLED_PRICE_ID },
          current_period_start: unix(-10 * DAY),
          current_period_end: unix(20 * DAY),
        },
      ],
    },
    ...overrides,
  } as Stripe.Subscription;
}

function renewal(sub: Stripe.Subscription, overrides: Partial<Stripe.Invoice> = {}) {
  return {
    id: 'in_renewal',
    customer: sub.customer,
    status: 'open',
    auto_advance: true,
    amount_paid: 0,
    billing_reason: 'subscription_cycle',
    period_start: sub.items.data[0].current_period_start,
    period_end: sub.items.data[0].current_period_end,
    parent: { type: 'subscription_details', subscription_details: { subscription: sub.id } },
    lines: {
      has_more: false,
      data: [
        {
          id: 'il_renewal',
          amount: 2000,
          period: {
            start: sub.items.data[0].current_period_start,
            end: sub.items.data[0].current_period_end,
          },
          parent: {
            type: 'subscription_item_details',
            subscription_item_details: {
              subscription: sub.id,
              subscription_item: 'si_plan',
              proration: false,
            },
          },
          pricing: { type: 'price_details', price_details: { price: ENTITLED_PRICE_ID } },
        },
      ],
    },
    ...overrides,
  } as Stripe.Invoice;
}

// Only Stripe is replaced. Selection, invoice eligibility, reason persistence,
// paid claims and customer-wide sync use their real implementation and test DB.
function stubStripe(initial: Stripe.Subscription[], invoices: Stripe.Invoice[] = []) {
  const subscriptions = initial.map((sub) => structuredClone(sub));
  const replace = (id: string, patch: Partial<Stripe.Subscription>) => {
    const index = subscriptions.findIndex((sub) => sub.id === id);
    if (index < 0) throw new Error(`Unknown fixture subscription ${id}`);
    subscriptions[index] = { ...subscriptions[index], ...patch };
    return structuredClone(subscriptions[index]);
  };
  const update = vi.fn(async (id: string, params: Stripe.SubscriptionUpdateParams) =>
    replace(id, { cancel_at_period_end: params.cancel_at_period_end })
  );
  const cancel = vi.fn(async (id: string, params: Stripe.SubscriptionCancelParams) => {
    void params;
    return replace(id, {
      status: 'canceled',
      cancel_at_period_end: false,
      canceled_at: unix(0),
      ended_at: unix(0),
    });
  });
  const list = vi.fn(async (params: Stripe.SubscriptionListParams) => ({
    data: structuredClone(subscriptions.filter((sub) => sub.customer === params.customer)),
    has_more: false,
  }));
  const sessions: Stripe.Checkout.Session[] = [];
  const sessionList = vi.fn(async (params: Stripe.Checkout.SessionListParams) => ({
    data: sessions.filter(
      (session) => session.status === 'open' && session.customer === params.customer
    ),
    has_more: false,
  }));
  const expire = vi.fn(async (id: string) => {
    const session = sessions.find((item) => item.id === id)!;
    session.status = 'expired';
    const subId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription!.id;
    replace(subId, { status: 'incomplete_expired' });
    return session;
  });
  const voidInvoice = vi.fn(async (id: string) => {
    const invoice = invoices.find((item) => item.id === id)!;
    invoice.status = 'void';
    return invoice;
  });
  const invoiceUpdate = vi.fn(async (id: string, params: Stripe.InvoiceUpdateParams) => {
    const invoice = invoices.find((item) => item.id === id)!;
    invoice.auto_advance = params.auto_advance ?? invoice.auto_advance;
    return invoice;
  });
  vi.mocked(getStripe as unknown as () => unknown).mockReturnValue({
    subscriptions: {
      update,
      cancel,
      list,
      retrieve: vi.fn(async (id: string) =>
        structuredClone(subscriptions.find((sub) => sub.id === id))
      ),
    },
    checkout: { sessions: { list: sessionList, expire } },
    invoices: {
      list: vi.fn(async (params: Stripe.InvoiceListParams) => ({
        data: invoices.filter(
          (invoice) => invoice.customer === params.customer && invoice.status === 'open'
        ),
        has_more: false,
      })),
      listLineItems: vi.fn(async (id: string) => invoices.find((item) => item.id === id)!.lines),
      voidInvoice,
      update: invoiceUpdate,
    },
  });
  return { update, cancel, list, sessionList, expire, sessions, voidInvoice, invoiceUpdate };
}

describe('POST /api/billing/cancel', () => {
  it('returns 401 without a session and leaves subscription and reasons untouched', async () => {
    const user = await createSubscribedUser();
    const stripe = stubStripe([subscription(user)]);
    signedOut();
    const response = await callRoute(cancelRoute, cancelRequest());
    expect(response.status).toBe(401);
    expect(stripe.update).not.toHaveBeenCalled();
    expect(stripe.cancel).not.toHaveBeenCalled();
    expect(await db.subscriptionCancellation.count()).toBe(0);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).stripeCancelAtPeriodEnd
    ).toBe(false);
  });

  it('rejects a cross-origin request without changing billing state', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    const stripe = stubStripe([subscription(user)]);
    const response = await callRoute(
      cancelRoute,
      apiRequest('/api/billing/cancel', {
        method: 'POST',
        headers: { origin: 'https://evil.test' },
        body: {},
      })
    );
    expect(response.status).toBe(403);
    expect(stripe.update).not.toHaveBeenCalled();
    expect(await db.subscriptionCancellation.count()).toBe(0);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).stripeCancelAtPeriodEnd
    ).toBe(false);
  });

  it('refuses an account with no Stripe subscription', async () => {
    const user = await createUser();
    signedInAs(user);
    const stripe = stubStripe([]);
    expect((await callRoute(cancelRoute, cancelRequest({ reason: 'NOT_USING' }))).status).toBe(409);
    expect(stripe.update).not.toHaveBeenCalled();
    expect(await db.subscriptionCancellation.count()).toBe(0);
  });

  it('does not cancel another customer subscription referenced by a stale local mirror or request body', async () => {
    const owner = await createSubscribedUser();
    const caller = await createSubscribedUser({ stripeSubscriptionId: 'sub_foreign_stale' });
    signedInAs(caller);
    const stripe = stubStripe([subscription(owner, { id: 'sub_foreign_stale' })]);
    const response = await callRoute(
      cancelRoute,
      cancelRequest({
        reason: 'OTHER',
        customerId: owner.stripeCustomerId,
        subscriptionId: owner.stripeSubscriptionId,
      })
    );
    expect(response.status).toBe(409);
    expect(stripe.list).toHaveBeenCalledWith(
      expect.objectContaining({ customer: caller.stripeCustomerId })
    );
    expect(stripe.update).not.toHaveBeenCalled();
    expect(stripe.cancel).not.toHaveBeenCalled();
    expect(await db.subscriptionCancellation.count()).toBe(0);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: owner.id } })).stripeCancelAtPeriodEnd
    ).toBe(false);
  });

  it('rejects a candidate whose Stripe customer does not match the signed-in account', async () => {
    const user = await createSubscribedUser();
    const owner = await createSubscribedUser();
    signedInAs(user);
    const foreign = subscription(owner);
    const stripe = stubStripe([foreign]);
    stripe.list.mockResolvedValueOnce({ data: [foreign], has_more: false });
    expect((await callRoute(cancelRoute, cancelRequest())).status).toBe(409);
    expect(stripe.update).not.toHaveBeenCalled();
    expect(stripe.cancel).not.toHaveBeenCalled();
    expect(await db.subscriptionCancellation.count()).toBe(0);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: owner.id } })).stripeCancelAtPeriodEnd
    ).toBe(false);
  });

  it('rejects an already scheduled paid subscription without a reason write', async () => {
    const user = await createSubscribedUser({ stripeCancelAtPeriodEnd: true });
    signedInAs(user);
    const stripe = stubStripe([subscription(user)]);
    expect((await callRoute(cancelRoute, cancelRequest())).status).toBe(409);
    expect(stripe.update).not.toHaveBeenCalled();
    expect(stripe.cancel).not.toHaveBeenCalled();
    expect(await db.subscriptionCancellation.count()).toBe(0);
  });

  it.each([
    { reason: 'RAGE_QUIT' },
    { reason: 'OTHER', note: 'x'.repeat(501) },
    { reason: 'OTHER', note: 42 },
  ])('rejects malformed cancellation input %# before Stripe writes', async (body) => {
    const user = await createSubscribedUser();
    signedInAs(user);
    const stripe = stubStripe([subscription(user)]);
    expect((await callRoute(cancelRoute, cancelRequest(body))).status).toBe(400);
    expect(stripe.update).not.toHaveBeenCalled();
    expect(stripe.cancel).not.toHaveBeenCalled();
    expect(await db.subscriptionCancellation.count()).toBe(0);
  });

  it.each(['active', 'trialing'] as const)(
    'schedules %s, persists the trimmed reason and syncs the user',
    async (status) => {
      const user = await createSubscribedUser();
      signedInAs(user);
      const original = subscription(user, { status });
      const stripe = stubStripe([original]);
      const response = await callRoute(
        cancelRoute,
        cancelRequest({ reason: 'MISSING_FEATURE', note: '  Bulk upload.  ' })
      );
      expect(response.status).toBe(200);
      expect(await readData(response)).toMatchObject({
        cancelAtPeriodEnd: true,
        canceledImmediately: false,
        voidedInvoices: [],
        status,
        periodEnd: new Date(original.items.data[0].current_period_end * 1000).toISOString(),
      });
      expect(stripe.update).toHaveBeenCalledExactlyOnceWith(user.stripeSubscriptionId, {
        cancel_at_period_end: true,
        cancellation_details: { feedback: 'missing_features' },
      });
      expect(stripe.cancel).not.toHaveBeenCalled();
      const rows = await db.subscriptionCancellation.findMany({ where: { userId: user.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        stripeSubscriptionId: original.id,
        reason: 'MISSING_FEATURE',
        note: 'Bulk upload.',
      });
      const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.stripeCancelAtPeriodEnd).toBe(true);
      expect(after.subscriptionStatus).toBe(
        status === 'active' ? BillingSubscriptionStatus.ACTIVE : BillingSubscriptionStatus.TRIALING
      );
      expect(after.stripeCurrentPeriodEnd?.getTime()).toBe(
        original.items.data[0].current_period_end * 1000
      );
    }
  );

  it('finds an unscheduled paid subscription behind an already scheduled authoritative one', async () => {
    const user = await createSubscribedUser({ stripeCancelAtPeriodEnd: true });
    signedInAs(user);
    const scheduled = subscription(user);
    const other = subscription(user, {
      id: 'sub_other_paid',
      cancel_at_period_end: false,
      created: unix(-60 * DAY),
    });
    const stripe = stubStripe([scheduled, other]);
    const overview = await billingRoute();
    expect(overview.status).toBe(200);
    expect(await readData(overview)).toMatchObject({
      cancelAvailable: true,
      cancelIsImmediate: false,
    });
    const response = await callRoute(cancelRoute, cancelRequest({ reason: 'PROJECT_ENDED' }));
    expect(response.status).toBe(200);
    expect(stripe.update).toHaveBeenCalledExactlyOnceWith(
      other.id,
      expect.objectContaining({ cancel_at_period_end: true })
    );
    expect((await db.subscriptionCancellation.findFirstOrThrow()).stripeSubscriptionId).toBe(
      other.id
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).stripeSubscriptionId).toBe(
      scheduled.id
    );
  });

  it.each(['past_due', 'unpaid', 'incomplete'] as const)(
    'cancels %s immediately, stops collection and records the reason',
    async (status) => {
      const user = await createSubscribedUser({
        subscriptionStatus: BillingSubscriptionStatus.PAST_DUE,
      });
      signedInAs(user);
      const original = subscription(user, { status });
      const invoice = renewal(original);
      const stripe = stubStripe([original], [invoice]);
      const response = await callRoute(
        cancelRoute,
        cancelRequest({ reason: 'PRICE_OR_BILLING', note: '  Stop billing.  ' })
      );
      expect(response.status).toBe(200);
      expect(await readData(response)).toMatchObject({
        canceledImmediately: true,
        cancelAtPeriodEnd: false,
        voidedInvoices: [invoice.id],
        status: 'canceled',
      });
      expect(stripe.cancel).toHaveBeenCalledExactlyOnceWith(original.id, {
        cancellation_details: { feedback: 'too_expensive' },
      });
      expect(stripe.update).not.toHaveBeenCalled();
      expect(invoice.status).toBe('void');
      expect(await db.subscriptionCancellation.findFirstOrThrow()).toMatchObject({
        reason: 'PRICE_OR_BILLING',
        note: 'Stop billing.',
        stripeSubscriptionId: original.id,
      });
      const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.subscriptionStatus).toBe(BillingSubscriptionStatus.CANCELED);
      expect(after.stripeCancelAtPeriodEnd).toBe(false);
    }
  );

  it('uses the original period to void the renewal when cancellation shortens the response period', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    const original = subscription(user, { status: 'past_due' });
    const invoice = renewal(original);
    const stripe = stubStripe([original], [invoice]);
    const cancel = stripe.cancel.getMockImplementation()!;
    stripe.cancel.mockImplementationOnce(async (id, params) => ({
      ...(await cancel(id, params)),
      items: {
        ...original.items,
        data: original.items.data.map((item) => ({ ...item, current_period_end: unix(0) })),
      },
    }));
    const response = await callRoute(cancelRoute, cancelRequest());
    expect(response.status).toBe(200);
    expect(await readData(response)).toMatchObject({ voidedInvoices: [invoice.id] });
    expect(invoice.status).toBe('void');
  });

  it.each(['past_due', 'unpaid'] as const)(
    'offers cancellation for already scheduled %s and preserves another paid subscription',
    async (status) => {
      const user = await createSubscribedUser({
        stripeCancelAtPeriodEnd: true,
        subscriptionStatus:
          status === 'past_due'
            ? BillingSubscriptionStatus.PAST_DUE
            : BillingSubscriptionStatus.UNPAID,
      });
      signedInAs(user);
      const unpaid = subscription(user, { status });
      const paid = subscription(user, { id: 'sub_still_paid', cancel_at_period_end: true });
      const stripe = stubStripe([unpaid, paid]);
      const overview = await billingRoute();
      expect(overview.status).toBe(200);
      expect(await readData(overview)).toMatchObject({
        cancelAvailable: true,
        cancelIsImmediate: true,
      });
      expect((await callRoute(cancelRoute, cancelRequest({ reason: 'NOT_USING' }))).status).toBe(
        200
      );
      expect(stripe.cancel).toHaveBeenCalledExactlyOnceWith(unpaid.id, expect.anything());
      expect(stripe.update).not.toHaveBeenCalled();
      const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.subscriptionStatus).toBe(BillingSubscriptionStatus.ACTIVE);
      expect(after.stripeSubscriptionId).toBe(paid.id);
      expect(after.stripeCancelAtPeriodEnd).toBe(true);
      expect((await db.subscriptionCancellation.findFirstOrThrow()).stripeSubscriptionId).toBe(
        unpaid.id
      );
    }
  );

  it('expires only the incomplete subscription matching an owned open Checkout session', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    const original = subscription(user, { status: 'incomplete' });
    const other = subscription(user, { id: 'sub_other_checkout', status: 'incomplete' });
    const stripe = stubStripe([original, other]);
    stripe.sessions.push(
      {
        id: 'cs_other',
        customer: user.stripeCustomerId,
        subscription: other.id,
        status: 'open',
      } as Stripe.Checkout.Session,
      {
        id: 'cs_match',
        customer: user.stripeCustomerId,
        subscription: { id: original.id },
        status: 'open',
      } as Stripe.Checkout.Session
    );
    const response = await callRoute(
      cancelRoute,
      cancelRequest({ reason: 'OTHER', note: 'Checkout abandoned' })
    );
    expect(response.status).toBe(200);
    expect(await readData(response)).toMatchObject({
      canceledImmediately: true,
      status: 'incomplete_expired',
    });
    expect(stripe.sessionList).toHaveBeenCalledWith(
      expect.objectContaining({ customer: user.stripeCustomerId, status: 'open' })
    );
    expect(stripe.expire).toHaveBeenCalledExactlyOnceWith('cs_match');
    expect(stripe.cancel).not.toHaveBeenCalled();
    expect(stripe.sessions[0].status).toBe('open');
    expect((await db.subscriptionCancellation.findFirstOrThrow()).note).toBe('Checkout abandoned');
  });

  it.each(['past_due', 'incomplete'] as const)(
    'retries failed %s cleanup without recanceling or overwriting its reason',
    async (status) => {
      const user = await createSubscribedUser();
      signedInAs(user);
      const original = subscription(user, { status });
      const invoice = renewal(original);
      const stripe = stubStripe([original], [invoice]);
      if (status === 'incomplete') {
        stripe.sessions.push({
          id: 'cs_retry',
          customer: user.stripeCustomerId,
          subscription: original.id,
          status: 'open',
        } as Stripe.Checkout.Session);
      }
      stripe.voidInvoice.mockRejectedValueOnce(new Error('Invoice cleanup unavailable'));
      const first = await callRoute(
        cancelRoute,
        cancelRequest({ reason: 'OTHER', note: 'Keep my answer' })
      );
      expect(first.status).toBe(500);
      expect(invoice.status).toBe('open');
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).subscriptionStatus).toBe(
        status === 'incomplete'
          ? BillingSubscriptionStatus.INCOMPLETE_EXPIRED
          : BillingSubscriptionStatus.CANCELED
      );
      const overview = await billingRoute();
      expect(overview.status).toBe(200);
      expect(await readData(overview)).toMatchObject({
        cancelAvailable: true,
        cancelIsImmediate: true,
      });
      const second = await callRoute(cancelRoute, cancelRequest({ reason: 'NOT_USING' }));
      expect(second.status).toBe(200);
      expect(await readData(second)).toMatchObject({
        canceledImmediately: true,
        voidedInvoices: [invoice.id],
      });
      expect(stripe.cancel).toHaveBeenCalledTimes(status === 'incomplete' ? 0 : 1);
      expect(stripe.expire).toHaveBeenCalledTimes(status === 'incomplete' ? 1 : 0);
      expect(stripe.voidInvoice).toHaveBeenCalledTimes(2);
      expect(invoice.status).toBe('void');
      const rows = await db.subscriptionCancellation.findMany({ where: { userId: user.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ reason: 'OTHER', note: 'Keep my answer' });
    }
  );

  it('stops retrying a retained receivable without voiding it', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    const original = subscription(user, { status: 'unpaid' });
    const invoice = renewal(original, { billing_reason: 'manual' });
    const stripe = stubStripe([original], [invoice]);
    const response = await callRoute(cancelRoute, cancelRequest());
    expect(response.status).toBe(200);
    expect(await readData(response)).toMatchObject({
      canceledImmediately: true,
      voidedInvoices: [],
    });
    expect(stripe.voidInvoice).not.toHaveBeenCalled();
    expect(stripe.invoiceUpdate).toHaveBeenCalledWith(
      invoice.id,
      expect.objectContaining({ auto_advance: false })
    );
    expect(invoice.status).toBe('open');
    expect(invoice.auto_advance).toBe(false);
  });

  it.each([{}, { reason: 'PROJECT_ENDED', note: '   ' }])(
    'allows skipping feedback and trims empty notes %#',
    async (body) => {
      const user = await createSubscribedUser();
      signedInAs(user);
      stubStripe([subscription(user)]);
      expect((await callRoute(cancelRoute, cancelRequest(body))).status).toBe(200);
      expect(await db.subscriptionCancellation.findFirstOrThrow()).toMatchObject({
        reason: 'reason' in body ? body.reason : null,
        note: null,
      });
    }
  );

  it('lets only one of two concurrent paid requests through', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    const stripe = stubStripe([subscription(user)]);
    const results = await Promise.all([
      callRoute(cancelRoute, cancelRequest({ reason: 'NOT_USING' })),
      callRoute(cancelRoute, cancelRequest({ reason: 'OTHER' })),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(stripe.update).toHaveBeenCalledTimes(1);
    expect(await db.subscriptionCancellation.count({ where: { userId: user.id } })).toBe(1);
  });

  it('keeps the cancellation and reason when customer-wide sync fails', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    const original = subscription(user);
    const stripe = stubStripe([original]);
    stripe.list
      .mockResolvedValueOnce({ data: [original], has_more: false })
      .mockRejectedValueOnce(new Error('Sync unavailable'));
    expect(
      (await callRoute(cancelRoute, cancelRequest({ reason: 'PRICE_OR_BILLING' }))).status
    ).toBe(200);
    expect((await db.subscriptionCancellation.findFirstOrThrow()).reason).toBe('PRICE_OR_BILLING');
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).stripeCancelAtPeriodEnd
    ).toBe(true);
  });

  it.each([true, false])(
    'releases the paid claim when Stripe rejects the update (invalid request: %s)',
    async (invalidRequest) => {
      const user = await createSubscribedUser();
      signedInAs(user);
      const stripe = stubStripe([subscription(user)]);
      const error = invalidRequest
        ? Object.assign(new Error('No such subscription'), { type: 'StripeInvalidRequestError' })
        : new Error('Stripe unavailable');
      stripe.update.mockRejectedValueOnce(error);
      const response = await callRoute(cancelRoute, cancelRequest({ reason: 'NOT_USING' }));
      expect(response.status).toBe(invalidRequest ? 409 : 500);
      if (invalidRequest) expect(await readError(response)).toMatch(/Manage Subscription/);
      expect(await db.subscriptionCancellation.count()).toBe(0);
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: user.id } })).stripeCancelAtPeriodEnd
      ).toBe(false);
    }
  );
});

describe('repeated and concurrent cancellation reasons', () => {
  it('records a new immediate cancellation after an earlier scheduled cancellation was resumed', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    const original = subscription(user, { status: 'past_due' });
    const stripe = stubStripe([original]);
    await db.subscriptionCancellation.create({
      data: {
        userId: user.id,
        stripeSubscriptionId: original.id,
        reason: 'PRICE_OR_BILLING',
        note: 'Previous canceled cycle',
        createdAt: new Date(Date.now() - 40 * DAY * 1000),
        periodEnd: new Date(Date.now() - 30 * DAY * 1000),
      },
    });
    const response = await callRoute(
      cancelRoute,
      cancelRequest({ reason: 'PROJECT_ENDED', note: 'Current cancellation' })
    );
    expect(response.status).toBe(200);
    expect(stripe.cancel).toHaveBeenCalledTimes(1);
    const rows = await db.subscriptionCancellation.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'PROJECT_ENDED', note: 'Current cancellation' }),
      ])
    );
  });

  it('records only one reason when concurrent requests cancel a nonmirrored paid subscription', async () => {
    const user = await createSubscribedUser({ stripeCancelAtPeriodEnd: true });
    signedInAs(user);
    const scheduled = subscription(user);
    const other = subscription(user, {
      id: 'sub_other_paid',
      cancel_at_period_end: false,
      created: unix(-60 * DAY),
    });
    const stripe = stubStripe([scheduled, other]);
    const update = stripe.update.getMockImplementation()!;
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const timeout = setTimeout(release, 1000);
    stripe.update.mockImplementation(async (id, params) => {
      entered += 1;
      if (entered === 2) release();
      await barrier;
      return update(id, params);
    });
    try {
      const responses = await Promise.all([
        callRoute(cancelRoute, cancelRequest({ reason: 'NOT_USING' })),
        callRoute(cancelRoute, cancelRequest({ reason: 'OTHER' })),
      ]);
      expect(entered).toBe(2);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(
        await db.subscriptionCancellation.count({
          where: { userId: user.id, stripeSubscriptionId: other.id },
        })
      ).toBe(1);
    } finally {
      clearTimeout(timeout);
    }
  });
});
