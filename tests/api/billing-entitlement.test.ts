import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  buildBillingAccessWhereInput,
  buildExpiredBillingWhereInput,
  getBillingAccessEndDate,
  getStorageCleanupEligibleAt,
  hasBillingAccess,
  isPaidTier,
  startCardlessTrial,
  syncStripeCustomerSubscriptions,
} from '@/lib/billing';
import { getStripe } from '@/lib/stripe';
import { db } from '../helpers/db';
import { createUser } from '../factories';

// Uses the API project's real database and reset hooks. Run only when no other API suite uses it.
const CUSTOMER_ID = 'cus_entitlement_regression';
const SUBSCRIPTION_ID = 'sub_entitlement_regression';
const PRICE_ID = 'price_entitlement_regression';
const TRIAL_START = new Date('2026-10-01T00:00:00.000Z');
const TRIAL_END = new Date('2026-10-08T00:00:00.000Z');
const CANCELED_AT = new Date('2026-10-02T00:00:00.000Z');
const REPORTED_PERIOD_END = new Date('2026-11-01T00:00:00.000Z');

function subscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: SUBSCRIPTION_ID,
    customer: CUSTOMER_ID,
    status: 'canceled',
    created: Date.parse('2026-09-01T00:00:00.000Z') / 1000,
    trial_end: null,
    ended_at: CANCELED_AT.getTime() / 1000,
    canceled_at: CANCELED_AT.getTime() / 1000,
    cancel_at: null,
    cancel_at_period_end: false,
    // Deliberately no top-level period: the regression depends on the item-only payload.
    items: {
      data: [
        {
          price: { id: PRICE_ID },
          current_period_start: TRIAL_START.getTime() / 1000,
          current_period_end: REPORTED_PERIOD_END.getTime() / 1000,
        },
      ],
    },
    ...overrides,
  } as Stripe.Subscription;
}

function stubSubscription(value: Stripe.Subscription) {
  const list = vi.fn(async () => ({ data: [value] }));
  vi.mocked(getStripe).mockReturnValue({ subscriptions: { list } } as unknown as Stripe);
  return list;
}

async function startDeferredTrial() {
  const user = await createUser({
    subscriptionStatus: 'PAST_DUE',
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: SUBSCRIPTION_ID,
    stripePriceId: PRICE_ID,
    stripeCurrentPeriodEnd: REPORTED_PERIOD_END,
    trialEndsAt: null,
    billingTrialConsumedAt: null,
  });
  expect(await startCardlessTrial(user.id, TRIAL_START)).toBe(true);
  const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(stored.trialEndsAt).toEqual(TRIAL_END);
  expect(stored.billingTrialConsumedAt).toEqual(TRIAL_START);
  return user.id;
}

async function matchingAccessUsers(userId: string, now: Date) {
  return db.user.findMany({
    where: { AND: [{ id: userId }, buildBillingAccessWhereInput(now)] },
    select: { id: true },
  });
}

async function matchingCleanupUsers(userId: string, now: Date) {
  return db.user.findMany({
    where: { AND: [{ id: userId }, buildExpiredBillingWhereInput(now)] },
    select: { id: true },
  });
}

