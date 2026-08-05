import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { BillingSubscriptionStatus } from '@prisma/client';
import {
  DEFAULT_TRIAL_PERIOD_DAYS,
  buildBillingAccessWhereInput,
  buildExpiredBillingWhereInput,
  getBillingAccessEndDate,
  getBillingOverview,
  getBillingStatusLabel,
  getDefaultTrialEndsAt,
  getOrCreateStripeCustomerId,
  getStorageCleanupEligibleAt,
  getStripeCheckoutState,
  getWorkspaceCreationEligibility,
  hasActiveSubscription,
  hasActiveTrial,
  hasBillingAccess,
  hasRecoverableSubscription,
  isPaidTier,
  keepUnexpiredTrial,
  mapStripeSubscriptionStatus,
  markSubscriptionCanceledByCustomerId,
  selectAuthoritativeSubscription,
  startCardlessTrial,
  syncStripeCustomerSubscriptions,
  syncStripeSubscriptionToUser,
} from '@/lib/billing';

const dbMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  workspace: { count: vi.fn() },
  workspaceMember: { count: vi.fn() },
  projectMember: { count: vi.fn() },
  analyticsEvent: { createMany: vi.fn() },
}));

const stripeMock = vi.hoisted(() => ({
  customers: { create: vi.fn() },
  subscriptions: { list: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ db: dbMock, default: dbMock, disconnectDb: vi.fn() }));

// Only getStripe() is replaced. getStripePriceId() stays real so the entitlement
// checks still read STRIPE_PRICE_ID from the stubbed environment.
vi.mock('@/lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stripe')>();
  return { ...actual, getStripe: () => stripeMock };
});

const NOW = new Date('2026-01-15T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const ALL_STATUSES = [
  BillingSubscriptionStatus.FREE,
  BillingSubscriptionStatus.TRIALING,
  BillingSubscriptionStatus.ACTIVE,
  BillingSubscriptionStatus.PAST_DUE,
  BillingSubscriptionStatus.CANCELED,
  BillingSubscriptionStatus.UNPAID,
  BillingSubscriptionStatus.INCOMPLETE,
  BillingSubscriptionStatus.INCOMPLETE_EXPIRED,
] as const;

type Subject = Parameters<typeof hasBillingAccess>[0];

function subject(overrides: Partial<Subject> = {}): Subject {
  return {
    subscriptionStatus: BillingSubscriptionStatus.FREE,
    trialEndsAt: null,
    stripeCurrentPeriodEnd: null,
    billingAccessEndedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getDefaultTrialEndsAt', () => {
  it('adds exactly seven days to the given start date', () => {
    expect(getDefaultTrialEndsAt(NOW).toISOString()).toBe('2026-01-22T00:00:00.000Z');
  });

  it('spans a month boundary without shifting the time of day', () => {
    const end = getDefaultTrialEndsAt(new Date('2026-01-28T13:45:12.500Z'));
    expect(end.toISOString()).toBe('2026-02-04T13:45:12.500Z');
  });

  it('exposes the trial length that the offset is built from', () => {
    const from = new Date('2026-03-01T00:00:00.000Z');
    const elapsedDays = (getDefaultTrialEndsAt(from).getTime() - from.getTime()) / DAY_MS;
    expect(elapsedDays).toBe(DEFAULT_TRIAL_PERIOD_DAYS);
  });
});

