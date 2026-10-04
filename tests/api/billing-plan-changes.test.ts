import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { User } from '@prisma/client';
import { db } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import { syncStripeCustomerSubscriptions } from '@/lib/billing';
import { getPlanOverview, withBillingChangeLock } from '@/lib/billing-changes';
import {
  enforceStorageQuota,
  getMaxVideoUploadBytesForUser,
  getStorageContextForUser,
  reserveStorageQuota,
} from '@/lib/storage-quota';
import { POST as storageRoute } from '@/app/api/billing/storage/route';
import { DELETE as cancelPlanChange, POST as planRoute } from '@/app/api/billing/plan/route';
import { POST as checkoutRoute } from '@/app/api/billing/checkout/route';
import { POST as cancelRoute } from '@/app/api/billing/cancel/route';
import { apiRequest, callRoute } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createProject,
  createSubscribedUser,
  createVideo,
  createUploadReservation,
  createUser,
  createWorkspace,
} from '../factories';

const ORIGIN = { origin: 'http://localhost:3000' };
const SOLO_MONTH = 'price_test_openframe_dummy';
const SOLO_YEAR = 'price_solo_year';
const STUDIO_MONTH = 'price_studio_month';
const STUDIO_YEAR = 'price_studio_year';
const STORAGE_MONTH = 'price_storage_month';
const STORAGE_YEAR = 'price_storage_year';
const DAY = 24 * 60 * 60;
const GIB = BigInt(1024) * BigInt(1024) * BigInt(1024);
const unix = (offset: number) => Math.floor(Date.now() / 1000) + offset;

interface FakeItem {
  id: string;
  price: { id: string };
  quantity: number;
  current_period_start: number;
  current_period_end: number;
}

type FakePhase = {
  start_date: number;
  end_date: number;
  discounts: Array<{
    coupon: string | null;
    discount: string | null;
    promotion_code: string | null;
  }>;
  items: Array<{ price: string; quantity: number }>;
};

/**
 * A Stripe double that keeps one subscription and its schedule in memory.
 *
 * It refuses what Stripe would refuse or silently get wrong: a schedule update
 * whose current phase does not match the running items and dates, an
 * `end_behavior` other than release, discounts dropped from either phase, and a
 * retrieve or list that did not expand the schedule (Stripe then returns only
 * its id). When the period ends the schedule stays active through its second
 * phase, as it does in Stripe, rather than disappearing.
 */
function fakeStripe(
  user: User,
  items: Array<{ price: string; quantity?: number }>,
  options: { discountId?: string } = {}
) {
  let seq = 0;
  const period = { start: unix(-10 * DAY), end: unix(20 * DAY) };
  const toItem = (price: string, quantity = 1): FakeItem => ({
    id: `si_${++seq}`,
    price: { id: price },
    quantity,
    current_period_start: period.start,
    current_period_end: period.end,
  });
  const discounts = options.discountId
    ? [{ coupon: null, discount: options.discountId, promotion_code: null }]
    : [];

  const state = {
    subscription: {
      id: user.stripeSubscriptionId!,
      customer: user.stripeCustomerId!,
      status: 'active',
      created: unix(-40 * DAY),
      cancel_at_period_end: false,
      cancel_at: null,
      trial_end: null,
      items: { data: items.map((item) => toItem(item.price, item.quantity)) },
    },
    schedule: null as {
      id: string;
      status: string;
      current_phase: { start_date: number; end_date: number };
      phases: FakePhase[];
    } | null,
    /** The next update's charge is declined. */
    failNextUpdate: false,
    /** The next update needs the bank's confirmation. */
    requireActionOnNextUpdate: false,
    /** An update is waiting for its invoice to be paid. */
    pendingUpdate: false,
    /** Runs once just before the next write lands: another request getting there first. */
    beforeNextWrite: null as null | (() => void),
    /** How long each write takes, so concurrent requests can interleave around it. */
    writeDelayMs: 0,
    /** What the next invoice preview says the change costs. */
    previewAmountCents: 1234,
    /** Stripe refuses previews priced before this time, as it does across a renewal. */
    refusePreviewBefore: 0,
  };
  const slowWrite = () =>
    state.writeDelayMs ? new Promise((resolve) => setTimeout(resolve, state.writeDelayMs)) : null;
  // Stripe's own refusal, shaped the way the SDK raises it.
  const invalidRequest = (message: string) =>
    Object.assign(new Error(message), { type: 'StripeInvalidRequestError' });
  const runBeforeNextWrite = () => {
    const hook = state.beforeNextWrite;
    state.beforeNextWrite = null;
    hook?.();
  };

  const snapshot = (expandSchedule: boolean) =>
    structuredClone({
      ...state.subscription,
      pending_update: state.pendingUpdate ? { subscription_items: [] } : null,
      schedule: state.schedule ? (expandSchedule ? state.schedule : state.schedule.id) : null,
    }) as unknown as Stripe.Subscription;
  const currentItems = () =>
    state.subscription.items.data
      .map((item) => ({ price: item.price.id, quantity: item.quantity }))
      .sort((a, b) => a.price.localeCompare(b.price));

  const update = vi.fn(async (id: string, params: Stripe.SubscriptionUpdateParams) => {
    if (id !== state.subscription.id) throw new Error(`No such subscription ${id}`);
    await slowWrite();
    runBeforeNextWrite();
    if (params.payment_behavior !== 'pending_if_incomplete') {
      throw new Error(`payment_behavior ${params.payment_behavior} could grant the change unpaid`);
    }
    // An item change is invoiced on the spot, so it must be priced at the moment a
    // preview the customer confirmed was priced at.
    if (params.items && !previews.some((p) => p.proration_date === params.proration_date)) {
      throw new Error('Items changed without a previewed proration_date');
    }
    // With pending_if_incomplete Stripe neither throws on a decline nor applies the
    // update: it leaves the update pending on an open invoice, for a decline and for a
    // payment that needs 3D Secure alike.
    if (state.failNextUpdate || state.requireActionOnNextUpdate) {
      state.failNextUpdate = false;
      state.requireActionOnNextUpdate = false;
      state.pendingUpdate = true;
      return {
        ...snapshot(false),
        pending_update: { subscription_items: params.items },
        latest_invoice: { id: 'in_pending', hosted_invoice_url: 'https://invoice.stripe.test/pay' },
      } as unknown as Stripe.Subscription;
    }
    for (const change of params.items ?? []) {
      const existing = state.subscription.items.data.find((item) => item.id === change.id);
      if (change.id && !existing) throw new Error(`No such subscription item ${change.id}`);
      if (change.deleted && existing) {
        state.subscription.items.data = state.subscription.items.data.filter((i) => i !== existing);
      } else if (existing) {
        if (change.price) existing.price = { id: change.price };
        if (change.quantity !== undefined) existing.quantity = change.quantity;
      } else if (change.price) {
        if (state.subscription.items.data.some((item) => item.price.id === change.price)) {
          throw invalidRequest(
            `A new item with Price ${change.price} can't be added because an existing item already uses that Price`
          );
        }
        state.subscription.items.data.push(toItem(change.price, change.quantity ?? 1));
      }
    }
    return snapshot(false);
  });
  const retrieve = vi.fn(async (id: string, params?: Stripe.SubscriptionRetrieveParams) => {
    if (id !== state.subscription.id) throw new Error(`No such subscription ${id}`);
    return snapshot(Boolean(params?.expand?.includes('schedule')));
  });
  const list = vi.fn(async (params: Stripe.SubscriptionListParams) => ({
    data:
      params.customer === state.subscription.customer
        ? [snapshot(Boolean(params.expand?.includes('data.schedule')))]
        : [],
    has_more: false,
  }));

  const scheduleCreate = vi.fn(async (params: Stripe.SubscriptionScheduleCreateParams) => {
    if (params.from_subscription !== state.subscription.id) {
      throw new Error('Schedule created from the wrong subscription');
    }
    await slowWrite();
    runBeforeNextWrite();
    if (state.schedule) throw invalidRequest('The subscription already has a schedule');
    state.schedule = {
      id: 'sub_sched_test',
      status: 'active',
      current_phase: { start_date: period.start, end_date: period.end },
      phases: [
        {
          start_date: period.start,
          end_date: period.end,
          discounts: structuredClone(discounts),
          items: currentItems(),
        },
      ],
    };
    return structuredClone(state.schedule) as unknown as Stripe.SubscriptionSchedule;
  });
  const scheduleUpdate = vi.fn(
    async (id: string, params: Stripe.SubscriptionScheduleUpdateParams) => {
      await slowWrite();
      if (!state.schedule || id !== state.schedule.id) throw new Error(`No such schedule ${id}`);
      if (params.end_behavior !== 'release') {
        throw new Error(`end_behavior ${params.end_behavior} would not keep the subscription`);
      }
      const phases = params.phases ?? [];
      if (phases.length !== 2) throw new Error(`Expected 2 phases, got ${phases.length}`);
      const [current, next] = phases;
      if (current.start_date !== period.start || current.end_date !== period.end) {
        throw new Error('The current phase must keep its dates');
      }
      const sent = current.items
        .map((item) => ({ price: item.price as string, quantity: item.quantity ?? 1 }))
        .sort((a, b) => a.price.localeCompare(b.price));
      if (JSON.stringify(sent) !== JSON.stringify(currentItems())) {
        throw new Error('The current phase must keep the running items');
      }
      const expectedDiscounts = options.discountId ? [{ discount: options.discountId }] : [];
      for (const phase of phases) {
        if (JSON.stringify(phase.discounts ?? []) !== JSON.stringify(expectedDiscounts)) {
          throw new Error(`Discounts not carried: ${JSON.stringify(phase.discounts)}`);
        }
      }
      if (next.start_date !== undefined && next.start_date !== period.end) {
        throw new Error('The next phase must start when the current one ends');
      }
      if (!next.duration) throw new Error('The next phase needs a duration');
      const nextEnd = period.end + (next.duration.interval === 'year' ? 365 : 30) * DAY;
      state.schedule.phases = [
        state.schedule.phases[0],
        {
          start_date: period.end,
          end_date: nextEnd,
          discounts: structuredClone(discounts),
          items: next.items.map((item) => ({
            price: item.price as string,
            quantity: item.quantity ?? 1,
          })),
        },
      ];
      return structuredClone(state.schedule) as unknown as Stripe.SubscriptionSchedule;
    }
  );
  const scheduleRelease = vi.fn(async (id: string) => {
    if (!state.schedule || id !== state.schedule.id) throw new Error(`No such schedule ${id}`);
    state.schedule = null;
    return {};
  });
  const checkoutCreate = vi.fn(async () => ({ id: 'cs_test', url: 'https://stripe.test/c' }));
  const previews: Array<{ proration_date?: number }> = [];
  const createPreview = vi.fn(async (params: Stripe.InvoiceCreatePreviewParams) => {
    if (params.subscription !== state.subscription.id) {
      throw new Error('Preview of the wrong subscription');
    }
    if (params.subscription_details?.proration_behavior !== 'always_invoice') {
      throw new Error('Preview must prorate the way the update does');
    }
    const at = params.subscription_details.proration_date ?? unix(0);
    if (at < state.refusePreviewBefore) {
      throw invalidRequest('proration_date must be within the current period');
    }
    previews.push({ proration_date: params.subscription_details.proration_date });
    // Credit for the unused part of the current period, then the new items; a move to a
    // yearly price starts a new period that runs a year from the change.
    const yearly = (params.subscription_details.items ?? []).some((item) =>
      [SOLO_YEAR, STUDIO_YEAR, STORAGE_YEAR].includes(item.price as string)
    );
    return {
      amount_due: state.previewAmountCents,
      currency: 'usd',
      lines: {
        data: [
          { period: { start: at, end: period.end } },
          { period: { start: at, end: yearly ? at + 365 * DAY : period.end } },
        ],
      },
    } as unknown as Stripe.Invoice;
  });

  vi.mocked(getStripe as unknown as () => unknown).mockReturnValue({
    customers: { create: vi.fn(async () => ({ id: user.stripeCustomerId })) },
    subscriptions: { list, retrieve, update },
    subscriptionSchedules: {
      create: scheduleCreate,
      update: scheduleUpdate,
      release: scheduleRelease,
    },
    checkout: { sessions: { create: checkoutCreate } },
    invoices: { createPreview },
  });

  /**
   * What Stripe does when the period ends: the next phase's items become the
   * subscription, and the schedule stays active in that phase until it releases.
   */
  function reachPeriodEnd() {
    const next = state.schedule?.phases[1];
    if (!state.schedule || !next) throw new Error('No phase is scheduled');
    period.start = next.start_date;
    period.end = next.end_date;
    state.subscription.items.data = next.items.map((item) => toItem(item.price, item.quantity));
    state.schedule.current_phase = { start_date: next.start_date, end_date: next.end_date };
  }

  return {
    state,
    period,
    toItem,
    update,
    list,
    scheduleCreate,
    scheduleUpdate,
    scheduleRelease,
    checkoutCreate,
    createPreview,
    reachPeriodEnd,
  };
}