describe('billing entitlement and retention after subscription sync', () => {
  beforeEach(() => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    vi.stubEnv('STRIPE_PRICE_ID', PRICE_ID);
    // Mock only Date so PostgreSQL sockets and query timers keep running normally.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TRIAL_START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Catches restoring `hasAccess || hasActiveTrial(preservedTrialEnd)` when writing the cutoff.
  it('preserves a deferred trial without granting paid access to the canceled unpaid period', async () => {
    const userId = await startDeferredTrial();
    const list = stubSubscription(subscription());
    vi.setSystemTime(CANCELED_AT);

    await syncStripeCustomerSubscriptions(CUSTOMER_ID);

    expect(list).toHaveBeenCalledWith({ customer: CUSTOMER_ID, status: 'all', limit: 100 });
    const stored = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.subscriptionStatus).toBe('CANCELED');
    expect(stored.stripeCurrentPeriodEnd).toEqual(REPORTED_PERIOD_END);
    expect(stored.trialEndsAt).toEqual(TRIAL_END);
    expect(stored.billingTrialConsumedAt).toEqual(TRIAL_START);
    expect(stored.billingAccessEndedAt).toEqual(CANCELED_AT);

    await Promise.all(
      [
        { now: CANCELED_AT, expected: true },
        { now: new Date('2026-10-07T23:59:59.999Z'), expected: true },
        { now: TRIAL_END, expected: false },
        { now: new Date('2026-10-09T00:00:00.000Z'), expected: false },
      ].map(async ({ now, expected }) => {
        expect(isPaidTier(stored, now)).toBe(false);
        expect(hasBillingAccess(stored, now)).toBe(expected);
        expect(await matchingAccessUsers(userId, now)).toEqual(expected ? [{ id: userId }] : []);
      })
    );
  });

  // Catches choosing the raw unpaid period, choosing the earlier expiry, or requiring that raw period to lapse in SQL.
  it.each([
    {
      label: 'trial outlasts the subscription',
      subscriptionEnd: CANCELED_AT,
      lastEntitlementEnd: TRIAL_END,
      cleanupAt: new Date('2026-10-23T00:00:00.000Z'),
    },
    {
      label: 'subscription outlasts the trial',
      subscriptionEnd: new Date('2026-10-12T00:00:00.000Z'),
      lastEntitlementEnd: new Date('2026-10-12T00:00:00.000Z'),
      cleanupAt: new Date('2026-10-27T00:00:00.000Z'),
    },
  ])('retains storage until the last legitimate expiry plus 15 days: $label', async (scenario) => {
    const userId = await startDeferredTrial();
    stubSubscription(
      subscription({
        ended_at: scenario.subscriptionEnd.getTime() / 1000,
        canceled_at: scenario.subscriptionEnd.getTime() / 1000,
      })
    );
    vi.setSystemTime(scenario.subscriptionEnd);

    await syncStripeCustomerSubscriptions(CUSTOMER_ID);

    const stored = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.billingAccessEndedAt).toEqual(scenario.subscriptionEnd);
    expect(stored.trialEndsAt).toEqual(TRIAL_END);
    expect(stored.stripeCurrentPeriodEnd).toEqual(REPORTED_PERIOD_END);
    expect(getBillingAccessEndDate(stored)).toEqual(scenario.lastEntitlementEnd);
    expect(getStorageCleanupEligibleAt(stored)).toEqual(scenario.cleanupAt);
    expect(hasBillingAccess(stored, scenario.cleanupAt)).toBe(false);
    const [before, at] = await Promise.all([
      matchingCleanupUsers(userId, new Date(scenario.cleanupAt.getTime() - 1)),
      matchingCleanupUsers(userId, scenario.cleanupAt),
    ]);
    expect(before).toEqual([]);
    expect(at).toEqual([{ id: userId }]);
  });

  // Catches replacing persisted trial history with keepUnexpiredTrial on a terminal resync.
  it('keeps expired trial history and the retention deadline across repeated terminal syncs', async () => {
    const userId = await startDeferredTrial();
    stubSubscription(subscription());
    vi.setSystemTime(CANCELED_AT);
    await syncStripeCustomerSubscriptions(CUSTOMER_ID);

    for (const now of ['2026-10-09T00:00:00.000Z', '2026-10-20T00:00:00.000Z']) {
      vi.setSystemTime(new Date(now));
      await syncStripeCustomerSubscriptions(CUSTOMER_ID);

      const stored = await db.user.findUniqueOrThrow({ where: { id: userId } });
      expect(stored.trialEndsAt).toEqual(TRIAL_END);
      expect(stored.billingTrialConsumedAt).toEqual(TRIAL_START);
      expect(stored.billingAccessEndedAt).toEqual(CANCELED_AT);
      expect(isPaidTier(stored)).toBe(false);
      expect(hasBillingAccess(stored)).toBe(false);
      expect(getStorageCleanupEligibleAt(stored)).toEqual(new Date('2026-10-23T00:00:00.000Z'));
      expect(await matchingCleanupUsers(userId, new Date(now))).toEqual([]);
    }

    expect(await matchingCleanupUsers(userId, new Date('2026-10-23T00:00:00.000Z'))).toEqual([
      { id: userId },
    ]);
  });

  // Catches treating scheduled cancellation as immediate termination of a paid subscription.
  it('keeps a paid scheduled cancellation accessible after the cardless trial expires', async () => {
    const userId = await startDeferredTrial();
    stubSubscription(
      subscription({
        status: 'active',
        ended_at: null,
        cancel_at_period_end: true,
        cancel_at: REPORTED_PERIOD_END.getTime() / 1000,
      })
    );
    vi.setSystemTime(CANCELED_AT);
    await syncStripeCustomerSubscriptions(CUSTOMER_ID);

    const stored = await db.user.findUniqueOrThrow({ where: { id: userId } });
    const afterTrial = new Date('2026-10-09T00:00:00.000Z');
    expect(stored.subscriptionStatus).toBe('ACTIVE');
    expect(stored.stripeCancelAtPeriodEnd).toBe(true);
    expect(stored.billingAccessEndedAt).toBeNull();
    expect(stored.trialEndsAt).toEqual(TRIAL_END);
    expect(isPaidTier(stored, afterTrial)).toBe(true);
    expect(hasBillingAccess(stored, afterTrial)).toBe(true);
    expect(await matchingAccessUsers(userId, afterTrial)).toEqual([{ id: userId }]);
    expect(await matchingCleanupUsers(userId, new Date('2026-10-23T00:00:00.000Z'))).toEqual([]);
    expect(getStorageCleanupEligibleAt(stored)).toEqual(new Date('2026-11-16T00:00:00.000Z'));
  });
});