describe('hasActiveTrial', () => {
  it('returns true one millisecond before the trial end', () => {
    expect(hasActiveTrial(new Date(NOW.getTime() + 1), NOW)).toBe(true);
  });

  it('returns false at the exact trial end instant', () => {
    expect(hasActiveTrial(new Date(NOW.getTime()), NOW)).toBe(false);
  });

  it('returns false one millisecond after the trial end', () => {
    expect(hasActiveTrial(new Date(NOW.getTime() - 1), NOW)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('returns false for %s', (_label, value) => {
    expect(hasActiveTrial(value, NOW)).toBe(false);
  });
});

describe('keepUnexpiredTrial', () => {
  it('keeps a trial that has not run out', () => {
    const future = new Date(NOW.getTime() + DAY_MS);

    expect(keepUnexpiredTrial(future, NOW)).toBe(future);
  });

  it('drops a trial that has already run out', () => {
    expect(keepUnexpiredTrial(new Date(NOW.getTime() - 1), NOW)).toBeNull();
  });

  it('drops a trial that ends exactly now', () => {
    expect(keepUnexpiredTrial(new Date(NOW.getTime()), NOW)).toBeNull();
  });

  it('returns null rather than undefined when there is no trial', () => {
    expect(keepUnexpiredTrial(null, NOW)).toBeNull();
    expect(keepUnexpiredTrial(undefined, NOW)).toBeNull();
  });
});

describe('isPaidTier', () => {
  it('counts an active subscription as paid', () => {
    expect(
      isPaidTier(
        { subscriptionStatus: BillingSubscriptionStatus.ACTIVE, stripeCurrentPeriodEnd: null },
        NOW
      )
    ).toBe(true);
  });

  // A Stripe trial was card-backed, so it is a customer in waiting rather than
  // an unpaid account, and it keeps the full plan ceilings.
  it('counts a Stripe trial as paid', () => {
    expect(
      isPaidTier(
        { subscriptionStatus: BillingSubscriptionStatus.TRIALING, stripeCurrentPeriodEnd: null },
        NOW
      )
    ).toBe(true);
  });

  it('counts a lapsed status inside a paid period as paid', () => {
    expect(
      isPaidTier(
        {
          subscriptionStatus: BillingSubscriptionStatus.CANCELED,
          stripeCurrentPeriodEnd: new Date(NOW.getTime() + DAY_MS),
        },
        NOW
      )
    ).toBe(true);
  });

  // The whole point of the split: this account has access and no card behind it.
  it('does not count a cardless trial as paid', () => {
    expect(
      isPaidTier(
        { subscriptionStatus: BillingSubscriptionStatus.FREE, stripeCurrentPeriodEnd: null },
        NOW
      )
    ).toBe(false);
  });

  it('does not count an expired paid period as paid', () => {
    expect(
      isPaidTier(
        {
          subscriptionStatus: BillingSubscriptionStatus.CANCELED,
          stripeCurrentPeriodEnd: new Date(NOW.getTime() - DAY_MS),
        },
        NOW
      )
    ).toBe(false);
  });

  it('treats everyone as paid when billing is switched off entirely', () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');

    expect(
      isPaidTier(
        { subscriptionStatus: BillingSubscriptionStatus.FREE, stripeCurrentPeriodEnd: null },
        NOW
      )
    ).toBe(true);
  });
});

describe('hasActiveSubscription', () => {
  const expected: Record<BillingSubscriptionStatus, boolean> = {
    FREE: false,
    TRIALING: true,
    ACTIVE: true,
    PAST_DUE: false,
    CANCELED: false,
    UNPAID: false,
    INCOMPLETE: false,
    INCOMPLETE_EXPIRED: false,
  };

  it.each(ALL_STATUSES)('returns %s for status %s', (status) => {
    expect(hasActiveSubscription(status)).toBe(expected[status]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('returns false for %s', (_label, value) => {
    expect(hasActiveSubscription(value)).toBe(false);
  });
});

describe('hasRecoverableSubscription', () => {
  const expected: Record<BillingSubscriptionStatus, boolean> = {
    FREE: false,
    TRIALING: true,
    ACTIVE: true,
    PAST_DUE: true,
    CANCELED: false,
    UNPAID: true,
    INCOMPLETE: true,
    INCOMPLETE_EXPIRED: false,
  };

  it.each(ALL_STATUSES)('classifies status %s', (status) => {
    expect(hasRecoverableSubscription(status)).toBe(expected[status]);
  });

  it('returns false for a missing status', () => {
    expect(hasRecoverableSubscription(null)).toBe(false);
  });
});

describe('hasBillingAccess', () => {
  it('grants access on an ACTIVE subscription with no dates at all', () => {
    expect(hasBillingAccess(subject({ subscriptionStatus: 'ACTIVE' }), NOW)).toBe(true);
  });

  it('grants access on a TRIALING subscription with no dates at all', () => {
    expect(hasBillingAccess(subject({ subscriptionStatus: 'TRIALING' }), NOW)).toBe(true);
  });

  it('grants access to a PAST_DUE customer whose trial has not ended yet', () => {
    const result = hasBillingAccess(
      subject({
        subscriptionStatus: 'PAST_DUE',
        trialEndsAt: new Date(NOW.getTime() + DAY_MS),
      }),
      NOW
    );
    expect(result).toBe(true);
  });

  it('grants access to a PAST_DUE customer whose paid period has not ended yet', () => {
    const result = hasBillingAccess(
      subject({
        subscriptionStatus: 'PAST_DUE',
        trialEndsAt: new Date(NOW.getTime() - DAY_MS),
        stripeCurrentPeriodEnd: new Date(NOW.getTime() + DAY_MS),
      }),
      NOW
    );
    expect(result).toBe(true);
  });

  it('denies access to a PAST_DUE customer whose trial and paid period have both ended', () => {
    const result = hasBillingAccess(
      subject({
        subscriptionStatus: 'PAST_DUE',
        trialEndsAt: new Date(NOW.getTime() - DAY_MS),
        stripeCurrentPeriodEnd: new Date(NOW.getTime() - DAY_MS),
      }),
      NOW
    );
    expect(result).toBe(false);
  });

  it('denies access to a CANCELED customer with no dates', () => {
    expect(hasBillingAccess(subject({ subscriptionStatus: 'CANCELED' }), NOW)).toBe(false);
  });

  it('denies access when the trial ends at exactly the current instant', () => {
    expect(hasBillingAccess(subject({ trialEndsAt: new Date(NOW.getTime()) }), NOW)).toBe(false);
  });

  it('denies access when the paid period ends at exactly the current instant', () => {
    expect(
      hasBillingAccess(subject({ stripeCurrentPeriodEnd: new Date(NOW.getTime()) }), NOW)
    ).toBe(false);
  });

  it('grants access when the paid period ends one millisecond from now', () => {
    expect(
      hasBillingAccess(subject({ stripeCurrentPeriodEnd: new Date(NOW.getTime() + 1) }), NOW)
    ).toBe(true);
  });

  it('ignores billingAccessEndedAt while the paid period is still running', () => {
    const result = hasBillingAccess(
      subject({
        subscriptionStatus: 'CANCELED',
        stripeCurrentPeriodEnd: new Date(NOW.getTime() + DAY_MS),
        billingAccessEndedAt: new Date(NOW.getTime() - DAY_MS),
      }),
      NOW
    );
    expect(result).toBe(true);
  });

  it('grants access to everyone when Stripe is disabled', () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');
    const result = hasBillingAccess(
      subject({
        subscriptionStatus: 'INCOMPLETE_EXPIRED',
        trialEndsAt: new Date('2020-01-01T00:00:00Z'),
        stripeCurrentPeriodEnd: new Date('2020-01-08T00:00:00Z'),
      }),
      NOW
    );
    expect(result).toBe(true);
  });
});

describe('getBillingAccessEndDate', () => {
  it('prefers billingAccessEndedAt over every other date', () => {
    const ended = new Date('2026-01-10T00:00:00Z');
    const result = getBillingAccessEndDate(
      subject({
        billingAccessEndedAt: ended,
        stripeCurrentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
        trialEndsAt: new Date('2026-03-01T00:00:00Z'),
      })
    );
    expect(result).toBe(ended);
  });

  it('falls back to stripeCurrentPeriodEnd when billing has not been marked ended', () => {
    const periodEnd = new Date('2026-02-01T00:00:00Z');
    const result = getBillingAccessEndDate(
      subject({
        stripeCurrentPeriodEnd: periodEnd,
        trialEndsAt: new Date('2026-03-01T00:00:00Z'),
      })
    );
    expect(result).toBe(periodEnd);
  });

  it('falls back to trialEndsAt when there is no paid period', () => {
    const trialEnd = new Date('2026-03-01T00:00:00Z');
    expect(getBillingAccessEndDate(subject({ trialEndsAt: trialEnd }))).toBe(trialEnd);
  });

  it('returns null when the subject has no billing dates', () => {
    expect(getBillingAccessEndDate(subject())).toBeNull();
  });
});

describe('getStorageCleanupEligibleAt', () => {
  it('adds a fifteen day grace period to the access end date', () => {
    const result = getStorageCleanupEligibleAt(
      subject({ billingAccessEndedAt: new Date('2026-01-15T00:00:00.000Z') })
    );
    expect(result?.toISOString()).toBe('2026-01-30T00:00:00.000Z');
  });

  it('measures the grace period from the trial end when no other date exists', () => {
    const result = getStorageCleanupEligibleAt(
      subject({ trialEndsAt: new Date('2026-01-01T06:30:00.000Z') })
    );
    expect(result?.toISOString()).toBe('2026-01-16T06:30:00.000Z');
  });

  it('returns null when there is no access end date to count from', () => {
    expect(getStorageCleanupEligibleAt(subject())).toBeNull();
  });
});

describe('buildBillingAccessWhereInput', () => {
  it('matches active or trialing subscriptions or an unexpired date', () => {
    expect(buildBillingAccessWhereInput(NOW)).toEqual({
      OR: [
        { subscriptionStatus: { in: ['ACTIVE', 'TRIALING'] } },
        { trialEndsAt: { gt: NOW } },
        { stripeCurrentPeriodEnd: { gt: NOW } },
      ],
    });
  });

  it('uses a strict greater-than so a boundary date does not grant access', () => {
    const where = buildBillingAccessWhereInput(NOW) as {
      OR: Array<{ trialEndsAt?: { gt?: Date; gte?: Date } }>;
    };
    expect(where.OR[1].trialEndsAt).not.toHaveProperty('gte');
    expect(where.OR[1].trialEndsAt?.gt).toEqual(NOW);
  });

  it('matches every user when Stripe is disabled', () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');
    expect(buildBillingAccessWhereInput(NOW)).toEqual({});
  });
});

describe('buildExpiredBillingWhereInput', () => {
  it('states the lack of access positively and requires the fifteen day grace to have elapsed', () => {
    const cutoff = new Date('2025-12-31T00:00:00.000Z');

    expect(buildExpiredBillingWhereInput(NOW)).toEqual({
      AND: [
        { subscriptionStatus: { notIn: ['ACTIVE', 'TRIALING'] } },
        { OR: [{ trialEndsAt: null }, { trialEndsAt: { lte: NOW } }] },
        { OR: [{ stripeCurrentPeriodEnd: null }, { stripeCurrentPeriodEnd: { lte: NOW } }] },
        {
          OR: [
            { billingAccessEndedAt: { lte: cutoff } },
            { AND: [{ billingAccessEndedAt: null }, { trialEndsAt: { lte: cutoff } }] },
          ],
        },
      ],
    });
  });

  // The NOT form this replaced could not express "no access" for a row whose date columns are
  // empty, because SQL turns a comparison against NULL into unknown rather than false. Every
  // branch has to name NULL explicitly instead. tests/api/expired-billing-cleanup.test.ts
  // proves it against a real database; this only guards the shape.
  it('admits a null trial and a null period end as expired rather than skipping the row', () => {
    const where = buildExpiredBillingWhereInput(NOW) as {
      AND: Array<{ OR?: Array<Record<string, unknown>> }>;
    };
    expect(where.AND[1].OR).toContainEqual({ trialEndsAt: null });
    expect(where.AND[2].OR).toContainEqual({ stripeCurrentPeriodEnd: null });
  });

  it('matches nobody when Stripe is disabled, because nothing can expire without billing', () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');
    expect(buildExpiredBillingWhereInput(NOW)).toEqual({ id: { in: [] } });
  });
});

describe('mapStripeSubscriptionStatus', () => {
  const mapping: Array<[Stripe.Subscription.Status, BillingSubscriptionStatus]> = [
    ['trialing', BillingSubscriptionStatus.TRIALING],
    ['active', BillingSubscriptionStatus.ACTIVE],
    ['past_due', BillingSubscriptionStatus.PAST_DUE],
    ['canceled', BillingSubscriptionStatus.CANCELED],
    ['unpaid', BillingSubscriptionStatus.UNPAID],
    ['incomplete', BillingSubscriptionStatus.INCOMPLETE],
    ['incomplete_expired', BillingSubscriptionStatus.INCOMPLETE_EXPIRED],
  ];

  it.each(mapping)('maps the Stripe status %s', (stripeStatus, expected) => {
    expect(mapStripeSubscriptionStatus(stripeStatus)).toBe(expected);
  });

  it('maps the paused status to FREE because it has no Prisma counterpart', () => {
    expect(mapStripeSubscriptionStatus('paused')).toBe(BillingSubscriptionStatus.FREE);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('maps %s to FREE', (_label, value) => {
    expect(mapStripeSubscriptionStatus(value)).toBe(BillingSubscriptionStatus.FREE);
  });
});

describe('getBillingStatusLabel', () => {
  const labels: Record<BillingSubscriptionStatus, string> = {
    TRIALING: 'Trialing',
    ACTIVE: 'Active',
    PAST_DUE: 'Past due',
    CANCELED: 'Canceled',
    UNPAID: 'Unpaid',
    INCOMPLETE: 'Incomplete',
    INCOMPLETE_EXPIRED: 'Expired',
    FREE: 'Free',
  };

  it.each(ALL_STATUSES)('labels status %s', (status) => {
    expect(getBillingStatusLabel(status)).toBe(labels[status]);
  });
});

describe('selectAuthoritativeSubscription', () => {
  const ENTITLED_PRICE = 'price_entitled';

  function sub(options: {
    id: string;
    status: Stripe.Subscription.Status;
    priceIds: string[];
    created: number;
  }): Stripe.Subscription {
    return {
      id: options.id,
      status: options.status,
      created: options.created,
      items: { data: options.priceIds.map((id) => ({ price: { id } })) },
    } as unknown as Stripe.Subscription;
  }

  beforeEach(() => {
    vi.stubEnv('STRIPE_PRICE_ID', ENTITLED_PRICE);
  });

  it('returns null for an empty list', () => {
    expect(selectAuthoritativeSubscription([])).toBeNull();
  });

  it('returns the only subscription even when it carries an unrelated price', () => {
    const only = sub({ id: 'sub_only', status: 'canceled', priceIds: ['price_other'], created: 1 });
    expect(selectAuthoritativeSubscription([only])?.id).toBe('sub_only');
  });

  it('prefers the entitled price over a livelier status on an unrelated price', () => {
    const entitledButCanceled = sub({
      id: 'sub_entitled',
      status: 'canceled',
      priceIds: [ENTITLED_PRICE],
      created: 100,
    });
    const activeUnrelated = sub({
      id: 'sub_unrelated',
      status: 'active',
      priceIds: ['price_other'],
      created: 200,
    });

    expect(selectAuthoritativeSubscription([activeUnrelated, entitledButCanceled])?.id).toBe(
      'sub_entitled'
    );
  });

  it('prefers the livelier status when both subscriptions carry the entitled price', () => {
    const pastDue = sub({
      id: 'sub_past_due',
      status: 'past_due',
      priceIds: [ENTITLED_PRICE],
      created: 300,
    });
    const active = sub({
      id: 'sub_active',
      status: 'active',
      priceIds: [ENTITLED_PRICE],
      created: 100,
    });

    expect(selectAuthoritativeSubscription([pastDue, active])?.id).toBe('sub_active');
  });

  it('ranks trialing above past_due and past_due above canceled', () => {
    const canceled = sub({
      id: 'sub_canceled',
      status: 'canceled',
      priceIds: [ENTITLED_PRICE],
      created: 500,
    });
    const pastDue = sub({
      id: 'sub_past_due',
      status: 'past_due',
      priceIds: [ENTITLED_PRICE],
      created: 400,
    });
    const trialing = sub({
      id: 'sub_trialing',
      status: 'trialing',
      priceIds: [ENTITLED_PRICE],
      created: 300,
    });

    expect(selectAuthoritativeSubscription([canceled, pastDue, trialing])?.id).toBe('sub_trialing');
    expect(selectAuthoritativeSubscription([canceled, pastDue])?.id).toBe('sub_past_due');
  });

  it('breaks a status tie with the most recently created subscription', () => {
    const older = sub({
      id: 'sub_older',
      status: 'active',
      priceIds: [ENTITLED_PRICE],
      created: 100,
    });
    const newer = sub({
      id: 'sub_newer',
      status: 'active',
      priceIds: [ENTITLED_PRICE],
      created: 999,
    });

    expect(selectAuthoritativeSubscription([older, newer])?.id).toBe('sub_newer');
    expect(selectAuthoritativeSubscription([newer, older])?.id).toBe('sub_newer');
  });

  it('matches the entitled price on any item of a multi-item subscription', () => {
    const multiItem = sub({
      id: 'sub_multi',
      status: 'canceled',
      priceIds: ['price_addon', ENTITLED_PRICE],
      created: 10,
    });
    const unrelated = sub({
      id: 'sub_unrelated',
      status: 'active',
      priceIds: ['price_other'],
      created: 20,
    });

    expect(selectAuthoritativeSubscription([unrelated, multiItem])?.id).toBe('sub_multi');
  });

  it('does not mutate the array it was given', () => {
    const first = sub({ id: 'a', status: 'canceled', priceIds: ['x'], created: 1 });
    const second = sub({ id: 'b', status: 'active', priceIds: [ENTITLED_PRICE], created: 2 });
    const input = [first, second];

    selectAuthoritativeSubscription(input);

    expect(input.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('throws when STRIPE_PRICE_ID is unset and more than one subscription must be compared', () => {
    vi.stubEnv('STRIPE_PRICE_ID', '');
    const a = sub({ id: 'a', status: 'active', priceIds: ['x'], created: 1 });
    const b = sub({ id: 'b', status: 'active', priceIds: ['y'], created: 2 });

    expect(() => selectAuthoritativeSubscription([a, b])).toThrow(
      'STRIPE_PRICE_ID is not configured'
    );
  });
});

// ---------------------------------------------------------------------------
// Database and Stripe backed helpers. The Prisma client and getStripe() are
// mocked, so these still assert branching logic rather than persistence.
// ---------------------------------------------------------------------------

const ENTITLED_PRICE = 'price_entitled';

function stripeSub(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    created: 1_700_000_000,
    current_period_end: Math.floor(NOW.getTime() / 1000) + 30 * 86_400,
    cancel_at: null,
    cancel_at_period_end: false,
    trial_end: null,
    items: { data: [{ price: { id: ENTITLED_PRICE } }] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function updateData(): Record<string, unknown> {
  return dbMock.user.update.mock.calls[0][0].data as Record<string, unknown>;
}

describe('database backed billing helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
    vi.stubEnv('STRIPE_PRICE_ID', ENTITLED_PRICE);
    dbMock.user.findUnique.mockReset();
    dbMock.user.update.mockReset();
    dbMock.user.updateMany.mockReset();
    dbMock.analyticsEvent.createMany.mockReset();
    dbMock.workspace.count.mockReset();
    dbMock.workspaceMember.count.mockReset();
    dbMock.projectMember.count.mockReset();
    stripeMock.customers.create.mockReset();
    stripeMock.subscriptions.list.mockReset();
    dbMock.user.update.mockImplementation(async (args: { data: unknown }) => args.data);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getStripeCheckoutState', () => {
    it('throws when the user does not exist', async () => {
      dbMock.user.findUnique.mockResolvedValue(null);

      await expect(getStripeCheckoutState('u1')).rejects.toThrow('User u1 not found');
    });

    it('reports an active subscriber as active and recoverable', async () => {
      dbMock.user.findUnique.mockResolvedValue({
        subscriptionStatus: BillingSubscriptionStatus.ACTIVE,
      });

      await expect(getStripeCheckoutState('u1')).resolves.toEqual({
        hasActiveSubscription: true,
        hasRecoverableSubscription: true,
      });
    });

    it('reports a past_due subscriber as recoverable but not active', async () => {
      dbMock.user.findUnique.mockResolvedValue({
        subscriptionStatus: BillingSubscriptionStatus.PAST_DUE,
      });

      await expect(getStripeCheckoutState('u1')).resolves.toEqual({
        hasActiveSubscription: false,
        hasRecoverableSubscription: true,
      });
    });

    it('reports a canceled subscriber as neither active nor recoverable', async () => {
      dbMock.user.findUnique.mockResolvedValue({
        subscriptionStatus: BillingSubscriptionStatus.CANCELED,
      });

      const state = await getStripeCheckoutState('u1');

      expect(state.hasActiveSubscription).toBe(false);
      expect(state.hasRecoverableSubscription).toBe(false);
    });
  });

  describe('startCardlessTrial', () => {
    it('dates the trial from now and marks it consumed in the same write', async () => {
      dbMock.user.updateMany.mockResolvedValue({ count: 1 });

      await expect(startCardlessTrial('u1')).resolves.toBe(true);

      const call = dbMock.user.updateMany.mock.calls[0][0];
      expect(call.data.trialEndsAt.getTime()).toBe(
        NOW.getTime() + DEFAULT_TRIAL_PERIOD_DAYS * DAY_MS
      );
      expect(call.data.billingTrialConsumedAt.getTime()).toBe(NOW.getTime());
    });

    // The guard is the whole once-per-account rule. Without it a re-issued
    // verification link, or a second one opened on a phone, extends the trial.
    it('only writes to an account that has never had a trial', async () => {
      dbMock.user.updateMany.mockResolvedValue({ count: 1 });

      await startCardlessTrial('u1');

      expect(dbMock.user.updateMany.mock.calls[0][0].where).toEqual({
        id: 'u1',
        trialEndsAt: null,
        billingTrialConsumedAt: null,
      });
    });

    it('reports no trial and records nothing when the guard matched no rows', async () => {
      vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
      dbMock.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(startCardlessTrial('u1')).resolves.toBe(false);
      expect(dbMock.analyticsEvent.createMany).not.toHaveBeenCalled();
    });

    it('records the trial once, keyed on the account', async () => {
      vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
      dbMock.user.updateMany.mockResolvedValue({ count: 1 });

      await startCardlessTrial('u1');

      expect(dbMock.analyticsEvent.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ name: 'TRIAL_STARTED', dedupeKey: 'TRIAL_STARTED:u1' })],
        })
      );
    });

    // Nothing is gated without billing, so a trial date would be noise. Worse, it
    // would consume the trial of an instance that switches billing on later.
    it('grants nothing when billing is switched off entirely', async () => {
      vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');

      await expect(startCardlessTrial('u1')).resolves.toBe(false);
      expect(dbMock.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('getWorkspaceCreationEligibility', () => {
    function mockEligibility(options: {
      user?: Record<string, unknown> | null;
      owned?: number;
      invited?: number;
      projectOnly?: number;
    }) {
      dbMock.user.findUnique.mockResolvedValue(
        options.user === undefined
          ? {
              subscriptionStatus: BillingSubscriptionStatus.FREE,
              trialEndsAt: null,
              billingTrialConsumedAt: null,
              stripeCustomerId: null,
              stripeSubscriptionId: null,
              stripePriceId: null,
              stripeCurrentPeriodEnd: null,
              stripeCancelAtPeriodEnd: null,
              stripeCancelAt: null,
              billingAccessEndedAt: null,
            }
          : options.user
      );
      dbMock.workspace.count.mockResolvedValue(options.owned ?? 0);
      dbMock.workspaceMember.count.mockResolvedValue(options.invited ?? 0);
      dbMock.projectMember.count.mockResolvedValue(options.projectOnly ?? 0);
    }

    it('throws when the user does not exist', async () => {
      mockEligibility({ user: null });

      await expect(getWorkspaceCreationEligibility('u1')).rejects.toThrow('User u1 not found');
    });

    it('lets an account on a cardless trial create its first workspace', async () => {
      mockEligibility({
        user: {
          subscriptionStatus: BillingSubscriptionStatus.FREE,
          trialEndsAt: new Date(NOW.getTime() + 5 * DAY_MS),
          billingTrialConsumedAt: NOW,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          stripePriceId: null,
          stripeCurrentPeriodEnd: null,
          stripeCancelAtPeriodEnd: null,
          stripeCancelAt: null,
          billingAccessEndedAt: null,
        },
        owned: 0,
      });

      const result = await getWorkspaceCreationEligibility('u1');

      expect(result.canCreateWorkspace).toBe(true);
      expect(result.subscription.isPaid).toBe(false);
    });

    // The trial ceiling. Access alone used to be enough for any number of these.
    it('refuses a second workspace on a cardless trial', async () => {
      mockEligibility({
        user: {
          subscriptionStatus: BillingSubscriptionStatus.FREE,
          trialEndsAt: new Date(NOW.getTime() + 5 * DAY_MS),
          billingTrialConsumedAt: NOW,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          stripePriceId: null,
          stripeCurrentPeriodEnd: null,
          stripeCancelAtPeriodEnd: null,
          stripeCancelAt: null,
          billingAccessEndedAt: null,
        },
        owned: 1,
      });

      const result = await getWorkspaceCreationEligibility('u1');

      expect(result.canCreateWorkspace).toBe(false);
      expect(result.reason).toBe(
        'Your free trial includes one workspace. Subscribe to create more.'
      );
    });

    it('allows creation while billing access holds, whatever the counts are', async () => {
      mockEligibility({
        user: {
          subscriptionStatus: BillingSubscriptionStatus.ACTIVE,
          trialEndsAt: null,
          billingTrialConsumedAt: new Date('2025-01-01T00:00:00Z'),
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
          stripePriceId: ENTITLED_PRICE,
          stripeCurrentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
          stripeCancelAtPeriodEnd: false,
          stripeCancelAt: null,
          billingAccessEndedAt: null,
        },
        owned: 5,
        invited: 3,
      });

      const result = await getWorkspaceCreationEligibility('u1');

      expect(result.canCreateWorkspace).toBe(true);
      expect(result.reason).toBeNull();
      expect(result.subscription.label).toBe('Active');
      expect(result.subscription.hasBillingAccess).toBe(true);
    });

    it('allows a brand new user with no workspaces and no collaborations', async () => {
      mockEligibility({});

      const result = await getWorkspaceCreationEligibility('u1');

      expect(result.canCreateWorkspace).toBe(true);
      expect(result.reason).toBeNull();
    });

    it('blocks an expired owner who already has a workspace', async () => {
      mockEligibility({ owned: 1 });

      const result = await getWorkspaceCreationEligibility('u1');

      expect(result.canCreateWorkspace).toBe(false);
      expect(result.reason).toContain('Your trial has ended');
    });

    it('blocks an expired user who only collaborates in someone else workspace', async () => {
      mockEligibility({ owned: 0, invited: 1 });

      const result = await getWorkspaceCreationEligibility('u1');

      expect(result.canCreateWorkspace).toBe(false);
      expect(result.reason).toContain('currently collaborating');
    });

    it('counts project-only collaboration towards the same block', async () => {
      mockEligibility({ owned: 0, projectOnly: 2 });

      const result = await getWorkspaceCreationEligibility('u1');

      expect(result.canCreateWorkspace).toBe(false);
      expect(result.reason).toContain('currently collaborating');
      expect(result.projectOnlyCollaborationCount).toBe(2);
    });

    it('prefers the trial-ended reason when the user both owns and collaborates', async () => {
      mockEligibility({ owned: 1, invited: 1 });

      expect((await getWorkspaceCreationEligibility('u1')).reason).toContain(
        'Your trial has ended'
      );
    });

    it('always allows creation when Stripe is disabled', async () => {
      vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');
      mockEligibility({ owned: 9, invited: 9 });

      const result = await getWorkspaceCreationEligibility('u1');

      expect(result.canCreateWorkspace).toBe(true);
      expect(result.reason).toBeNull();
    });

    it('derives the storage cleanup date from the billing end date', async () => {
      mockEligibility({
        user: {
          subscriptionStatus: BillingSubscriptionStatus.CANCELED,
          trialEndsAt: null,
          billingTrialConsumedAt: new Date('2025-01-01T00:00:00Z'),
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: null,
          stripePriceId: null,
          stripeCurrentPeriodEnd: null,
          stripeCancelAtPeriodEnd: false,
          stripeCancelAt: null,
          billingAccessEndedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      });

      const result = await getWorkspaceCreationEligibility('u1');

      expect(result.subscription.storageCleanupEligibleAt?.toISOString()).toBe(
        '2026-01-16T00:00:00.000Z'
      );
    });
  });

  describe('getBillingOverview', () => {
    it('reshapes the eligibility result into workspaceCreation and subscription blocks', async () => {
      dbMock.user.findUnique.mockResolvedValue({
        subscriptionStatus: BillingSubscriptionStatus.TRIALING,
        trialEndsAt: new Date('2099-01-01T00:00:00Z'),
        billingTrialConsumedAt: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripePriceId: null,
        stripeCurrentPeriodEnd: null,
        stripeCancelAtPeriodEnd: null,
        stripeCancelAt: null,
        billingAccessEndedAt: null,
      });
      dbMock.workspace.count.mockResolvedValue(2);
      dbMock.workspaceMember.count.mockResolvedValue(1);
      dbMock.projectMember.count.mockResolvedValue(4);

      const overview = await getBillingOverview('u1');

      expect(overview.workspaceCreation).toEqual({
        canCreateWorkspace: true,
        reason: null,
        ownedWorkspaceCount: 2,
        invitedWorkspaceCount: 1,
      });
      expect(overview.subscription.label).toBe('Trialing');
      // projectOnlyCollaborationCount is deliberately not surfaced here.
      expect(overview.workspaceCreation).not.toHaveProperty('projectOnlyCollaborationCount');
    });
  });

  describe('getOrCreateStripeCustomerId', () => {
    it('throws when the user does not exist', async () => {
      dbMock.user.findUnique.mockResolvedValue(null);

      await expect(getOrCreateStripeCustomerId('u1')).rejects.toThrow('User u1 not found');
    });

    it('returns the stored customer id without calling Stripe', async () => {
      dbMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'a@example.com',
        name: 'A',
        stripeCustomerId: 'cus_existing',
      });

      await expect(getOrCreateStripeCustomerId('u1')).resolves.toBe('cus_existing');
      expect(stripeMock.customers.create).not.toHaveBeenCalled();
      expect(dbMock.user.update).not.toHaveBeenCalled();
    });

    it('creates the customer with the user metadata and persists the new id', async () => {
      dbMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'a@example.com',
        name: 'A',
        stripeCustomerId: null,
      });
      stripeMock.customers.create.mockResolvedValue({ id: 'cus_new' });

      await expect(getOrCreateStripeCustomerId('u1')).resolves.toBe('cus_new');
      expect(stripeMock.customers.create).toHaveBeenCalledWith({
        email: 'a@example.com',
        name: 'A',
        metadata: { userId: 'u1' },
      });
      expect(dbMock.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { stripeCustomerId: 'cus_new' },
      });
    });

    it('sends undefined rather than null for a missing email or name', async () => {
      dbMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: null,
        name: null,
        stripeCustomerId: null,
      });
      stripeMock.customers.create.mockResolvedValue({ id: 'cus_new' });

      await getOrCreateStripeCustomerId('u1');

      expect(stripeMock.customers.create).toHaveBeenCalledWith({
        email: undefined,
        name: undefined,
        metadata: { userId: 'u1' },
      });
    });
  });

  describe('syncStripeSubscriptionToUser', () => {
    it('returns null when no user owns the Stripe customer', async () => {
      dbMock.user.findUnique.mockResolvedValue(null);

      await expect(syncStripeSubscriptionToUser(stripeSub())).resolves.toBeNull();
      expect(dbMock.user.update).not.toHaveBeenCalled();
    });

    it('accepts an expanded customer object as well as a customer id', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: null });

      await syncStripeSubscriptionToUser(stripeSub({ customer: { id: 'cus_expanded' } }));

      expect(dbMock.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { stripeCustomerId: 'cus_expanded' } })
      );
    });

    it('writes the mapped status and dates for an entitled active subscription', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: null });
      const periodEnd = Math.floor(NOW.getTime() / 1000) + 30 * 86_400;

      await syncStripeSubscriptionToUser(
        stripeSub({ status: 'active', current_period_end: periodEnd })
      );

      expect(updateData()).toMatchObject({
        stripeSubscriptionId: 'sub_1',
        stripePriceId: ENTITLED_PRICE,
        subscriptionStatus: BillingSubscriptionStatus.ACTIVE,
        stripeCancelAtPeriodEnd: false,
        stripeCancelAt: null,
        trialEndsAt: null,
        billingAccessEndedAt: null,
      });
      expect((updateData().stripeCurrentPeriodEnd as Date).getTime()).toBe(periodEnd * 1000);
    });

    it('downgrades a subscription that does not carry the entitled price to FREE', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: null });

      await syncStripeSubscriptionToUser(
        stripeSub({
          status: 'active',
          items: { data: [{ price: { id: 'price_unrelated' } }] },
        })
      );

      expect(updateData()).toMatchObject({
        subscriptionStatus: BillingSubscriptionStatus.FREE,
        stripePriceId: 'price_unrelated',
        stripeCurrentPeriodEnd: null,
        trialEndsAt: null,
      });
      expect(updateData().billingAccessEndedAt).toBeInstanceOf(Date);
    });

    it('keeps access while a canceled subscription is still inside its paid period', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: null });

      await syncStripeSubscriptionToUser(
        stripeSub({
          status: 'canceled',
          current_period_end: Math.floor(NOW.getTime() / 1000) + 3600,
        })
      );

      expect(updateData()).toMatchObject({
        subscriptionStatus: BillingSubscriptionStatus.CANCELED,
        billingAccessEndedAt: null,
      });
    });

    it('ends access at the period end once the paid period has passed', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: null });
      const periodEnd = Math.floor(NOW.getTime() / 1000) - 3600;

      await syncStripeSubscriptionToUser(
        stripeSub({ status: 'canceled', current_period_end: periodEnd })
      );

      expect((updateData().billingAccessEndedAt as Date).getTime()).toBe(periodEnd * 1000);
    });

    it('falls back to ended_at when there is no period end', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: null });
      const endedAt = Math.floor(NOW.getTime() / 1000) - 7200;

      await syncStripeSubscriptionToUser(
        stripeSub({ status: 'canceled', current_period_end: null, ended_at: endedAt })
      );

      expect((updateData().billingAccessEndedAt as Date).getTime()).toBe(endedAt * 1000);
    });

    it('falls back to canceled_at when there is neither a period end nor an ended_at', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: null });
      const canceledAt = Math.floor(NOW.getTime() / 1000) - 10_800;

      await syncStripeSubscriptionToUser(
        stripeSub({
          status: 'canceled',
          current_period_end: null,
          ended_at: null,
          canceled_at: canceledAt,
        })
      );

      expect((updateData().billingAccessEndedAt as Date).getTime()).toBe(canceledAt * 1000);
    });

    it('falls back to the current time when Stripe supplies no timestamps at all', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: null });

      await syncStripeSubscriptionToUser(
        stripeSub({ status: 'canceled', current_period_end: null })
      );

      expect((updateData().billingAccessEndedAt as Date).getTime()).toBe(NOW.getTime());
    });

    // A legacy Stripe trial that has already elapsed is a reason to stamp the
    // access end date, not to skip it. Treating any non-null trial date as live
    // would leave a lapsed account looking like it still had access, and the
    // cleanup job would never come for its storage.
    it('still ends access when the Stripe trial it reports is already over', async () => {
      dbMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        billingTrialConsumedAt: new Date(NOW.getTime() - 30 * DAY_MS),
        trialEndsAt: null,
      });
      const elapsedTrialEnd = Math.floor((NOW.getTime() - 5 * DAY_MS) / 1000);

      await syncStripeSubscriptionToUser(
        stripeSub({ status: 'canceled', current_period_end: null, trial_end: elapsedTrialEnd })
      );

      expect((updateData().trialEndsAt as Date).getTime()).toBe(elapsedTrialEnd * 1000);
      expect((updateData().billingAccessEndedAt as Date).getTime()).toBe(NOW.getTime());
    });

    it('marks the trial consumed the first time an entitled trial is seen', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: null });
      const trialEnd = Math.floor(NOW.getTime() / 1000) + 5 * 86_400;

      await syncStripeSubscriptionToUser(stripeSub({ status: 'trialing', trial_end: trialEnd }));

      expect((updateData().billingTrialConsumedAt as Date).getTime()).toBe(NOW.getTime());
      expect((updateData().trialEndsAt as Date).getTime()).toBe(trialEnd * 1000);
    });

    it('does not overwrite an existing trial consumption timestamp', async () => {
      const consumed = new Date('2025-06-01T00:00:00.000Z');
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: consumed });

      await syncStripeSubscriptionToUser(
        stripeSub({ status: 'trialing', trial_end: Math.floor(NOW.getTime() / 1000) + 86_400 })
      );

      expect(updateData().billingTrialConsumedAt).toBe(consumed);
    });

    it('leaves the trial unconsumed when the subscription has no trial', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: null });

      await syncStripeSubscriptionToUser(stripeSub({ trial_end: null }));

      expect(updateData().billingTrialConsumedAt).toBeNull();
    });

    it('does not consume the trial for an unentitled subscription', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: null });

      await syncStripeSubscriptionToUser(
        stripeSub({
          status: 'trialing',
          trial_end: Math.floor(NOW.getTime() / 1000) + 86_400,
          items: { data: [{ price: { id: 'price_unrelated' } }] },
        })
      );

      expect(updateData().billingTrialConsumedAt).toBeNull();
    });

    it('records the cancel_at date and flag when the customer scheduled a cancellation', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: null });
      const cancelAt = Math.floor(NOW.getTime() / 1000) + 10 * 86_400;

      await syncStripeSubscriptionToUser(
        stripeSub({ cancel_at: cancelAt, cancel_at_period_end: true })
      );

      expect(updateData().stripeCancelAtPeriodEnd).toBe(true);
      expect((updateData().stripeCancelAt as Date).getTime()).toBe(cancelAt * 1000);
    });

    it('stores null for the price id when the subscription has no items', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: null });

      await syncStripeSubscriptionToUser(stripeSub({ items: { data: [] } }));

      expect(updateData().stripePriceId).toBeNull();
    });

    // The abandoned-checkout case. Stripe grants no trials any more, so every
    // sync arrives with trial_end null, and writing that through would erase the
    // days a cardless trial still had left.
    it('keeps a cardless trial that has not run out when Stripe reports none', async () => {
      const trialEndsAt = new Date(NOW.getTime() + 4 * DAY_MS);
      dbMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        billingTrialConsumedAt: NOW,
        trialEndsAt,
      });

      await syncStripeSubscriptionToUser(
        stripeSub({ status: 'incomplete', current_period_end: null })
      );

      expect(updateData().trialEndsAt).toBe(trialEndsAt);
    });

    it('does not date the storage cleanup from today while that trial runs', async () => {
      dbMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        billingTrialConsumedAt: NOW,
        trialEndsAt: new Date(NOW.getTime() + 4 * DAY_MS),
      });

      await syncStripeSubscriptionToUser(
        stripeSub({ status: 'incomplete', current_period_end: null })
      );

      expect(updateData().billingAccessEndedAt).toBeNull();
    });

    it('clears a trial that has already run out', async () => {
      dbMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        billingTrialConsumedAt: new Date(NOW.getTime() - 30 * DAY_MS),
        trialEndsAt: new Date(NOW.getTime() - DAY_MS),
      });

      await syncStripeSubscriptionToUser(
        stripeSub({ status: 'incomplete', current_period_end: null })
      );

      expect(updateData().trialEndsAt).toBeNull();
      expect(updateData().billingAccessEndedAt).toBeInstanceOf(Date);
    });

    it('still prefers the trial end Stripe reports over the stored one', async () => {
      const stripeTrialEnd = Math.floor(NOW.getTime() / 1000) + 10 * 86_400;
      dbMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        billingTrialConsumedAt: null,
        trialEndsAt: new Date(NOW.getTime() + 2 * DAY_MS),
      });

      await syncStripeSubscriptionToUser(
        stripeSub({ status: 'trialing', trial_end: stripeTrialEnd })
      );

      expect((updateData().trialEndsAt as Date).getTime()).toBe(stripeTrialEnd * 1000);
    });
  });

  describe('markSubscriptionCanceledByCustomerId', () => {
    it('returns null when no user owns the customer id', async () => {
      dbMock.user.findUnique.mockResolvedValue(null);

      await expect(markSubscriptionCanceledByCustomerId('cus_1')).resolves.toBeNull();
      expect(dbMock.user.update).not.toHaveBeenCalled();
    });

    it('clears every subscription field and ends access now by default', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1' });

      await markSubscriptionCanceledByCustomerId('cus_1');

      expect(updateData()).toMatchObject({
        subscriptionStatus: BillingSubscriptionStatus.CANCELED,
        trialEndsAt: null,
        stripeSubscriptionId: null,
        stripePriceId: null,
        stripeCurrentPeriodEnd: null,
        stripeCancelAtPeriodEnd: false,
        stripeCancelAt: null,
      });
      expect((updateData().billingAccessEndedAt as Date).getTime()).toBe(NOW.getTime());
    });

    it('keeps the supplied period end and uses it as the access end date', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1' });
      const periodEnd = new Date('2026-02-01T00:00:00.000Z');

      await markSubscriptionCanceledByCustomerId('cus_1', { currentPeriodEnd: periodEnd });

      expect(updateData().stripeCurrentPeriodEnd).toBe(periodEnd);
      expect(updateData().billingAccessEndedAt).toBe(periodEnd);
    });

    // Cancelling a subscription does not retract days the account was already
    // given, and the settings copy promises exactly this.
    it('keeps a trial that has not run out and leaves access open', async () => {
      const trialEndsAt = new Date(NOW.getTime() + 3 * DAY_MS);
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', trialEndsAt });

      await markSubscriptionCanceledByCustomerId('cus_1');

      expect(updateData().trialEndsAt).toBe(trialEndsAt);
      expect(updateData().billingAccessEndedAt).toBeNull();
    });

    it('still ends access when the trial has already run out', async () => {
      dbMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        trialEndsAt: new Date(NOW.getTime() - DAY_MS),
      });

      await markSubscriptionCanceledByCustomerId('cus_1');

      expect(updateData().trialEndsAt).toBeNull();
      expect((updateData().billingAccessEndedAt as Date).getTime()).toBe(NOW.getTime());
    });

    it('prefers an explicit endedAt over the period end', async () => {
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1' });
      const periodEnd = new Date('2026-02-01T00:00:00.000Z');
      const endedAt = new Date('2026-01-20T00:00:00.000Z');

      await markSubscriptionCanceledByCustomerId('cus_1', {
        currentPeriodEnd: periodEnd,
        endedAt,
      });

      expect(updateData().billingAccessEndedAt).toBe(endedAt);
    });
  });

  describe('syncStripeCustomerSubscriptions', () => {
    it('lists every subscription status for the customer', async () => {
      stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
      dbMock.user.findUnique.mockResolvedValue(null);

      await syncStripeCustomerSubscriptions('cus_1');

      expect(stripeMock.subscriptions.list).toHaveBeenCalledWith({
        customer: 'cus_1',
        status: 'all',
        limit: 100,
      });
    });

    it('marks the subscription canceled when Stripe reports none', async () => {
      stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1' });

      await syncStripeCustomerSubscriptions('cus_1');

      expect(updateData()).toMatchObject({
        subscriptionStatus: BillingSubscriptionStatus.CANCELED,
        stripeSubscriptionId: null,
      });
    });

    it('syncs the authoritative subscription rather than the first one listed', async () => {
      stripeMock.subscriptions.list.mockResolvedValue({
        data: [
          stripeSub({
            id: 'sub_stale',
            status: 'canceled',
            items: { data: [{ price: { id: 'price_unrelated' } }] },
          }),
          stripeSub({ id: 'sub_live', status: 'active' }),
        ],
      });
      dbMock.user.findUnique.mockResolvedValue({ id: 'u1', billingTrialConsumedAt: null });

      await syncStripeCustomerSubscriptions('cus_1');

      expect(updateData()).toMatchObject({
        stripeSubscriptionId: 'sub_live',
        subscriptionStatus: BillingSubscriptionStatus.ACTIVE,
      });
    });
  });
});