async function account(
  options: {
    plan?: 'SOLO' | 'STUDIO';
    blocks?: number;
    founding?: boolean;
  } = {}
) {
  const created = await createSubscribedUser();
  return db.user.update({
    where: { id: created.id },
    data: {
      billingPlan: options.plan ?? 'SOLO',
      storageBlocks: options.blocks ?? 0,
      foundingSubscriptionId: options.founding ? created.stripeSubscriptionId : null,
    },
  });
}

function planPrice(plan: 'SOLO' | 'STUDIO') {
  return plan === 'SOLO' ? SOLO_MONTH : STUDIO_MONTH;
}

function stripeItems(plan: 'SOLO' | 'STUDIO', blocks: number) {
  return [
    { price: planPrice(plan) },
    ...(blocks > 0 ? [{ price: STORAGE_MONTH, quantity: blocks }] : []),
  ];
}

function setBlocksOnce(body: unknown) {
  return callRoute(storageRoute, apiRequest('/api/billing/storage', { headers: ORIGIN, body }));
}

function changePlanOnce(body: unknown) {
  return callRoute(planRoute, apiRequest('/api/billing/plan', { headers: ORIGIN, body }));
}

/**
 * Sends a change the way the settings page does: when the server answers with the
 * amount it would charge now, the request is sent again confirming that amount.
 */
async function withChargeConfirmed(send: (body: unknown) => Promise<Response>, body: unknown) {
  const first = await send(body);
  if (first.status !== 409) return first;
  const error = (await first.clone().json()) as {
    code?: string;
    details?: { amountDueCents?: string[]; prorationDate?: string[] };
  };
  if (error.code !== 'CHARGE_CONFIRMATION_REQUIRED') return first;
  return send({
    ...(body as object),
    confirmCharge: {
      amountDueCents: Number(error.details?.amountDueCents?.[0]),
      prorationDate: Number(error.details?.prorationDate?.[0]),
    },
  });
}

function setBlocks(body: unknown) {
  return withChargeConfirmed(setBlocksOnce, body);
}

function changePlan(body: unknown) {
  return withChargeConfirmed(changePlanOnce, body);
}

