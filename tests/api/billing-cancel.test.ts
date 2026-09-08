import { describe, expect, it, vi } from 'vitest';
import { BillingSubscriptionStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import { POST as cancelRoute } from '@/app/api/billing/cancel/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { createSubscribedUser, createUser } from '../factories';

const ORIGIN_HEADERS = { origin: 'http://localhost:3000' };
const ENTITLED_PRICE_ID = 'price_test_openframe_dummy';
const DAY = 24 * 60 * 60;

function unix(offsetSeconds: number): number {
  return Math.floor(Date.now() / 1000) + offsetSeconds;
}

function cancelRequest(body?: unknown) {
  return apiRequest('/api/billing/cancel', {
    method: 'POST',
    headers: ORIGIN_HEADERS,
    body: body ?? {},
  });
}

/**
 * Stands in for `stripe.subscriptions.update`, echoing back the subscription
 * the way Stripe does: same id, `cancel_at_period_end` flipped, period end
 * intact. The echo matters because the route syncs that object into the user
 * row without waiting for the webhook.
 */
function stubStripeUpdate(
  options: { customer?: string | null; periodEnd?: number | null; status?: string } = {}
) {
  const periodEnd = options.periodEnd === undefined ? unix(20 * DAY) : options.periodEnd;
  const update = vi.fn(async (id: string, params: Record<string, unknown>) => ({
    id,
    // The sync looks the user up by this, so a stub that names the wrong
    // customer leaves the user row untouched and the webhook to fix it later.
    customer: options.customer ?? 'cus_test_cancel',
    status: options.status ?? 'active',
    created: unix(-30 * DAY),
    cancel_at_period_end: params.cancel_at_period_end === true,
    cancel_at: null,
    trial_end: null,
    // Where the pinned API version reports the period: on the item, not on the
    // subscription. A stub that puts it at the top level hides a null date.
    items: { data: [{ price: { id: ENTITLED_PRICE_ID }, current_period_end: periodEnd }] },
  }));

  vi.mocked(getStripe as unknown as () => unknown).mockReturnValue({
    subscriptions: { update, list: vi.fn(async () => ({ data: [] })) },
  });

  return update;
}

describe('POST /api/billing/cancel', () => {
  it('returns 401 without a session', async () => {
    signedOut();

    const response = await callRoute(cancelRoute, cancelRequest());

    expect(response.status).toBe(401);
  });

  it('rejects a cross-origin request', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);

    const response = await callRoute(
      cancelRoute,
      apiRequest('/api/billing/cancel', {
        method: 'POST',
        headers: { origin: 'https://evil.test' },
        body: {},
      })
    );

    expect(response.status).toBe(403);
  });

  it('refuses when there is no active subscription to cancel', async () => {
    const trialUser = await createUser();
    signedInAs(trialUser);
    const update = stubStripeUpdate();

    const response = await callRoute(cancelRoute, cancelRequest({ reason: 'NOT_USING' }));

    expect(response.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
    expect(await db.subscriptionCancellation.count()).toBe(0);
  });

  it('refuses a second cancellation of a subscription already set to end', async () => {
    const user = await createSubscribedUser({ stripeCancelAtPeriodEnd: true });
    signedInAs(user);
    const update = stubStripeUpdate();

    const response = await callRoute(cancelRoute, cancelRequest({ reason: 'OTHER' }));

    expect(response.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects an unknown reason without touching Stripe', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    const update = stubStripeUpdate();

    const response = await callRoute(cancelRoute, cancelRequest({ reason: 'RAGE_QUIT' }));

    expect(response.status).toBe(400);
    expect(await readError(response)).toMatch(/reason/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a note longer than the column allows', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    const update = stubStripeUpdate();

    const response = await callRoute(
      cancelRoute,
      cancelRequest({ reason: 'OTHER', note: 'x'.repeat(501) })
    );

    expect(response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  // The whole point: one Stripe write with the answer attached, one row that
  // keeps the answer on our side, and the user row updated before any webhook.
  it('schedules the cancellation, records the reason and syncs the user row', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    const periodEnd = unix(12 * DAY);
    const update = stubStripeUpdate({ customer: user.stripeCustomerId, periodEnd });

    const response = await callRoute(
      cancelRoute,
      cancelRequest({ reason: 'MISSING_FEATURE', note: '  Bulk upload for 16x9 and 9x16.  ' })
    );

    expect(response.status).toBe(200);
    const data = await readData<{ cancelAtPeriodEnd: boolean; periodEnd: string | null }>(response);
    expect(data.cancelAtPeriodEnd).toBe(true);
    expect(data.periodEnd).toBe(new Date(periodEnd * 1000).toISOString());

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(user.stripeSubscriptionId, {
      cancel_at_period_end: true,
      cancellation_details: { feedback: 'missing_features' },
    });

    const rows = await db.subscriptionCancellation.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stripeSubscriptionId: user.stripeSubscriptionId,
      reason: 'MISSING_FEATURE',
      note: 'Bulk upload for 16x9 and 9x16.',
    });
    expect(rows[0].periodEnd?.getTime()).toBe(periodEnd * 1000);

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.stripeCancelAtPeriodEnd).toBe(true);
    expect(after.subscriptionStatus).toBe(BillingSubscriptionStatus.ACTIVE);
    expect(after.stripeCurrentPeriodEnd?.getTime()).toBe(periodEnd * 1000);
  });

  // Skipping the question is allowed and must still cancel. The row is kept
  // with no reason so the admin tally can count how often the question is
  // skipped rather than pretending those cancellations never happened.
  it('cancels with no reason given and records the skip', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    const update = stubStripeUpdate();

    const response = await callRoute(cancelRoute, cancelRequest({}));

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith(user.stripeSubscriptionId, {
      cancel_at_period_end: true,
      cancellation_details: {},
    });

    const row = await db.subscriptionCancellation.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.reason).toBeNull();
    expect(row.note).toBeNull();
  });

  // A note under an answer that does not ask for one is still accepted by the
  // API; the dialog is what hides the box, and the route must not depend on it.
  it('keeps a note on any reason and drops an empty one', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    stubStripeUpdate();

    const response = await callRoute(
      cancelRoute,
      cancelRequest({ reason: 'PROJECT_ENDED', note: '   ' })
    );

    expect(response.status).toBe(200);
    const row = await db.subscriptionCancellation.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.reason).toBe('PROJECT_ENDED');
    expect(row.note).toBeNull();
  });

  it('rejects a note that is not text', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    const update = stubStripeUpdate();

    const response = await callRoute(cancelRoute, cancelRequest({ reason: 'OTHER', note: 42 }));

    expect(response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  // Two requests racing for the same subscription must produce one Stripe
  // write and one reason row, or the admin tally counts a churn twice.
  it('lets only one of two concurrent requests through', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    const update = stubStripeUpdate({ customer: user.stripeCustomerId });

    const [first, second] = await Promise.all([
      callRoute(cancelRoute, cancelRequest({ reason: 'NOT_USING' })),
      callRoute(cancelRoute, cancelRequest({ reason: 'OTHER' })),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(await db.subscriptionCancellation.count({ where: { userId: user.id } })).toBe(1);
  });

  // The reason row and the local flag must survive a sync that blows up: the
  // webhook rewrites the same state later, the answer would be gone for good.
  it('keeps the cancellation and the reason when the local sync fails', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    vi.mocked(getStripe as unknown as () => unknown).mockReturnValue({
      subscriptions: {
        // No `items` at all: the sync reads `items.data` and throws.
        update: vi.fn(async (id: string) => ({ id, customer: user.stripeCustomerId })),
        list: vi.fn(async () => ({ data: [] })),
      },
    });

    const response = await callRoute(cancelRoute, cancelRequest({ reason: 'PRICE_OR_BILLING' }));

    expect(response.status).toBe(200);
    const row = await db.subscriptionCancellation.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.reason).toBe('PRICE_OR_BILLING');
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.stripeCancelAtPeriodEnd).toBe(true);
  });

  // A subscription Stripe no longer knows is the customer's state, not a
  // server fault: a 409 with a pointer to the portal, and the claim handed back
  // so the button still works once the webhook catches up.
  it('answers 409 and releases the claim when Stripe rejects the subscription id', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    vi.mocked(getStripe as unknown as () => unknown).mockReturnValue({
      subscriptions: {
        update: vi.fn(async () => {
          throw Object.assign(new Error('No such subscription'), {
            type: 'StripeInvalidRequestError',
          });
        }),
        list: vi.fn(async () => ({ data: [] })),
      },
    });

    const response = await callRoute(cancelRoute, cancelRequest({ reason: 'NOT_USING' }));

    expect(response.status).toBe(409);
    expect(await readError(response)).toMatch(/Manage Subscription/);
    expect(await db.subscriptionCancellation.count()).toBe(0);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.stripeCancelAtPeriodEnd).toBe(false);
  });

  it('does not record a reason and releases the claim when Stripe is down', async () => {
    const user = await createSubscribedUser();
    signedInAs(user);
    vi.mocked(getStripe as unknown as () => unknown).mockReturnValue({
      subscriptions: {
        update: vi.fn(async () => {
          throw new Error('No such subscription');
        }),
        list: vi.fn(async () => ({ data: [] })),
      },
    });

    const response = await callRoute(cancelRoute, cancelRequest({ reason: 'NOT_USING' }));

    expect(response.status).toBe(500);
    expect(await db.subscriptionCancellation.count()).toBe(0);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.stripeCancelAtPeriodEnd).toBe(false);
  });
});
