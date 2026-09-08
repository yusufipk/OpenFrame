import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { Pool } from 'pg';
import {
  buildBillingAccessWhereInput,
  hasBillingAccess,
  syncStripeCustomerSubscriptions,
} from '@/lib/billing';
import { getStripe } from '@/lib/stripe';
import { db } from '../helpers/db';
import { createUser } from '../factories';

// Real PostgreSQL persistence and advisory locks; only Stripe responses are emulated.
// The held response models transport delay, not Stripe's actual webhook scheduling.
const CUSTOMER = 'cus_sync_concurrency';
const PRICE = 'price_sync_concurrency';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function subscription(
  status: 'active' | 'canceled',
  id = 'sub_paid',
  customer = CUSTOMER
): Stripe.Subscription {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    customer,
    status,
    created: now - 86_400,
    trial_end: null,
    cancel_at: null,
    cancel_at_period_end: false,
    ended_at: status === 'canceled' ? now - 60 : null,
    canceled_at: status === 'canceled' ? now - 60 : null,
    items: {
      data: [
        {
          price: { id: PRICE },
          current_period_start: now - 86_400,
          current_period_end: now + 30 * 86_400,
        },
      ],
    },
  } as Stripe.Subscription;
}

async function seed(status: 'ACTIVE' | 'CANCELED' = 'CANCELED', customer = CUSTOMER) {
  return createUser({
    stripeCustomerId: customer,
    stripeSubscriptionId: `sub_seed_${customer}`,
    stripePriceId: PRICE,
    subscriptionStatus: status,
    stripeCurrentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    trialEndsAt: null,
    billingTrialConsumedAt: new Date(Date.now() - 60 * 86_400_000),
    billingAccessEndedAt: status === 'CANCELED' ? new Date(Date.now() - 60_000) : null,
  });
}

function installStripe() {
  const list = vi.fn<
    (params: Stripe.SubscriptionListParams) => Promise<{
      data: Stripe.Subscription[];
      has_more: boolean;
    }>
  >();
  vi.mocked(getStripe).mockReturnValue({ subscriptions: { list } } as unknown as Stripe);
  return list;
}