beforeEach(() => {
  vi.stubEnv('STRIPE_PRICE_ID_SOLO_YEARLY', SOLO_YEAR);
  vi.stubEnv('STRIPE_PRICE_ID_STUDIO_MONTHLY', STUDIO_MONTH);
  vi.stubEnv('STRIPE_PRICE_ID_STUDIO_YEARLY', STUDIO_YEAR);
  vi.stubEnv('STRIPE_PRICE_ID_STORAGE_MONTHLY', STORAGE_MONTH);
  vi.stubEnv('STRIPE_PRICE_ID_STORAGE_YEARLY', STORAGE_YEAR);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('storage quota formula', () => {
  it('gives a Solo account with 2 blocks 400 GB and a 320 GB single-file ceiling', async () => {
    const user = await account({ blocks: 2 });

    expect((await getStorageContextForUser(user.id)).limitBytes).toBe(BigInt(400) * GIB);
    expect(await getMaxVideoUploadBytesForUser(user.id)).toBe(BigInt(320) * GIB);
  });

  it('gives Studio 1 TB before blocks', async () => {
    const user = await account({ plan: 'STUDIO' });

    expect((await getStorageContextForUser(user.id)).limitBytes).toBe(BigInt(1024) * GIB);
  });

  it('offers a paying account that is full a block in the refusal', async () => {
    const user = await account();
    await createUploadReservation({ billedUserId: user.id, sizeBytes: BigInt(200) * GIB });

    const refusal = await enforceStorageQuota(user.id, BigInt(1));

    expect(refusal?.status).toBe(507);
    const body = await refusal!.json();
    expect(body.code).toBe('STORAGE_LIMIT_EXCEEDED');
    expect(body.error).toContain('add 100 GB for $5/mo');
  });

  it('points a full Solo account at its block ceiling to Studio', async () => {
    const user = await account({ blocks: 3 });
    await createUploadReservation({ billedUserId: user.id, sizeBytes: BigInt(500) * GIB });

    const body = await (await enforceStorageQuota(user.id, BigInt(1)))!.json();

    expect(body.error).toContain('Studio');
    expect(body.error).not.toContain('add 100 GB');
  });

  it.each([
    ['set to cancel at period end', { stripeCancelAtPeriodEnd: true }, 0],
    ['set to cancel at period end', { stripeCancelAtPeriodEnd: true }, 3],
    ['set to cancel on a date', { stripeCancelAt: new Date(Date.now() + 86400000) }, 0],
    ['past due', { subscriptionStatus: 'PAST_DUE' as const }, 0],
    ['past due', { subscriptionStatus: 'PAST_DUE' as const }, 3],
    [
      'with a change waiting for the period end',
      { pendingChangeAt: new Date(Date.now() + 86400000) },
      0,
    ],
  ])(
    'offers neither a block nor Studio to a full account %s (%i blocks)',
    async (_label, state, blocks) => {
      const user = await account({ blocks });
      await db.user.update({ where: { id: user.id }, data: state });
      await createUploadReservation({ billedUserId: user.id, sizeBytes: BigInt(500) * GIB });

      const body = await (await enforceStorageQuota(user.id, BigInt(1)))!.json();

      expect(body.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(body.error).toBe(
        'Storage limit reached. Delete files you no longer need, or check your billing settings.'
      );
    }
  );

  it('tells an uploader on someone else’s full account to ask its owner, and only the owner how to buy', async () => {
    const owner = await account();
    await createUploadReservation({ billedUserId: owner.id, sizeBytes: BigInt(200) * GIB });

    const asOwner = await (await enforceStorageQuota(owner.id, BigInt(1), owner.id))!.json();
    const asEditor = await (await enforceStorageQuota(owner.id, BigInt(1), 'someone-else'))!.json();
    const asGuest = await (await enforceStorageQuota(owner.id, BigInt(1), null))!.json();
    const reserved = await reserveStorageQuota(
      owner.id,
      BigInt(1),
      'IMAGE',
      undefined,
      'someone-else'
    );

    expect(asOwner.code).toBe('STORAGE_LIMIT_EXCEEDED');
    expect(asOwner.error).toContain('add 100 GB');
    for (const body of [asEditor, asGuest]) {
      expect(body.code).toBe('STORAGE_LIMIT_EXCEEDED_ASK_OWNER');
      expect(body.error).not.toContain('add 100 GB');
    }
    expect('error' in reserved && (await reserved.error.json()).code).toBe(
      'STORAGE_LIMIT_EXCEEDED_ASK_OWNER'
    );
  });

  it('never offers Studio to a full founding account', async () => {
    const user = await account({ blocks: 10, founding: true });
    await createUploadReservation({ billedUserId: user.id, sizeBytes: BigInt(1200) * GIB });

    const body = await (await enforceStorageQuota(user.id, BigInt(1)))!.json();

    expect(body.error).not.toContain('Studio');
    expect(body.error).toContain("Let's talk");
  });
});

describe('POST /api/billing/storage', () => {
  it('returns 401 without a session', async () => {
    signedOut();
    expect((await setBlocks({ blocks: 1 })).status).toBe(401);
  });

  it('refuses a trial account and leaves Stripe untouched', async () => {
    const trial = await createUser();
    const stripe = fakeStripe(
      await db.user.update({
        where: { id: trial.id },
        data: { stripeCustomerId: 'cus_trial', stripeSubscriptionId: 'sub_trial' },
      }),
      [{ price: SOLO_MONTH }]
    );
    signedInAs(trial);

    const response = await setBlocks({ blocks: 1 });

    expect(response.status).toBe(400);
    expect(stripe.update).not.toHaveBeenCalled();
    expect((await db.user.findUniqueOrThrow({ where: { id: trial.id } })).storageBlocks).toBe(0);
  });

  it('adds a block now, invoiced immediately, and raises the quota at once', async () => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);

    const response = await setBlocks({ blocks: 1 });

    expect(response.status).toBe(200);
    expect(stripe.update).toHaveBeenCalledWith(
      user.stripeSubscriptionId,
      expect.objectContaining({
        items: [{ price: STORAGE_MONTH, quantity: 1 }],
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
      })
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).storageBlocks).toBe(1);
    expect((await getStorageContextForUser(user.id)).limitBytes).toBe(BigInt(300) * GIB);
  });

  it('raises the quantity on an existing block item rather than adding a second item', async () => {
    const user = await account({ blocks: 1 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 1));
    signedInAs(user);

    await setBlocks({ blocks: 2 });

    const storageItem = stripe.state.subscription.items.data.filter(
      (item) => item.price.id === STORAGE_MONTH
    );
    expect(storageItem).toHaveLength(1);
    expect(storageItem[0].quantity).toBe(2);
  });

  it('grants nothing when the charge for a new block fails', async () => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    stripe.state.failNextUpdate = true;
    signedInAs(user);

    const response = await setBlocks({ blocks: 1 });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('PAYMENT_ACTION_REQUIRED');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).storageBlocks).toBe(0);
    expect(stripe.state.subscription.items.data).toHaveLength(1);
  });

  it('answers a repeat of a change that already went through as done, without calling Stripe again', async () => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);

    expect((await setBlocks({ blocks: 1 })).status).toBe(200);
    expect((await setBlocks({ blocks: 1 })).status).toBe(200);
    expect((await changePlan({ plan: 'SOLO', interval: 'MONTH' })).status).toBe(200);

    expect(stripe.update).toHaveBeenCalledTimes(1);
  });

  it('turns a change away before taking the lock when there is no active subscription', async () => {
    const user = await account();
    await db.user.update({ where: { id: user.id }, data: { subscriptionStatus: 'CANCELED' } });
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);
    const claim = vi.spyOn(db.user, 'updateMany');

    const res = await setBlocks({ blocks: 1 });

    expect(res.status).toBe(400);
    expect(claim).not.toHaveBeenCalled();
    expect(stripe.update).not.toHaveBeenCalled();
    claim.mockRestore();
  });

  it('takes over a lease left behind by a request that died', async () => {
    const user = await account();
    await db.user.update({
      where: { id: user.id },
      data: { billingChangeLockedUntil: new Date(Date.now() - 10_000) },
    });
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);

    expect((await setBlocks({ blocks: 1 })).status).toBe(200);
    expect(stripe.update).toHaveBeenCalledTimes(1);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).billingChangeLockedUntil
    ).toBeNull();
  });

  it('turns a change away while another holds the lease, without calling Stripe', async () => {
    const user = await account();
    const held = new Date(Date.now() + 60_000);
    await db.user.update({ where: { id: user.id }, data: { billingChangeLockedUntil: held } });
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);

    const res = await setBlocks({ blocks: 1 });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('BILLING_CHANGE_PENDING');
    expect(stripe.update).not.toHaveBeenCalled();
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).billingChangeLockedUntil
    ).toEqual(held);
  });

  it('leaves alone a lease someone else took after this one lapsed', async () => {
    const user = await account();
    const theirs = new Date(Date.now() + 120_000);

    const result = await withBillingChangeLock(
      user.id,
      async () => {
        await db.user.update({
          where: { id: user.id },
          data: { billingChangeLockedUntil: theirs },
        });
        return 'done';
      },
      () => 'busy'
    );

    expect(result).toBe('done');
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).billingChangeLockedUntil
    ).toEqual(theirs);
  });

  it('takes a double click on Pay for +1 block as one block and one charge, turning the second away at once', async () => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);
    const offer = (await (await setBlocksOnce({ blocks: 1 })).json()).details;
    const confirmed = {
      blocks: 1,
      confirmCharge: {
        amountDueCents: Number(offer.amountDueCents[0]),
        prorationDate: Number(offer.prorationDate[0]),
      },
    };
    stripe.state.writeDelayMs = 40;

    const responses = await Promise.all([setBlocksOnce(confirmed), setBlocksOnce(confirmed)]);

    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    const busy = responses.find((res) => res.status === 409)!;
    expect((await busy.json()).code).toBe('BILLING_CHANGE_PENDING');
    expect(stripe.update).toHaveBeenCalledTimes(1);
    expect(
      stripe.state.subscription.items.data.filter((i) => i.price.id === STORAGE_MONTH)
    ).toEqual([expect.objectContaining({ quantity: 1 })]);
  });

  it('answers a change made elsewhere mid-request (dashboard, portal) with a conflict, not a server error', async () => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);
    // Another writer adds the block between this request's read and its write.
    stripe.state.beforeNextWrite = () =>
      stripe.state.subscription.items.data.push(stripe.toItem(STORAGE_MONTH, 1));

    const res = await setBlocks({ blocks: 1 });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('BILLING_CHANGE_PENDING');
    expect(
      stripe.state.subscription.items.data.filter((i) => i.price.id === STORAGE_MONTH)
    ).toEqual([expect.objectContaining({ quantity: 1 })]);
  });

  it('still fails loudly when Stripe refuses a change nobody else made', async () => {
    const user = await account();
    const stripe = fakeStripe(user, [{ price: SOLO_MONTH }, { price: STORAGE_MONTH, quantity: 1 }]);
    signedInAs(user);
    // The subscription is exactly as it was read, so the refusal is a bug, not a race.
    stripe.update.mockRejectedValueOnce(
      Object.assign(new Error('Invalid price'), { type: 'StripeInvalidRequestError' })
    );

    const res = await setBlocks({ blocks: 2 });

    expect(res.status).toBe(500);
  });

  it('lets changes from two tabs either build on each other or turn the second away, never build on a stale read', async () => {
    const user = await account({ blocks: 2 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 2));
    signedInAs(user);
    // Slow writes let both requests read before either writes, unless they are serialized.
    stripe.state.writeDelayMs = 40;

    const [upgrade, reduce] = await Promise.all([
      changePlan({ plan: 'STUDIO', interval: 'MONTH' }),
      setBlocks({ blocks: 1 }),
    ]);

    // Whichever lands first, the other either builds on it or is refused as pending.
    const statuses = [upgrade.status, reduce.status].sort();
    expect([
      [200, 200],
      [200, 409],
    ]).toContainEqual(statuses);
    const live = stripe.state.subscription.items.data
      .map((item) => [item.price.id, item.quantity])
      .sort();
    if (stripe.state.schedule) {
      // The schedule's current phase is exactly what is running: nothing paid gets rolled back.
      expect(
        stripe.state.schedule.phases[0].items.map((item) => [item.price, item.quantity]).sort()
      ).toEqual(live);
    }
    if (upgrade.status === 200) expect(live).toContainEqual([STUDIO_MONTH, 1]);
  });

  it('answers two period-end changes racing for one schedule with a conflict', async () => {
    const user = await account({ blocks: 2 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 2));
    signedInAs(user);
    stripe.state.beforeNextWrite = () => {
      stripe.state.schedule = {
        id: 'sub_sched_other',
        status: 'active',
        current_phase: { start_date: stripe.period.start, end_date: stripe.period.end },
        phases: [],
      };
    };

    const res = await setBlocks({ blocks: 1 });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('BILLING_CHANGE_PENDING');
  });

  it('refuses a new change while an earlier one waits for its invoice', async () => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    stripe.state.failNextUpdate = true;
    signedInAs(user);
    await setBlocks({ blocks: 1 });

    const second = await setBlocks({ blocks: 2 });

    expect(second.status).toBe(400);
    expect(stripe.update).toHaveBeenCalledTimes(1);
  });

  it('holds a block that needs 3D Secure until its invoice is paid, and hands back that invoice', async () => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    stripe.state.requireActionOnNextUpdate = true;
    signedInAs(user);

    const response = await setBlocks({ blocks: 1 });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('PAYMENT_ACTION_REQUIRED');
    expect(body.details.invoiceUrl).toEqual(['https://invoice.stripe.test/pay']);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).storageBlocks).toBe(0);
  });

  it('refuses any change on a subscription set to cancel on a date', async () => {
    const user = await account();
    await db.user.update({
      where: { id: user.id },
      data: { stripeCancelAt: new Date(Date.now() + 5 * DAY * 1000) },
    });
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);

    const response = await setBlocks({ blocks: 1 });

    expect(response.status).toBe(400);
    expect(stripe.update).not.toHaveBeenCalled();
  });

  it('refuses a fourth block on Solo and offers Studio', async () => {
    const user = await account({ blocks: 3 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 3));
    signedInAs(user);

    const response = await setBlocks({ blocks: 4 });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe('STORAGE_BLOCK_LIMIT_UPGRADE');
    expect(body.error).toContain('Studio gives you 1 TB for $29');
    expect(stripe.update).not.toHaveBeenCalled();
  });

  it('refuses an eleventh block on Studio and points at a conversation', async () => {
    const user = await account({ plan: 'STUDIO', blocks: 10 });
    const stripe = fakeStripe(user, stripeItems('STUDIO', 10));
    signedInAs(user);

    const response = await setBlocks({ blocks: 11 });

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('STORAGE_BLOCK_LIMIT_CONTACT');
    expect(stripe.update).not.toHaveBeenCalled();
  });

  it('lets a founding account go past three blocks and keeps it founding', async () => {
    const user = await account({ blocks: 3, founding: true });
    fakeStripe(user, stripeItems('SOLO', 3));
    signedInAs(user);

    const response = await setBlocks({ blocks: 4 });

    expect(response.status).toBe(200);
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.storageBlocks).toBe(4);
    expect(row.foundingSubscriptionId).toBe(user.stripeSubscriptionId);
  });

  it('asks before a reduction that drops the quota below usage, then deletes nothing and stops uploads', async () => {
    const user = await account({ blocks: 1 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 1));
    const stored = await createUploadReservation({
      billedUserId: user.id,
      sizeBytes: BigInt(250) * GIB,
      expiresInMs: 60 * DAY * 1000,
    });
    signedInAs(user);

    const unconfirmed = await setBlocks({ blocks: 0 });
    expect(unconfirmed.status).toBe(409);
    expect((await unconfirmed.json()).code).toBe('STORAGE_BELOW_USAGE');
    expect(stripe.scheduleCreate).not.toHaveBeenCalled();

    const confirmed = await setBlocks({ blocks: 0, confirmBelowUsage: true });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).data.effective).toBe('period_end');

    // Until the period ends the paid-for quota stands.
    const beforeEnd = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(beforeEnd.storageBlocks).toBe(1);
    expect(beforeEnd.pendingStorageBlocks).toBe(0);
    expect(await enforceStorageQuota(user.id, BigInt(1))).toBeNull();

    stripe.reachPeriodEnd();
    await syncStripeCustomerSubscriptions(user.stripeCustomerId!);

    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).storageBlocks).toBe(0);
    expect((await enforceStorageQuota(user.id, BigInt(1)))?.status).toBe(507);
    expect(await db.uploadReservation.count({ where: { id: stored.id } })).toBe(1);
  });
});

describe('period-end storage changes', () => {
  it('schedules a reduction for the exact end of the paid period and keeps any discount', async () => {
    const user = await account({ blocks: 2 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 2), { discountId: 'di_founding_coupon' });
    signedInAs(user);

    const response = await setBlocks({ blocks: 1 });

    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.effective).toBe('period_end');
    expect(data.effectiveAt).toBe(new Date(stripe.period.end * 1000).toISOString());
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.storageBlocks).toBe(2);
    expect(row.pendingStorageBlocks).toBe(1);
    expect(row.pendingChangeAt).toEqual(new Date(stripe.period.end * 1000));
  });

  it('reduces without asking when the new quota still fits what is stored', async () => {
    const user = await account({ blocks: 1 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 1));
    await createUploadReservation({ billedUserId: user.id, sizeBytes: BigInt(10) * GIB });
    signedInAs(user);

    const response = await setBlocks({ blocks: 0 });

    expect(response.status).toBe(200);
    expect(stripe.scheduleUpdate).toHaveBeenCalledTimes(1);
  });

  it('replaces a pending reduction rather than stacking another phase', async () => {
    const user = await account({ blocks: 3 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 3));
    signedInAs(user);

    await setBlocks({ blocks: 0 });
    const second = await setBlocks({ blocks: 2 });

    expect(second.status).toBe(200);
    expect(stripe.scheduleCreate).toHaveBeenCalledTimes(1);
    expect(stripe.state.schedule?.phases).toHaveLength(2);
    expect(stripe.state.schedule?.phases[1].items).toContainEqual({
      price: STORAGE_MONTH,
      quantity: 2,
    });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).pendingStorageBlocks).toBe(
      2
    );
  });

  it('lets go of the schedule when a pending reduction is undone', async () => {
    const user = await account({ blocks: 3 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 3));
    signedInAs(user);
    await setBlocks({ blocks: 1 });

    const response = await setBlocks({ blocks: 3 });

    expect(response.status).toBe(200);
    expect(stripe.scheduleRelease).toHaveBeenCalledTimes(1);
    expect(stripe.state.schedule).toBeNull();
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.pendingStorageBlocks).toBeNull();
    expect(row.pendingChangeAt).toBeNull();
    expect((await setBlocks({ blocks: 4 })).status).toBe(403);
  });

  it('does not mistake its own release of a landed schedule for somebody else’s change', async () => {
    const user = await account({ plan: 'STUDIO', blocks: 2 });
    const stripe = fakeStripe(user, stripeItems('STUDIO', 2));
    signedInAs(user);
    await setBlocks({ blocks: 1 });
    stripe.reachPeriodEnd();
    await syncStripeCustomerSubscriptions(user.stripeCustomerId!);
    stripe.update.mockRejectedValueOnce(
      Object.assign(new Error('Invalid price'), { type: 'StripeInvalidRequestError' })
    );

    // The schedule is let go before the update; the refusal is still a real error.
    expect((await setBlocks({ blocks: 3 })).status).toBe(500);
    expect(stripe.scheduleRelease).toHaveBeenCalledTimes(1);
  });

  it('does not roll back a block bought after an earlier change landed', async () => {
    const user = await account({ plan: 'STUDIO', blocks: 2 });
    const stripe = fakeStripe(user, stripeItems('STUDIO', 2));
    signedInAs(user);
    await setBlocks({ blocks: 1 });
    stripe.reachPeriodEnd();
    await syncStripeCustomerSubscriptions(user.stripeCustomerId!);

    // The landed schedule is still attached; buying a block lets go of it.
    expect((await setBlocks({ blocks: 3 })).status).toBe(200);
    expect(stripe.scheduleRelease).toHaveBeenCalledTimes(1);
    // A later reduction is built on the live items, which the fake verifies.
    expect((await setBlocks({ blocks: 2 })).status).toBe(200);
    expect(stripe.state.schedule?.phases[0].items).toContainEqual({
      price: STORAGE_MONTH,
      quantity: 3,
    });
  });

  it('refuses to add a block while a reduction is pending, so the purchase is not lost at renewal', async () => {
    const user = await account({ blocks: 2 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 2));
    signedInAs(user);
    await setBlocks({ blocks: 1 });

    const response = await setBlocks({ blocks: 3 });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('BILLING_CHANGE_PENDING');
    expect(stripe.update).not.toHaveBeenCalled();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).storageBlocks).toBe(2);
  });

  it('refuses an upgrade while a change is pending', async () => {
    const user = await account({ blocks: 2 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 2));
    signedInAs(user);
    await setBlocks({ blocks: 1 });

    const response = await changePlan({ plan: 'STUDIO', interval: 'MONTH' });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('BILLING_CHANGE_PENDING');
    expect(stripe.update).not.toHaveBeenCalled();
  });

  it('refuses an eleventh block for a founding account without offering Studio', async () => {
    const user = await account({ blocks: 10, founding: true });
    const stripe = fakeStripe(user, stripeItems('SOLO', 10));
    signedInAs(user);

    const response = await setBlocks({ blocks: 11 });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe('STORAGE_BLOCK_LIMIT_CONTACT');
    expect(body.error).not.toContain('Studio');
    expect(stripe.update).not.toHaveBeenCalled();
  });
});