async function waitForQueuedSync(customer = CUSTOMER) {
  // Observe a real waiter rather than sleeping and assuming the other request ran.
  // Replacing the database lock with a process-local mutex fails this assertion.
  await vi.waitFor(
    async () => {
      const rows = await db.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND classid = hashtext('stripe-subscription-sync')::oid
          AND objid = hashtext(${customer})::oid AND objsubid = 2
      ) AS waiting
    `;
      expect(rows).toEqual([{ waiting: true }]);
    },
    { timeout: 2_000, interval: 20 }
  );
}

async function assertAccess(userId: string, expected: boolean) {
  const stored = await db.user.findUniqueOrThrow({ where: { id: userId } });
  expect(hasBillingAccess(stored)).toBe(expected);
  expect(
    await db.user.findMany({
      where: { AND: [{ id: userId }, buildBillingAccessWhereInput()] },
      select: { id: true },
    })
  ).toEqual(expected ? [{ id: userId }] : []);
  return stored;
}

beforeEach(() => {
  vi.stubEnv('STRIPE_PRICE_ID', PRICE);
  vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
});

describe('customer-wide Stripe sync serialization', () => {
  it.each(['canceled-then-paid', 'paid-then-canceled', 'empty-then-paid'] as const)(
    'keeps the newer snapshot for overlapping %s reads',
    async (order) => {
      const paidFirst = order === 'paid-then-canceled';
      const user = await seed(paidFirst ? 'ACTIVE' : 'CANCELED');
      const stale =
        order === 'empty-then-paid'
          ? []
          : [subscription(paidFirst ? 'active' : 'canceled', paidFirst ? 'sub_paid' : 'sub_old')];
      const fresh = subscription(paidFirst ? 'canceled' : 'active');
      const list = installStripe();
      const entered = deferred();
      const release = deferred();
      list.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { data: stale, has_more: false };
      });
      list.mockImplementationOnce(async () => {
        // Reading Stripe for the next sync must wait for the previous mirror commit.
        const previous = await db.user.findUniqueOrThrow({ where: { id: user.id } });
        expect(previous.stripeSubscriptionId).toBe(stale[0]?.id ?? null);
        return { data: [fresh], has_more: false };
      });
      const first = syncStripeCustomerSubscriptions(CUSTOMER);
      let second: ReturnType<typeof syncStripeCustomerSubscriptions> | undefined;
      // Attach handlers immediately so assertion failures still drain both requests.
      void first.catch(() => {});
      try {
        await entered.promise;
        second = syncStripeCustomerSubscriptions(CUSTOMER);
        void second.catch(() => {});
        await waitForQueuedSync();
        expect(list).toHaveBeenCalledTimes(1);
        const unchanged = await db.user.findUniqueOrThrow({ where: { id: user.id } });
        expect(unchanged.stripeSubscriptionId).toBe(user.stripeSubscriptionId);
      } finally {
        release.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
      await expect(first).resolves.not.toBeNull();
      await expect(second!).resolves.not.toBeNull();
      expect(list).toHaveBeenCalledTimes(2);
      const stored = await assertAccess(user.id, !paidFirst);
      expect(stored.subscriptionStatus).toBe(paidFirst ? 'CANCELED' : 'ACTIVE');
      expect(stored.stripeSubscriptionId).toBe('sub_paid');
      expect(
        await db.analyticsEvent.findMany({
          where: { userId: user.id },
          select: { name: true },
        })
      ).toEqual([{ name: paidFirst ? 'SUBSCRIPTION_CANCELED' : 'SUBSCRIPTION_STARTED' }]);
    }
  );

  it('honors the customer lock held by an independent database connection before reading Stripe', async () => {
    const user = await seed();
    const list = installStripe().mockResolvedValue({
      data: [subscription('active')],
      has_more: false,
    });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const connection = await pool.connect();
    let pending: ReturnType<typeof syncStripeCustomerSubscriptions> | undefined;
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        'stripe-subscription-sync',
        CUSTOMER,
      ]);
      pending = syncStripeCustomerSubscriptions(CUSTOMER);
      void pending.catch(() => {});
      await waitForQueuedSync();
      expect(list).not.toHaveBeenCalled();
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await pool.end();
      if (pending) await Promise.allSettled([pending]);
    }
    await expect(pending!).resolves.not.toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
    await assertAccess(user.id, true);
  });

  it('lets a different customer sync while the first customer waits on Stripe', async () => {
    await seed();
    const otherCustomer = 'cus_sync_independent';
    const otherUser = await seed('CANCELED', otherCustomer);
    const entered = deferred();
    const release = deferred();
    const list = installStripe().mockImplementation(async ({ customer }) => {
      if (customer === CUSTOMER) {
        entered.resolve();
        await release.promise;
      }
      return { data: [subscription('active', `sub_${customer}`, customer)], has_more: false };
    });
    const first = syncStripeCustomerSubscriptions(CUSTOMER);
    void first.catch(() => {});
    let second: ReturnType<typeof syncStripeCustomerSubscriptions> | undefined;
    let secondFinished = false;
    try {
      await entered.promise;
      second = syncStripeCustomerSubscriptions(otherCustomer);
      void second.then(
        () => {
          secondFinished = true;
        },
        () => {
          secondFinished = true;
        }
      );
      await vi.waitFor(() => expect(secondFinished).toBe(true), { timeout: 2_000 });
      await expect(second).resolves.not.toBeNull();
      await assertAccess(otherUser.id, true);
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
    await expect(first).resolves.not.toBeNull();
  });

  it('releases a failed sync for its queued successor without changing the original mirror', async () => {
    const user = await seed();
    const entered = deferred();
    const release = deferred();
    const failure = new Error('Emulated Stripe read failure');
    const list = installStripe();
    list.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw failure;
    });
    list.mockImplementationOnce(async () => {
      expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toEqual(user);
      return { data: [subscription('active')], has_more: false };
    });
    const first = syncStripeCustomerSubscriptions(CUSTOMER);
    void first.catch(() => {});
    let second: ReturnType<typeof syncStripeCustomerSubscriptions> | undefined;
    try {
      await entered.promise;
      second = syncStripeCustomerSubscriptions(CUSTOMER);
      void second.catch(() => {});
      await waitForQueuedSync();
    } finally {
      release.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
    await expect(first).rejects.toBe(failure);
    await expect(second!).resolves.not.toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
    await assertAccess(user.id, true);
  });

  it('cannot overwrite a newer mirror when a Stripe response arrives after transaction expiry', async () => {
    const user = await seed();
    const entered = deferred();
    const release = deferred();
    const callbackFinished = deferred();
    const list = installStripe();
    list.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { data: [subscription('canceled', 'sub_stale')], has_more: false };
    });
    list.mockResolvedValueOnce({ data: [subscription('active', 'sub_new')], has_more: false });

    // Keep the real transaction and expiry machinery, shortening only the first
    // request's deadline. Its callback can outlive rollback while Stripe is held.
    const transact = db.$transaction.bind(db);
    const transaction = vi.spyOn(db, '$transaction').mockImplementationOnce((callback, options) =>
      transact(
        async (tx) => {
          try {
            return await callback(tx);
          } finally {
            callbackFinished.resolve();
          }
        },
        { ...options, timeout: 200 }
      )
    );
    const first = syncStripeCustomerSubscriptions(CUSTOMER);
    void first.catch(() => {});
    let second: ReturnType<typeof syncStripeCustomerSubscriptions> | undefined;
    let committed: Awaited<ReturnType<typeof assertAccess>> | undefined;
    try {
      await entered.promise;
      // Wait for PostgreSQL to release A's lock, not an assumed sleep duration.
      await vi.waitFor(
        async () => {
          const rows = await db.$queryRaw<{ held: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND granted
              AND classid = hashtext('stripe-subscription-sync')::oid
              AND objid = hashtext(${CUSTOMER})::oid AND objsubid = 2
          ) AS held
        `;
          expect(rows).toEqual([{ held: false }]);
        },
        { timeout: 3_000, interval: 20 }
      );
      second = syncStripeCustomerSubscriptions(CUSTOMER);
      void second.catch(() => {});
      await expect(second).resolves.not.toBeNull();
      committed = await assertAccess(user.id, true);
      expect(committed.stripeSubscriptionId).toBe('sub_new');
    } finally {
      release.resolve();
      // The outer promise may reject on expiry before its callback finishes.
      // Drain both so a late global-client write cannot escape the assertions.
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      await callbackFinished.promise;
      transaction.mockRestore();
    }
    await expect(first).rejects.toMatchObject({ code: 'P2028' });
    expect(list).toHaveBeenCalledTimes(2);
    expect(await assertAccess(user.id, true)).toEqual(committed);
  });
});