describe('getPlanOverview', () => {
  it('never offers Studio to a founding account', async () => {
    const user = await account({ founding: true });

    const overview = await getPlanOverview(user.id);

    expect(overview.isFounding).toBe(true);
    expect(overview.showStudioUpsell).toBe(false);
    expect(overview.editorLimit).toBeNull();
    expect(overview.maxStorageBlocks).toBe(10);
    expect(overview.storageCeilingOffer).toBe('contact');
  });

  it('recommends Studio at checkout once a trial has more than one editor', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const editor = await createUser();
    await addWorkspaceMember({ workspaceId: workspace.id, userId: editor.id, role: 'ADMIN' });

    const overview = await getPlanOverview(owner.id);

    expect(overview.editorCount).toBe(2);
    expect(overview.recommendedPlan).toBe('STUDIO');
    expect(overview.editorLimit).toBeNull();
    expect(overview.maxStorageBlocks).toBe(0);
  });

  it('recommends Solo to a trial with only its owner uploading', async () => {
    const owner = await createUser();
    await createWorkspace({ ownerId: owner.id });

    expect((await getPlanOverview(owner.id)).recommendedPlan).toBe('SOLO');
  });

  it('offers Studio to an ordinary Solo account', async () => {
    const user = await account();

    const overview = await getPlanOverview(user.id);

    expect(overview.showStudioUpsell).toBe(true);
    expect(overview.editorLimit).toBe(1);
    expect(overview.maxStorageBlocks).toBe(3);
  });
});

describe('POST /api/billing/plan', () => {
  async function studioWithEditor() {
    const owner = await account({ plan: 'STUDIO' });
    const workspace = await createWorkspace({ ownerId: owner.id });
    const editor = await createUser();
    const membership = await addWorkspaceMember({
      workspaceId: workspace.id,
      userId: editor.id,
      role: 'ADMIN',
    });
    return { owner, editor, membership, workspace };
  }

  it('does not schedule a move to Solo until the editors who will be demoted are confirmed', async () => {
    const { owner, editor, membership } = await studioWithEditor();
    const stripe = fakeStripe(owner, stripeItems('STUDIO', 0));
    signedInAs(owner);

    const response = await changePlan({ plan: 'SOLO', interval: 'MONTH' });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('DEMOTION_CONFIRMATION_REQUIRED');
    expect(body.details.editorIds).toEqual([editor.id]);
    expect(stripe.scheduleCreate).not.toHaveBeenCalled();
    expect(
      (await db.workspaceMember.findUniqueOrThrow({ where: { id: membership.id } })).role
    ).toBe('ADMIN');
  });

  it('refuses a confirmation that does not match the current editors', async () => {
    const { owner } = await studioWithEditor();
    const stripe = fakeStripe(owner, stripeItems('STUDIO', 0));
    signedInAs(owner);

    const response = await changePlan({
      plan: 'SOLO',
      interval: 'MONTH',
      confirmDemotions: ['somebody-else'],
    });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('DEMOTION_CONFIRMATION_REQUIRED');
    expect(stripe.scheduleCreate).not.toHaveBeenCalled();
    const row = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.pendingBillingPlan).toBeNull();
    expect(row.pendingEditorDemotions).toEqual([]);
  });

  it('schedules a confirmed move for the period end and demotes only when it lands', async () => {
    const { owner, editor, membership, workspace } = await studioWithEditor();
    // The same editor holds ADMIN at every level and owns a project, so each
    // demotion path and the ownership handover has to run.
    const ownersProject = await createProject({ ownerId: owner.id, workspaceId: workspace.id });
    const projectMembership = await addProjectMember({
      projectId: ownersProject.id,
      userId: editor.id,
      role: 'ADMIN',
    });
    const folder = await db.projectFolder.create({
      data: { projectId: ownersProject.id, name: 'Cuts' },
    });
    const folderMembership = await db.projectFolderMember.create({
      data: { folderId: folder.id, userId: editor.id, role: 'ADMIN' },
    });
    const video = await createVideo({ projectId: ownersProject.id });
    const videoMembership = await db.videoMember.create({
      data: { videoId: video.id, userId: editor.id, role: 'ADMIN' },
    });
    const editorsProject = await createProject({ ownerId: editor.id, workspaceId: workspace.id });
    const stripe = fakeStripe(owner, stripeItems('STUDIO', 0));
    signedInAs(owner);

    const response = await changePlan({
      plan: 'SOLO',
      interval: 'MONTH',
      confirmDemotions: [editor.id],
    });

    expect(response.status).toBe(200);
    expect((await response.json()).data.effective).toBe('period_end');
    const scheduled = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(scheduled.billingPlan).toBe('STUDIO');
    expect(scheduled.pendingBillingPlan).toBe('SOLO');
    expect(scheduled.pendingEditorDemotions).toEqual([editor.id]);
    expect(scheduled.pendingChangeAt).toEqual(new Date(stripe.period.end * 1000));
    expect(
      (await db.workspaceMember.findUniqueOrThrow({ where: { id: membership.id } })).role
    ).toBe('ADMIN');
    expect(
      (await db.videoMember.findUniqueOrThrow({ where: { id: videoMembership.id } })).role
    ).toBe('ADMIN');

    stripe.reachPeriodEnd();
    await syncStripeCustomerSubscriptions(owner.stripeCustomerId!);

    const landed = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(landed.billingPlan).toBe('SOLO');
    expect(landed.pendingBillingPlan).toBeNull();
    expect(landed.pendingEditorDemotions).toEqual([]);
    expect(
      (await db.workspaceMember.findUniqueOrThrow({ where: { id: membership.id } })).role
    ).toBe('COMMENTATOR');
    expect(
      (await db.projectMember.findUniqueOrThrow({ where: { id: projectMembership.id } })).role
    ).toBe('COMMENTATOR');
    expect(
      (await db.projectFolderMember.findUniqueOrThrow({ where: { id: folderMembership.id } })).role
    ).toBe('COMMENTATOR');
    expect(
      (await db.videoMember.findUniqueOrThrow({ where: { id: videoMembership.id } })).role
    ).toBe('COMMENTATOR');
    // Their project passes to the owner and they keep reviewing it.
    expect((await db.project.findUniqueOrThrow({ where: { id: editorsProject.id } })).ownerId).toBe(
      owner.id
    );
    expect(
      (
        await db.projectMember.findUniqueOrThrow({
          where: { projectId_userId: { projectId: editorsProject.id, userId: editor.id } },
        })
      ).role
    ).toBe('COMMENTATOR');
  });

  it('warns before a move to Solo that lands below what is stored, and deletes nothing', async () => {
    const owner = await account({ plan: 'STUDIO' });
    const stripe = fakeStripe(owner, stripeItems('STUDIO', 0));
    await createUploadReservation({
      billedUserId: owner.id,
      sizeBytes: BigInt(500) * GIB,
      expiresInMs: 60 * DAY * 1000,
    });
    signedInAs(owner);

    const unconfirmed = await changePlan({ plan: 'SOLO', interval: 'MONTH' });
    expect(unconfirmed.status).toBe(409);
    expect((await unconfirmed.json()).code).toBe('STORAGE_BELOW_USAGE');
    expect(stripe.scheduleCreate).not.toHaveBeenCalled();
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: owner.id } })).pendingBillingPlan
    ).toBeNull();

    const confirmed = await changePlan({
      plan: 'SOLO',
      interval: 'MONTH',
      confirmBelowUsage: true,
    });
    expect(confirmed.status).toBe(200);
    expect(await db.uploadReservation.count({ where: { billedUserId: owner.id } })).toBe(1);
  });

  it('keeps every role when a scheduled move to Solo is called off', async () => {
    const { owner, editor, membership } = await studioWithEditor();
    const stripe = fakeStripe(owner, stripeItems('STUDIO', 0));
    signedInAs(owner);
    await changePlan({ plan: 'SOLO', interval: 'MONTH', confirmDemotions: [editor.id] });

    const response = await callRoute(
      cancelPlanChange,
      apiRequest('/api/billing/plan', { method: 'DELETE', headers: ORIGIN })
    );

    expect(response.status).toBe(200);
    expect(stripe.scheduleRelease).toHaveBeenCalled();
    const row = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.pendingBillingPlan).toBeNull();
    expect(row.pendingEditorDemotions).toEqual([]);
    expect(
      (await db.workspaceMember.findUniqueOrThrow({ where: { id: membership.id } })).role
    ).toBe('ADMIN');
  });

  it('keeps blocks beyond the Solo ceiling after a move to Solo, and adds no more', async () => {
    const owner = await account({ plan: 'STUDIO', blocks: 5 });
    const stripe = fakeStripe(owner, stripeItems('STUDIO', 5));
    signedInAs(owner);
    await changePlan({ plan: 'SOLO', interval: 'MONTH' });
    stripe.reachPeriodEnd();
    await syncStripeCustomerSubscriptions(owner.stripeCustomerId!);

    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).storageBlocks).toBe(5);
    expect((await getStorageContextForUser(owner.id)).limitBytes).toBe(BigInt(700) * GIB);
    expect((await setBlocks({ blocks: 6 })).status).toBe(403);
  });

  it('upgrades Solo to Studio now, with proration', async () => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);

    const response = await changePlan({ plan: 'STUDIO', interval: 'MONTH' });

    expect(response.status).toBe(200);
    expect(stripe.update).toHaveBeenCalledWith(
      user.stripeSubscriptionId,
      expect.objectContaining({
        items: [{ id: stripe.state.subscription.items.data[0].id, price: STUDIO_MONTH }],
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
      })
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).billingPlan).toBe(
      'STUDIO'
    );
  });

  it('asks a founding account to acknowledge losing its terms before Studio, then drops them', async () => {
    const user = await account({ founding: true });
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);

    const unacknowledged = await changePlan({ plan: 'STUDIO', interval: 'MONTH' });
    expect(unacknowledged.status).toBe(409);
    expect((await unacknowledged.json()).code).toBe('FOUNDING_ACKNOWLEDGEMENT_REQUIRED');
    expect(stripe.update).not.toHaveBeenCalled();

    const acknowledged = await changePlan({
      plan: 'STUDIO',
      interval: 'MONTH',
      acknowledgeFoundingLoss: true,
    });
    expect(acknowledged.status).toBe(200);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).foundingSubscriptionId
    ).toBeNull();
  });

  it('moves a founding account to yearly without losing founding, and moves its blocks too', async () => {
    const user = await account({ founding: true, blocks: 2 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 2));
    signedInAs(user);

    const response = await changePlan({ plan: 'SOLO', interval: 'YEAR' });

    expect(response.status).toBe(200);
    const prices = stripe.state.subscription.items.data.map((item) => item.price.id).sort();
    expect(prices).toEqual([SOLO_YEAR, STORAGE_YEAR].sort());
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.billingInterval).toBe('YEAR');
    expect(row.storageBlocks).toBe(2);
    expect(row.foundingSubscriptionId).toBe(user.stripeSubscriptionId);
  });
});

describe('subscription sync', () => {
  it('maps plan, interval and blocks from price and quantity', async () => {
    const user = await account();
    const stripe = fakeStripe(user, [{ price: STUDIO_YEAR }, { price: STORAGE_YEAR, quantity: 3 }]);
    void stripe;

    await syncStripeCustomerSubscriptions(user.stripeCustomerId!);

    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.billingPlan).toBe('STUDIO');
    expect(row.billingInterval).toBe('YEAR');
    expect(row.storageBlocks).toBe(3);
    expect(row.subscriptionStatus).toBe('ACTIVE');
  });

  it('drops founding terms when a different subscription takes over', async () => {
    const user = await account({ founding: true });
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    stripe.state.subscription.id = 'sub_restarted';

    await syncStripeCustomerSubscriptions(user.stripeCustomerId!);

    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).foundingSubscriptionId
    ).toBeNull();
  });

  it('clears the blocks of a subscription that has ended, though Stripe still lists them', async () => {
    const user = await account({ blocks: 5, founding: true });
    const stripe = fakeStripe(user, stripeItems('SOLO', 5));
    stripe.state.subscription.status = 'canceled';

    await syncStripeCustomerSubscriptions(user.stripeCustomerId!);

    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.subscriptionStatus).toBe('CANCELED');
    expect(row.storageBlocks).toBe(0);
    expect(row.foundingSubscriptionId).toBeNull();
  });
});

describe('cancellation with a change pending', () => {
  it('forgets the confirmed demotions when a cancellation calls the scheduled move to Solo off', async () => {
    const owner = await account({ plan: 'STUDIO' });
    const workspace = await createWorkspace({ ownerId: owner.id });
    const editor = await createUser();
    const membership = await addWorkspaceMember({
      workspaceId: workspace.id,
      userId: editor.id,
      role: 'ADMIN',
    });
    const stripe = fakeStripe(owner, stripeItems('STUDIO', 0));
    signedInAs(owner);
    expect(
      (await changePlan({ plan: 'SOLO', interval: 'MONTH', confirmDemotions: [editor.id] })).status
    ).toBe(200);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: owner.id } })).pendingEditorDemotions
    ).toEqual([editor.id]);
    // Stripe accepts the cancellation.
    stripe.update.mockImplementationOnce(async () => {
      Object.assign(stripe.state.subscription, { cancel_at_period_end: true });
      return structuredClone(stripe.state.subscription) as unknown as Stripe.Subscription;
    });

    const res = await callRoute(
      cancelRoute,
      apiRequest('/api/billing/cancel', { headers: ORIGIN, body: { reason: null } })
    );

    expect(res.status).toBe(200);
    expect(stripe.scheduleRelease).toHaveBeenCalledTimes(1);
    const row = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.pendingEditorDemotions).toEqual([]);
    expect(row.pendingBillingPlan).toBeNull();
    expect(
      (await db.workspaceMember.findUniqueOrThrow({ where: { id: membership.id } })).role
    ).toBe('ADMIN');
  });

  it('brings the mirror back in line when Stripe refuses the cancellation after the pending change was let go', async () => {
    const user = await account({ blocks: 2 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 2));
    signedInAs(user);
    expect((await setBlocks({ blocks: 1, confirmBelowUsage: true })).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).pendingStorageBlocks).toBe(
      1
    );
    stripe.update.mockRejectedValueOnce(
      Object.assign(new Error('Refused'), { type: 'StripeInvalidRequestError' })
    );

    const res = await callRoute(
      cancelRoute,
      apiRequest('/api/billing/cancel', { headers: ORIGIN, body: { reason: null } })
    );

    expect(res.status).toBe(409);
    expect(stripe.scheduleRelease).toHaveBeenCalledTimes(1);
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.pendingStorageBlocks).toBeNull();
    expect(row.pendingChangeAt).toBeNull();
    expect(row.stripeCancelAtPeriodEnd).toBe(false);
  });
});

describe('POST /api/billing/checkout', () => {
  it('starts checkout on the chosen plan and interval', async () => {
    const user = await createUser({ stripeCustomerId: 'cus_checkout' });
    const stripe = fakeStripe(
      { ...user, stripeSubscriptionId: 'sub_none', stripeCustomerId: 'cus_checkout' },
      []
    );
    stripe.state.subscription.status = 'canceled';
    signedInAs(user);

    const response = await callRoute(
      checkoutRoute,
      apiRequest('/api/billing/checkout', {
        headers: ORIGIN,
        body: { plan: 'STUDIO', interval: 'YEAR' },
      })
    );

    expect(response.status).toBe(200);
    expect(stripe.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({ line_items: [{ price: STUDIO_YEAR, quantity: 1 }] })
    );
  });

  it('starts an older client that sends no plan on Solo monthly', async () => {
    const user = await createUser({ stripeCustomerId: 'cus_checkout_default' });
    const stripe = fakeStripe(
      { ...user, stripeSubscriptionId: 'sub_none', stripeCustomerId: 'cus_checkout_default' },
      []
    );
    stripe.state.subscription.status = 'canceled';
    signedInAs(user);

    const response = await callRoute(
      checkoutRoute,
      apiRequest('/api/billing/checkout', { method: 'POST', headers: ORIGIN })
    );

    expect(response.status).toBe(200);
    expect(stripe.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({ line_items: [{ price: SOLO_MONTH, quantity: 1 }] })
    );
  });

  async function trialWithEditor(customerId: string) {
    const owner = await createUser({ stripeCustomerId: customerId });
    const workspace = await createWorkspace({ ownerId: owner.id });
    const editor = await createUser();
    const membership = await addWorkspaceMember({
      workspaceId: workspace.id,
      userId: editor.id,
      role: 'ADMIN',
    });
    return { owner, workspace, editor, membership };
  }

  /** A Stripe double for a customer with no subscription yet. */
  function stripeWithoutSubscription(owner: User, customerId: string, subscriptionId: string) {
    const stripe = fakeStripe(
      { ...owner, stripeSubscriptionId: subscriptionId, stripeCustomerId: customerId },
      [{ price: SOLO_MONTH }]
    );
    stripe.state.subscription.status = 'canceled';
    return stripe;
  }

  function checkout(body: unknown) {
    return callRoute(checkoutRoute, apiRequest('/api/billing/checkout', { headers: ORIGIN, body }));
  }

  async function roleOf(membershipId: string) {
    return (await db.workspaceMember.findUniqueOrThrow({ where: { id: membershipId } })).role;
  }

  it('makes a trial with a team confirm who becomes a reviewer before checking out Solo', async () => {
    const { owner, editor, membership } = await trialWithEditor('cus_team_trial');
    const stripe = stripeWithoutSubscription(owner, 'cus_team_trial', 'sub_team_trial');
    signedInAs(owner);

    const unconfirmed = await checkout({ plan: 'SOLO', interval: 'MONTH' });
    expect(unconfirmed.status).toBe(409);
    const body = await unconfirmed.json();
    expect(body.code).toBe('DEMOTION_CONFIRMATION_REQUIRED');
    expect(body.details.editorIds).toEqual([editor.id]);
    expect(stripe.checkoutCreate).not.toHaveBeenCalled();
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: owner.id } })).pendingEditorDemotions
    ).toEqual([]);

    const confirmed = await checkout({
      plan: 'SOLO',
      interval: 'MONTH',
      confirmDemotions: [editor.id],
    });
    expect(confirmed.status).toBe(200);
    expect(stripe.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: owner.id } })).pendingEditorDemotions
    ).toEqual([editor.id]);
    // Nothing changes until the subscription is paid.
    expect(await roleOf(membership.id)).toBe('ADMIN');
  });

  it('demotes on activation, not on an unpaid subscription, and includes editors added after confirming', async () => {
    const { owner, workspace, editor, membership } = await trialWithEditor('cus_team_paid');
    const stripe = stripeWithoutSubscription(owner, 'cus_team_paid', 'sub_team_paid');
    signedInAs(owner);
    await checkout({ plan: 'SOLO', interval: 'MONTH', confirmDemotions: [editor.id] });

    // Still on the trial, so still unlimited: somebody is added after confirming.
    const late = await createUser();
    const lateMembership = await addWorkspaceMember({
      workspaceId: workspace.id,
      userId: late.id,
      role: 'ADMIN',
    });
    await db.user.update({
      where: { id: owner.id },
      data: { stripeSubscriptionId: 'sub_team_paid' },
    });

    stripe.state.subscription.status = 'incomplete';
    await syncStripeCustomerSubscriptions('cus_team_paid');
    expect(await roleOf(membership.id)).toBe('ADMIN');
    expect(await roleOf(lateMembership.id)).toBe('ADMIN');

    stripe.state.subscription.status = 'active';
    await syncStripeCustomerSubscriptions('cus_team_paid');
    expect(await roleOf(membership.id)).toBe('COMMENTATOR');
    expect(await roleOf(lateMembership.id)).toBe('COMMENTATOR');
    const row = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.pendingEditorDemotions).toEqual([]);
  });

  it('does not let a second, Studio checkout undo the confirmation of a Solo one that gets paid', async () => {
    const { owner, editor, membership } = await trialWithEditor('cus_two_sessions');
    const stripe = stripeWithoutSubscription(owner, 'cus_two_sessions', 'sub_two_sessions');
    signedInAs(owner);

    await checkout({ plan: 'SOLO', interval: 'MONTH', confirmDemotions: [editor.id] });
    expect((await checkout({ plan: 'STUDIO', interval: 'MONTH' })).status).toBe(200);

    // The Solo session is the one paid.
    await db.user.update({
      where: { id: owner.id },
      data: { stripeSubscriptionId: 'sub_two_sessions' },
    });
    stripe.state.subscription.status = 'active';
    await syncStripeCustomerSubscriptions('cus_two_sessions');

    expect(await roleOf(membership.id)).toBe('COMMENTATOR');
  });

  it('leaves the team alone when the subscription that gets paid is Studio', async () => {
    const { owner, editor, membership } = await trialWithEditor('cus_team_studio');
    const stripe = fakeStripe(
      { ...owner, stripeSubscriptionId: 'sub_team_studio', stripeCustomerId: 'cus_team_studio' },
      [{ price: STUDIO_MONTH }]
    );
    stripe.state.subscription.status = 'canceled';
    signedInAs(owner);
    await checkout({ plan: 'SOLO', interval: 'MONTH', confirmDemotions: [editor.id] });
    await checkout({ plan: 'STUDIO', interval: 'MONTH' });

    stripe.state.subscription.status = 'active';
    await syncStripeCustomerSubscriptions('cus_team_studio');

    expect(await roleOf(membership.id)).toBe('ADMIN');
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).billingPlan).toBe(
      'STUDIO'
    );
  });

  it('holds a Solo subscription to one editor even when it was set up outside the app', async () => {
    // A move to Solo made in the Stripe dashboard carries no confirmation from the app.
    const owner = await account({ plan: 'STUDIO' });
    const workspace = await createWorkspace({ ownerId: owner.id });
    const editor = await createUser();
    const membership = await addWorkspaceMember({
      workspaceId: workspace.id,
      userId: editor.id,
      role: 'ADMIN',
    });
    fakeStripe(owner, stripeItems('SOLO', 0));

    await syncStripeCustomerSubscriptions(owner.stripeCustomerId!);

    expect(await roleOf(membership.id)).toBe('COMMENTATOR');
  });

  it('leaves the team alone while the subscription is Studio', async () => {
    const owner = await account({ plan: 'STUDIO' });
    const workspace = await createWorkspace({ ownerId: owner.id });
    const editor = await createUser();
    const membership = await addWorkspaceMember({
      workspaceId: workspace.id,
      userId: editor.id,
      role: 'ADMIN',
    });
    fakeStripe(owner, stripeItems('STUDIO', 0));

    await syncStripeCustomerSubscriptions(owner.stripeCustomerId!);

    expect(await roleOf(membership.id)).toBe('ADMIN');
  });

  it('never demotes on a founding subscription', async () => {
    const owner = await account({ founding: true });
    const workspace = await createWorkspace({ ownerId: owner.id });
    const editor = await createUser();
    const membership = await addWorkspaceMember({
      workspaceId: workspace.id,
      userId: editor.id,
      role: 'ADMIN',
    });
    fakeStripe(owner, stripeItems('SOLO', 0));

    await syncStripeCustomerSubscriptions(owner.stripeCustomerId!);

    expect(await roleOf(membership.id)).toBe('ADMIN');
  });

  it('refuses an unknown plan', async () => {
    const user = await createUser({ stripeCustomerId: 'cus_checkout_bad' });
    const stripe = fakeStripe(
      { ...user, stripeSubscriptionId: 'sub_none', stripeCustomerId: 'cus_checkout_bad' },
      []
    );
    stripe.state.subscription.status = 'canceled';
    signedInAs(user);

    const response = await callRoute(
      checkoutRoute,
      apiRequest('/api/billing/checkout', {
        headers: ORIGIN,
        body: { plan: 'ENTERPRISE', interval: 'MONTH' },
      })
    );

    expect(response.status).toBe(400);
    expect(stripe.checkoutCreate).not.toHaveBeenCalled();
  });
});

describe('confirming the charge for a change made now', () => {
  async function chargeOffer(response: Response) {
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('CHARGE_CONFIRMATION_REQUIRED');
    return {
      amountDueCents: Number(body.details.amountDueCents[0]),
      currency: body.details.currency[0],
      prorationDate: Number(body.details.prorationDate[0]),
      renewsAt: body.details.renewsAt[0],
    };
  }

  it('shows the amount for a new block and charges nothing until it is confirmed', async () => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    stripe.state.previewAmountCents = 417;
    signedInAs(user);

    const offer = await chargeOffer(await setBlocksOnce({ blocks: 1 }));

    expect(offer.amountDueCents).toBe(417);
    expect(offer.currency).toBe('usd');
    expect(offer.renewsAt).toBe(new Date(stripe.period.end * 1000).toISOString());
    expect(Math.abs(offer.prorationDate - unix(0))).toBeLessThanOrEqual(5);
    expect(stripe.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: user.stripeSubscriptionId,
        subscription_details: expect.objectContaining({
          items: [{ price: STORAGE_MONTH, quantity: 1 }],
          proration_date: offer.prorationDate,
        }),
      })
    );
    expect(stripe.update).not.toHaveBeenCalled();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).storageBlocks).toBe(0);

    const confirmed = await setBlocksOnce({
      blocks: 1,
      confirmCharge: { amountDueCents: 417, prorationDate: offer.prorationDate },
    });

    expect(confirmed.status).toBe(200);
    expect(stripe.update).toHaveBeenCalledTimes(1);
    expect(stripe.update).toHaveBeenCalledWith(
      user.stripeSubscriptionId,
      expect.objectContaining({ proration_date: offer.prorationDate })
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).storageBlocks).toBe(1);
  });

  it('shows the amount for a move to yearly and charges nothing until it is confirmed', async () => {
    const user = await account({ founding: true });
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);

    await chargeOffer(await changePlanOnce({ plan: 'SOLO', interval: 'YEAR' }));

    expect(stripe.update).not.toHaveBeenCalled();
    expect(stripe.state.subscription.items.data.map((item) => item.price.id)).toEqual([SOLO_MONTH]);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).billingInterval).toBe(
      'MONTH'
    );
  });

  it('asks again, charging nothing, when the amount changed after it was shown', async () => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);
    const offer = await chargeOffer(await changePlanOnce({ plan: 'STUDIO', interval: 'MONTH' }));
    stripe.state.previewAmountCents = offer.amountDueCents + 1;

    const again = await chargeOffer(
      await changePlanOnce({
        plan: 'STUDIO',
        interval: 'MONTH',
        confirmCharge: { amountDueCents: offer.amountDueCents, prorationDate: offer.prorationDate },
      })
    );

    expect(again.amountDueCents).toBe(offer.amountDueCents + 1);
    expect(stripe.update).not.toHaveBeenCalled();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).billingPlan).toBe('SOLO');
  });

  it.each([
    ['older than 15 minutes', -16 * 60],
    ['in the future', 120],
  ])('re-prices a confirmation dated %s instead of charging at that time', async (_l, offset) => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);

    const offer = await chargeOffer(
      await setBlocksOnce({
        blocks: 1,
        confirmCharge: { amountDueCents: 1234, prorationDate: unix(offset) },
      })
    );

    expect(Math.abs(offer.prorationDate - unix(0))).toBeLessThanOrEqual(5);
    expect(stripe.update).not.toHaveBeenCalled();
  });

  it.each([
    ['amount as text', { amountDueCents: '1234', prorationDate: unix(0) }],
    ['no date', { amountDueCents: 1234 }],
    ['a plain true', true],
  ])('treats a malformed confirmation (%s) as none', async (_l, confirmCharge) => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);

    await chargeOffer(await setBlocksOnce({ blocks: 1, confirmCharge }));

    expect(stripe.update).not.toHaveBeenCalled();
  });

  it('takes a founding account through the founding warning and then the charge', async () => {
    const user = await account({ founding: true });
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);

    const first = await changePlanOnce({ plan: 'STUDIO', interval: 'MONTH' });
    expect((await first.json()).code).toBe('FOUNDING_ACKNOWLEDGEMENT_REQUIRED');
    expect(stripe.createPreview).not.toHaveBeenCalled();

    const offer = await chargeOffer(
      await changePlanOnce({ plan: 'STUDIO', interval: 'MONTH', acknowledgeFoundingLoss: true })
    );
    expect(stripe.update).not.toHaveBeenCalled();

    const done = await changePlanOnce({
      plan: 'STUDIO',
      interval: 'MONTH',
      acknowledgeFoundingLoss: true,
      confirmCharge: { amountDueCents: offer.amountDueCents, prorationDate: offer.prorationDate },
    });
    expect(done.status).toBe(200);
    expect(stripe.update).toHaveBeenCalledTimes(1);
  });

  it('asks no charge confirmation for changes that wait for the period end', async () => {
    const user = await account({ blocks: 2 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 2));
    signedInAs(user);

    const fewer = await setBlocksOnce({ blocks: 1 });

    expect(fewer.status).toBe(200);
    expect(stripe.createPreview).not.toHaveBeenCalled();
  });
});

describe('what the charge confirmation previews', () => {
  async function offerOf(response: Response) {
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('CHARGE_CONFIRMATION_REQUIRED');
    return { ...body.details, message: body.error } as Record<string, string[]> & {
      message: string;
    };
  }

  it('previews a move to yearly with the yearly prices and its new renewal a year out', async () => {
    const user = await account({ founding: true, blocks: 2 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 2));
    signedInAs(user);

    const offer = await offerOf(await changePlanOnce({ plan: 'SOLO', interval: 'YEAR' }));

    const sent = stripe.createPreview.mock.calls[0][0].subscription_details!.items!;
    expect(sent.map((item) => [item.price, item.quantity ?? 1]).sort()).toEqual(
      [
        [SOLO_YEAR, 1],
        [STORAGE_YEAR, 2],
      ].sort()
    );
    expect(offer.renewsAt[0]).toBe(
      new Date((Number(offer.prorationDate[0]) + 365 * DAY) * 1000).toISOString()
    );
  });

  it('previews Solo to Studio with the blocks kept on the monthly storage price', async () => {
    const user = await account({ blocks: 2 });
    const stripe = fakeStripe(user, stripeItems('SOLO', 2));
    signedInAs(user);

    await offerOf(await changePlanOnce({ plan: 'STUDIO', interval: 'MONTH' }));

    const sent = stripe.createPreview.mock.calls[0][0].subscription_details!.items!;
    expect(sent.map((item) => [item.price, item.quantity ?? 1]).sort()).toEqual(
      [
        [STUDIO_MONTH, 1],
        [STORAGE_MONTH, 2],
      ].sort()
    );
    expect(stripe.update).not.toHaveBeenCalled();
  });

  it('does not honour a confirmation dated before the period that is running now', async () => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);
    // The subscription renewed a minute ago; the confirmation was priced before that.
    for (const item of stripe.state.subscription.items.data) {
      item.current_period_start = unix(-60);
    }

    const offer = await offerOf(
      await setBlocksOnce({
        blocks: 1,
        confirmCharge: { amountDueCents: 1234, prorationDate: unix(-120) },
      })
    );

    expect(Math.abs(Number(offer.prorationDate[0]) - unix(0))).toBeLessThanOrEqual(5);
    expect(offer.message).toBe(
      'That confirmation has expired. Check the amount and confirm again.'
    );
    expect(stripe.update).not.toHaveBeenCalled();
  });

  it('prices again at now when Stripe refuses the confirmed time, rather than failing', async () => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);
    const first = await offerOf(await setBlocksOnce({ blocks: 1 }));
    stripe.state.refusePreviewBefore = Number(first.prorationDate[0]) + 1;
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const offer = await offerOf(
      await setBlocksOnce({
        blocks: 1,
        confirmCharge: {
          amountDueCents: Number(first.amountDueCents[0]),
          prorationDate: Number(first.prorationDate[0]),
        },
      })
    );

    expect(Number(offer.prorationDate[0])).toBeGreaterThan(Number(first.prorationDate[0]));
    expect(offer.message).toBe(
      'That confirmation has expired. Check the amount and confirm again.'
    );
    expect(stripe.update).not.toHaveBeenCalled();
  });

  it('says the amount changed only when it did', async () => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);
    const first = await offerOf(await setBlocksOnce({ blocks: 1 }));
    stripe.state.previewAmountCents = 999;

    const offer = await offerOf(
      await setBlocksOnce({
        blocks: 1,
        confirmCharge: {
          amountDueCents: Number(first.amountDueCents[0]),
          prorationDate: Number(first.prorationDate[0]),
        },
      })
    );

    expect(offer.message).toBe(
      'The amount for this change has changed. Check it and confirm again.'
    );
    expect(offer.amountDueCents).toEqual(['999']);
  });

  it('turns a double click on the + button into two previews and no charge', async () => {
    const user = await account();
    const stripe = fakeStripe(user, stripeItems('SOLO', 0));
    signedInAs(user);

    const responses = await Promise.all([
      setBlocksOnce({ blocks: 1 }),
      setBlocksOnce({ blocks: 1 }),
    ]);

    expect(responses.map((res) => res.status)).toEqual([409, 409]);
    expect(stripe.update).not.toHaveBeenCalled();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).storageBlocks).toBe(0);
  });
});
