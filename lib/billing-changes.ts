// Changes to a running subscription: storage blocks, plan and billing interval.
//
// Anything that gives the customer more (a block added, Solo to Studio, monthly to
// yearly) is applied to the subscription immediately and invoiced on the spot with
// proration; if that payment fails or needs the bank's confirmation, the update waits
// on an open invoice and nothing is granted until it is paid. Nothing is charged until
// the customer has seen the amount: the first request only previews the invoice and
// answers CHARGE_CONFIRMATION_REQUIRED, and the confirmed request repeats the preview
// at the same proration time and goes ahead only when the amount is still the same. Anything that gives less (fewer blocks, Studio to Solo, yearly to monthly)
// waits for the end of the paid period, expressed as the next phase of a Stripe
// subscription schedule. Stripe applies it, the webhook syncs it, and the account
// keeps what it paid for until then.
//
// No file is ever deleted by any of this. A quota that drops below current usage
// only stops new uploads. That is deliberate, and it means an account can buy room
// for a short while (prorated), fill it, and then drop back: the files stay, and only
// new uploads stop until usage is under the quota again. Nothing here bills for it.

import type Stripe from 'stripe';
import { BillingInterval, BillingPlan, BillingSubscriptionStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import { logError } from '@/lib/logger';
import {
  PLAN_DEFINITIONS,
  STORAGE_BLOCK_BYTES,
  STORAGE_BLOCK_PRICE_CENTS,
  getMaxStorageBlocks,
  getPlanPriceId,
  getStorageCeilingOffer,
  getStorageLimitBytesForPlan,
  getStoragePriceId,
  isFoundingAccount,
  isPlanUpgrade,
  readSubscriptionPlanItems,
  recommendPlanForEditorCount,
} from '@/lib/billing-plans';
import { isPaidTier, syncStripeCustomerSubscriptions } from '@/lib/billing';
import { listAccountEditorIds, listAccountEditorsForReview } from '@/lib/account-editors';
import { EDITOR_BILLING_SELECT, getEditorLimitForUser } from '@/lib/editor-limit';
import { getUserTotalStorageBytes } from '@/lib/storage-quota';

export type BillingChangeError =
  | { code: 'NO_SUBSCRIPTION'; message: string }
  | { code: 'CHANGE_PENDING'; message: string; pendingChangeAt: Date | null }
  | { code: 'PRICE_UNAVAILABLE'; message: string }
  | { code: 'INVALID'; message: string }
  | { code: 'BLOCK_LIMIT'; message: string; offer: 'studio' | 'contact' }
  | { code: 'BELOW_USAGE'; message: string; usedBytes: bigint; newLimitBytes: bigint }
  | {
      code: 'DEMOTION_CONFIRMATION_REQUIRED';
      message: string;
      editors: Array<{ id: string; name: string | null; email: string | null }>;
    }
  | { code: 'FOUNDING_ACKNOWLEDGEMENT_REQUIRED'; message: string }
  | {
      code: 'CHARGE_CONFIRMATION_REQUIRED';
      message: string;
      amountDueCents: number;
      currency: string;
      prorationDate: number;
      renewsAt: Date | null;
    }
  | { code: 'PAYMENT_FAILED'; message: string }
  | { code: 'PAYMENT_ACTION_REQUIRED'; message: string; invoiceUrl: string | null };

export type BillingChangeResult =
  | { ok: true; effective: 'now' | 'period_end'; effectiveAt: Date | null }
  | { ok: false; error: BillingChangeError };

const ACCOUNT_SELECT = {
  id: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  subscriptionStatus: true,
  stripeCurrentPeriodEnd: true,
  billingAccessEndedAt: true,
  stripeCancelAtPeriodEnd: true,
  stripeCancelAt: true,
  billingPlan: true,
  billingInterval: true,
  storageBlocks: true,
  foundingSubscriptionId: true,
} as const;

type Target = { plan: BillingPlan; interval: BillingInterval; storageBlocks: number };

/** What the customer agreed to pay, as shown to them by CHARGE_CONFIRMATION_REQUIRED. */
export type ChargeConfirmation = { amountDueCents: number; prorationDate: number };

// A confirmation older than this is previewed again rather than honoured, so a stale
// page cannot pick a proration time from long ago.
const CHARGE_CONFIRMATION_MAX_AGE_SECONDS = 15 * 60;

function fail(error: BillingChangeError): BillingChangeResult {
  return { ok: false, error };
}

function stripeInterval(interval: BillingInterval) {
  return interval === BillingInterval.YEAR ? ('year' as const) : ('month' as const);
}

/**
 * Loads the account and its live subscription, refusing anything a change cannot be
 * made to: no subscription, one that is not active (fix the payment first), or one
 * already set to cancel (resume it first, in the portal).
 */
async function loadChangeable(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: ACCOUNT_SELECT });
  if (
    !user?.stripeCustomerId ||
    !user.stripeSubscriptionId ||
    user.subscriptionStatus !== BillingSubscriptionStatus.ACTIVE ||
    !isPaidTier(user)
  ) {
    return {
      error: {
        code: 'NO_SUBSCRIPTION',
        message: 'An active subscription is needed to change the plan or storage.',
      } as BillingChangeError,
    };
  }
  if (user.stripeCancelAtPeriodEnd || user.stripeCancelAt) {
    return {
      error: {
        code: 'INVALID',
        message: 'This subscription is set to cancel. Resume it before changing the plan.',
      } as BillingChangeError,
    };
  }

  const subscription = await getStripe().subscriptions.retrieve(user.stripeSubscriptionId, {
    expand: ['schedule'],
  });
  const customer =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const items = readSubscriptionPlanItems(
    subscription.items.data.map((item) => ({
      id: item.id,
      price: item.price,
      quantity: item.quantity ?? null,
    }))
  );
  if (subscription.pending_update) {
    return {
      error: {
        code: 'INVALID',
        message:
          'An earlier change is waiting for its invoice to be paid. Pay or let it expire before making another.',
      } as BillingChangeError,
    };
  }
  if (customer !== user.stripeCustomerId || subscription.status !== 'active' || !items) {
    return {
      error: {
        code: 'NO_SUBSCRIPTION',
        message: 'An active subscription is needed to change the plan or storage.',
      } as BillingChangeError,
    };
  }

  return { user, subscription, items };
}

function scheduleOf(subscription: Stripe.Subscription): Stripe.SubscriptionSchedule | null {
  const schedule = subscription.schedule;
  if (!schedule || typeof schedule === 'string') return null;
  return schedule.status === 'active' ? schedule : null;
}

function itemsFor(target: Target): Array<{ price: string; quantity: number }> | null {
  const planPrice = getPlanPriceId(target.plan, target.interval);
  if (!planPrice) return null;
  const items = [{ price: planPrice, quantity: 1 }];
  if (target.storageBlocks > 0) {
    const storagePrice = getStoragePriceId(target.interval);
    if (!storagePrice) return null;
    items.push({ price: storagePrice, quantity: target.storageBlocks });
  }
  return items;
}

/**
 * Applies a change now, invoicing the prorated difference immediately. Without a
 * matching `charge` it only previews that invoice and asks for confirmation.
 */
async function applyNow(
  subscription: Stripe.Subscription,
  current: NonNullable<ReturnType<typeof readSubscriptionPlanItems>>,
  target: Target,
  charge: ChargeConfirmation | undefined
): Promise<BillingChangeResult> {
  const planPrice = getPlanPriceId(target.plan, target.interval);
  const storagePrice = target.storageBlocks > 0 ? getStoragePriceId(target.interval) : null;
  if (!planPrice || (target.storageBlocks > 0 && !storagePrice)) {
    return fail({ code: 'PRICE_UNAVAILABLE', message: 'This option is not available right now.' });
  }

  const items: Stripe.SubscriptionUpdateParams.Item[] = [];
  if (planPrice !== current.planPriceId) {
    items.push(
      current.planItemId ? { id: current.planItemId, price: planPrice } : { price: planPrice }
    );
  }
  if (target.storageBlocks > 0) {
    items.push(
      current.storageItemId
        ? { id: current.storageItemId, price: storagePrice!, quantity: target.storageBlocks }
        : { price: storagePrice!, quantity: target.storageBlocks }
    );
  } else if (current.storageItemId) {
    items.push({ id: current.storageItemId, deleted: true });
  }
  if (items.length === 0) {
    return fail({ code: 'INVALID', message: 'Nothing to change.' });
  }

  const now = Math.floor(Date.now() / 1000);
  // A confirmation is honoured only at a time inside the period that is running now,
  // so a renewal in between cannot price it across two periods.
  const periodStart = Math.max(
    0,
    ...subscription.items.data.map((item) => item.current_period_start ?? 0)
  );
  let confirmedAt =
    charge &&
    charge.prorationDate <= now &&
    // A period start ahead of this clock is Stripe's clock running ahead; Stripe then
    // refuses the preview itself, which is handled below.
    (periodStart > now || charge.prorationDate >= periodStart) &&
    now - charge.prorationDate <= CHARGE_CONFIRMATION_MAX_AGE_SECONDS
      ? charge.prorationDate
      : null;
  const previewAt = (prorationDate: number) =>
    getStripe().invoices.createPreview({
      customer:
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer.id,
      subscription: subscription.id,
      subscription_details: {
        items,
        proration_behavior: 'always_invoice',
        proration_date: prorationDate,
      },
    });
  let preview: Stripe.Invoice;
  try {
    preview = await previewAt(confirmedAt ?? now);
  } catch (error) {
    // Stripe can refuse a confirmed time that no longer suits the subscription; the
    // customer is shown the price as of now instead of an error.
    if (confirmedAt === null || !isStripeInvalidRequest(error)) throw error;
    confirmedAt = null;
    preview = await previewAt(now);
  }
  if (confirmedAt === null || preview.amount_due !== charge!.amountDueCents) {
    // The latest period end among the invoice lines is when the changed subscription
    // renews: the end of the current period, or a new one when the interval grows.
    const renewsAt = Math.max(0, ...preview.lines.data.map((line) => line.period?.end ?? 0));
    return fail({
      code: 'CHARGE_CONFIRMATION_REQUIRED',
      message: !charge
        ? 'Confirm the amount that will be charged now.'
        : confirmedAt === null
          ? 'That confirmation has expired. Check the amount and confirm again.'
          : 'The amount for this change has changed. Check it and confirm again.',
      amountDueCents: preview.amount_due,
      currency: preview.currency,
      prorationDate: confirmedAt ?? now,
      renewsAt: renewsAt ? new Date(renewsAt * 1000) : null,
    });
  }

  // A schedule left attached after its last change landed would write its stored items
  // back over this one at its next phase boundary, so it is let go first. Callers
  // refuse an immediate change while a change is still pending, so nothing is lost.
  const leftover = scheduleOf(subscription);
  if (leftover) await getStripe().subscriptionSchedules.release(leftover.id);

  let updated: Stripe.Subscription;
  try {
    updated = await getStripe().subscriptions.update(subscription.id, {
      items,
      proration_behavior: 'always_invoice',
      // The time the confirmed preview was priced at, so the invoice matches it.
      proration_date: confirmedAt,
      // Nothing changes until the prorated invoice is paid. A charge that fails or
      // needs the bank's confirmation (3D Secure) leaves the update pending on an open
      // invoice the customer can pay, rather than granting it unpaid or refusing it
      // with no way to authenticate.
      payment_behavior: 'pending_if_incomplete',
      expand: ['latest_invoice'],
    });
  } catch (error) {
    if (isStripeCardError(error)) {
      return fail({
        code: 'PAYMENT_FAILED',
        message: 'The payment for this change did not go through. Update your card and try again.',
      });
    }
    // applyNow may have just let a leftover schedule go, so only the items are compared.
    return refuseIfChangedMeanwhile(subscription, error, { withSchedule: false });
  }

  if (updated.pending_update) {
    const invoice = updated.latest_invoice;
    return fail({
      code: 'PAYMENT_ACTION_REQUIRED',
      message:
        'The payment for this change did not go through or needs your confirmation. It applies as soon as the invoice is paid.',
      invoiceUrl:
        invoice && typeof invoice !== 'string' ? (invoice.hosted_invoice_url ?? null) : null,
    });
  }

  return { ok: true, effective: 'now', effectiveAt: null };
}

function itemsSignature(subscription: Stripe.Subscription, withSchedule: boolean) {
  const schedule = subscription.schedule;
  return JSON.stringify([
    subscription.items.data.map((item) => [item.price.id, item.quantity ?? 1]).sort(),
    withSchedule ? (typeof schedule === 'string' ? schedule : (schedule?.id ?? null)) : null,
  ]);
}

/**
 * Two requests that read the subscription at the same moment (a double click) both
 * build on the same items, and Stripe refuses the second write. When the subscription
 * did change in between, that refusal is reported as a conflict to refresh past; any
 * other refusal is a real error and is thrown.
 */
async function refuseIfChangedMeanwhile(
  subscription: Stripe.Subscription,
  error: unknown,
  { withSchedule }: { withSchedule: boolean }
): Promise<BillingChangeResult> {
  if (!isStripeInvalidRequest(error)) throw error;
  const fresh = await getStripe().subscriptions.retrieve(subscription.id);
  if (itemsSignature(fresh, withSchedule) === itemsSignature(subscription, withSchedule)) {
    throw error;
  }
  return fail({
    code: 'CHANGE_PENDING',
    message: 'Another change to this subscription was just made. Refresh the page to see it.',
    pendingChangeAt: null,
  });
}

function isStripeInvalidRequest(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { type?: string }).type === 'StripeInvalidRequestError'
  );
}

function isStripeCardError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    (error as { type?: string }).type === 'StripeCardError'
  );
}

function phaseDiscounts(phase: Stripe.SubscriptionSchedule.Phase) {
  return (phase.discounts ?? []).flatMap(
    (discount): Stripe.SubscriptionScheduleUpdateParams.Phase.Discount[] => {
      const ref = (value: string | { id: string } | null) =>
        value ? (typeof value === 'string' ? value : value.id) : undefined;
      // The existing discount is reused first. Sending its promotion code instead would
      // redeem the code again, which fails for a single-use code and restarts its duration.
      const discountId = ref(discount.discount);
      if (discountId) return [{ discount: discountId }];
      const promotionCode = ref(discount.promotion_code);
      if (promotionCode) return [{ promotion_code: promotionCode }];
      const coupon = ref(discount.coupon);
      return coupon ? [{ coupon }] : [];
    }
  );
}

/**
 * Sets what the subscription becomes when the paid period ends. The current phase is
 * written back unchanged, discounts included, so only the next phase is new; calling
 * this again replaces that next phase rather than stacking another one.
 */
async function applyAtPeriodEnd(
  subscription: Stripe.Subscription,
  target: Target,
  userId?: string
): Promise<BillingChangeResult> {
  const items = itemsFor(target);
  if (!items) {
    return fail({ code: 'PRICE_UNAVAILABLE', message: 'This option is not available right now.' });
  }

  const stripe = getStripe();
  const running = readSubscriptionPlanItems(
    subscription.items.data.map((item) => ({ price: item.price, quantity: item.quantity ?? null }))
  );
  // Asking for what the subscription already is means undoing the pending change, so
  // the schedule is let go rather than kept with a next phase that changes nothing.
  if (
    running &&
    running.plan === target.plan &&
    running.interval === target.interval &&
    running.storageBlocks === target.storageBlocks
  ) {
    const existing = scheduleOf(subscription);
    if (existing) await stripe.subscriptionSchedules.release(existing.id);
    if (userId) {
      await db.user.update({
        where: { id: userId },
        data: {
          pendingEditorDemotions: [],
          pendingBillingPlan: null,
        },
      });
    }
    return { ok: true, effective: 'now', effectiveAt: null };
  }

  let schedule: Stripe.SubscriptionSchedule;
  try {
    schedule =
      scheduleOf(subscription) ??
      (await stripe.subscriptionSchedules.create({ from_subscription: subscription.id }));
  } catch (error) {
    return refuseIfChangedMeanwhile(subscription, error, { withSchedule: true });
  }
  const currentStart = schedule.current_phase?.start_date;
  const current =
    schedule.phases.find((phase) => phase.start_date === currentStart) ?? schedule.phases[0];
  if (!current) throw new Error('Subscription schedule has no current phase');

  const discounts = phaseDiscounts(current);
  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: 'release',
    proration_behavior: 'none',
    phases: [
      {
        start_date: current.start_date,
        end_date: current.end_date,
        // The live items, not the schedule's record of them: a change applied directly
        // since the schedule was written must not be rolled back mid-period.
        items: subscription.items.data.map((item) => ({
          price: item.price.id,
          quantity: item.quantity ?? 1,
        })),
        discounts,
        proration_behavior: 'none',
      },
      {
        items,
        discounts,
        duration: { interval: stripeInterval(target.interval), interval_count: 1 },
        proration_behavior: 'none',
      },
    ],
  });

  return { ok: true, effective: 'period_end', effectiveAt: new Date(current.end_date * 1000) };
}

/** The target a new change builds on: the pending one if there is one, else today's. */
function baseTarget(
  subscription: Stripe.Subscription,
  current: NonNullable<ReturnType<typeof readSubscriptionPlanItems>>
): { target: Target; pending: boolean } {
  const schedule = scheduleOf(subscription);
  const currentEnd = schedule?.current_phase?.end_date;
  const next = currentEnd
    ? schedule?.phases.find((phase) => phase.start_date >= currentEnd)
    : undefined;
  const nextItems = next
    ? readSubscriptionPlanItems(
        next.items.map((item) => ({ price: item.price, quantity: item.quantity ?? null }))
      )
    : null;
  if (nextItems) {
    return {
      target: {
        plan: nextItems.plan,
        interval: nextItems.interval,
        storageBlocks: nextItems.storageBlocks,
      },
      pending: true,
    };
  }
  return {
    target: {
      plan: current.plan,
      interval: current.interval,
      storageBlocks: current.storageBlocks,
    },
    pending: false,
  };
}

function pendingRefusal(subscription: Stripe.Subscription): BillingChangeResult {
  const end = scheduleOf(subscription)?.current_phase?.end_date;
  return fail({
    code: 'CHANGE_PENDING',
    message:
      'A change is already scheduled for the end of this billing period. Cancel it first, then make this change.',
    pendingChangeAt: end ? new Date(end * 1000) : null,
  });
}

/**
 * Longer than any change takes, including a chain of Stripe calls at the SDK's 80 s
 * request timeout; a lease left behind by a crashed request lapses on its own.
 */
const BILLING_CHANGE_LEASE_MS = 10 * 60 * 1000;

/**
 * Runs one billing change at a time per account. Each change reads the subscription and
 * then writes to Stripe; two of them interleaved (two tabs) would each write from a stale
 * read, and a period-end schedule built on items read before a paid upgrade would put the
 * old items back.
 *
 * The guard is a lease on the user row, claimed with one conditional update and cleared
 * afterwards, so no database connection is held while Stripe is called. A request that
 * finds the lease taken gets `busy()` at once.
 */
export async function withBillingChangeLock<T>(
  userId: string,
  work: () => Promise<T>,
  busy: () => T
): Promise<T> {
  const now = new Date();
  const until = new Date(now.getTime() + BILLING_CHANGE_LEASE_MS);
  const claimed = await db.user.updateMany({
    where: {
      id: userId,
      OR: [{ billingChangeLockedUntil: null }, { billingChangeLockedUntil: { lt: now } }],
    },
    data: { billingChangeLockedUntil: until },
  });
  if (claimed.count === 0) return busy();
  try {
    return await work();
  } finally {
    // Only this claim's lease is cleared; one that lapsed and was claimed again is left alone.
    await db.user
      .updateMany({
        where: { id: userId, billingChangeLockedUntil: until },
        data: { billingChangeLockedUntil: null },
      })
      .catch((error) => logError('billing.change.lease_release', error));
  }
}

const BUSY: BillingChangeResult = {
  ok: false,
  error: {
    code: 'CHANGE_PENDING',
    message: 'Another change to this subscription is still being made. Try again in a moment.',
    pendingChangeAt: null,
  },
};

/** A cheap check before the lock, so accounts that cannot change anything never take it. */
async function hasActiveSubscription(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { subscriptionStatus: true, stripeSubscriptionId: true },
  });
  return user?.subscriptionStatus === 'ACTIVE' && Boolean(user.stripeSubscriptionId);
}

const NO_SUBSCRIPTION: BillingChangeResult = {
  ok: false,
  error: {
    code: 'NO_SUBSCRIPTION',
    message: 'An active subscription is needed to change the plan or storage.',
  },
};

async function syncAfter(customerId: string, result: BillingChangeResult) {
  // Mirror the result now rather than waiting for the webhook, so the new quota or
  // plan is in effect on the very next request.
  if (result.ok) await syncStripeCustomerSubscriptions(customerId);
  return result;
}

/**
 * Sets the number of storage blocks. More takes effect now; fewer at the period end.
 * Going below current usage needs `confirmBelowUsage`, because new uploads will stop
 * until usage is back under the new quota.
 */
export async function changeStorageBlocks(
  userId: string,
  requestedBlocks: number,
  options: { confirmBelowUsage?: boolean; confirmCharge?: ChargeConfirmation } = {}
): Promise<BillingChangeResult> {
  if (!Number.isSafeInteger(requestedBlocks) || requestedBlocks < 0) {
    return fail({ code: 'INVALID', message: 'Choose a whole number of storage blocks.' });
  }
  if (!(await hasActiveSubscription(userId))) return NO_SUBSCRIPTION;
  return withBillingChangeLock(
    userId,
    () => changeStorageBlocksLocked(userId, requestedBlocks, options),
    () => BUSY
  );
}

async function changeStorageBlocksLocked(
  userId: string,
  requestedBlocks: number,
  options: { confirmBelowUsage?: boolean; confirmCharge?: ChargeConfirmation }
): Promise<BillingChangeResult> {
  const loaded = await loadChangeable(userId);
  if ('error' in loaded) return fail(loaded.error!);
  const { user, subscription, items } = loaded;
  const isFounding = isFoundingAccount(user);
  const entitlement = { isPaid: true, billingPlan: items.plan, isFounding };
  const maxBlocks = getMaxStorageBlocks(entitlement);
  const { target: base, pending } = baseTarget(subscription, items);

  if (requestedBlocks > maxBlocks && requestedBlocks > items.storageBlocks) {
    const offer = getStorageCeilingOffer(entitlement);
    return fail({
      code: 'BLOCK_LIMIT',
      offer,
      message:
        offer === 'studio'
          ? `Solo includes up to ${maxBlocks} extra blocks. Studio gives you 1 TB for $29/mo.`
          : `Your plan includes up to ${maxBlocks} extra blocks. Need more? Let's talk.`,
    });
  }

  if (requestedBlocks > items.storageBlocks) {
    if (pending) return pendingRefusal(subscription);
    return syncAfter(
      user.stripeCustomerId!,
      await applyNow(
        subscription,
        items,
        { ...base, storageBlocks: requestedBlocks },
        options.confirmCharge
      )
    );
  }

  // Already the case, most often the second of two clicks: nothing to do, and not an error.
  if (requestedBlocks === base.storageBlocks && requestedBlocks === items.storageBlocks) {
    return { ok: true, effective: 'now', effectiveAt: null };
  }

  // A decrease, or undoing a pending one: lands at the period end in either case.
  const newLimitBytes = getStorageLimitBytesForPlan({
    isPaid: true,
    billingPlan: base.plan,
    storageBlocks: requestedBlocks,
    isFounding,
  });
  if (!options.confirmBelowUsage && requestedBlocks < items.storageBlocks) {
    const usedBytes = await getUserTotalStorageBytes(userId);
    if (usedBytes >= newLimitBytes) {
      return fail({
        code: 'BELOW_USAGE',
        usedBytes,
        newLimitBytes,
        message:
          'You are using more than the new quota allows. Nothing will be deleted, but new uploads will stop until you are under it.',
      });
    }
  }

  return syncAfter(
    user.stripeCustomerId!,
    await applyAtPeriodEnd(subscription, { ...base, storageBlocks: requestedBlocks }, userId)
  );
}

/**
 * Moves to another plan or billing interval.
 *
 * Studio to Solo needs the owner to confirm, by id, exactly which editors will become
 * reviewers when it lands; the list is checked against the current one so a stale
 * confirmation cannot demote somebody the owner never saw. A founding account moving
 * to Studio has to acknowledge that it gives up its founding terms.
 */
export async function changePlan(
  userId: string,
  request: PlanChangeRequest
): Promise<BillingChangeResult> {
  if (!(await hasActiveSubscription(userId))) return NO_SUBSCRIPTION;
  return withBillingChangeLock(
    userId,
    () => changePlanLocked(userId, request),
    () => BUSY
  );
}

type PlanChangeRequest = {
  plan: BillingPlan;
  interval: BillingInterval;
  confirmDemotions?: string[];
  acknowledgeFoundingLoss?: boolean;
  confirmBelowUsage?: boolean;
  confirmCharge?: ChargeConfirmation;
};

async function changePlanLocked(
  userId: string,
  request: PlanChangeRequest
): Promise<BillingChangeResult> {
  const loaded = await loadChangeable(userId);
  if ('error' in loaded) return fail(loaded.error!);
  const { user, subscription, items } = loaded;
  const { target: base, pending } = baseTarget(subscription, items);

  if (!getPlanPriceId(request.plan, request.interval)) {
    return fail({ code: 'PRICE_UNAVAILABLE', message: 'This plan is not available right now.' });
  }
  // Already the case, most often the second of two clicks: nothing to do, and not an error.
  if (request.plan === items.plan && request.interval === items.interval && !pending) {
    return { ok: true, effective: 'now', effectiveAt: null };
  }

  const target: Target = {
    plan: request.plan,
    interval: request.interval,
    storageBlocks: base.storageBlocks,
  };

  const upgradesPlan = isPlanUpgrade(items.plan, request.plan);
  const downgradesPlan = isPlanUpgrade(request.plan, items.plan);
  const lengthensInterval =
    items.interval === BillingInterval.MONTH && request.interval === BillingInterval.YEAR;
  const immediate = upgradesPlan || (!downgradesPlan && lengthensInterval);

  if (isFoundingAccount(user) && request.plan === BillingPlan.STUDIO) {
    if (!request.acknowledgeFoundingLoss) {
      return fail({
        code: 'FOUNDING_ACKNOWLEDGEMENT_REQUIRED',
        message:
          'Your account keeps its founding terms only on its current plan. If you move to Studio and come back later, the founding terms are gone.',
      });
    }
  }

  if (immediate) {
    if (pending) return pendingRefusal(subscription);
    const result = await applyNow(subscription, items, target, request.confirmCharge);
    if (result.ok) {
      await db.user.update({
        where: { id: userId },
        data: { pendingEditorDemotions: [] },
      });
    }
    return syncAfter(user.stripeCustomerId!, result);
  }

  // Blocks beyond what Solo allows stay, but the move does not add any.
  if (downgradesPlan) {
    const confirmation = await checkDemotionConfirmation(userId, request.confirmDemotions);
    if (!confirmation.ok) return confirmation;
    if (!request.confirmBelowUsage) {
      const newLimitBytes = getStorageLimitBytesForPlan({
        isPaid: true,
        billingPlan: request.plan,
        storageBlocks: target.storageBlocks,
        isFounding: false,
      });
      const usedBytes = await getUserTotalStorageBytes(userId);
      if (usedBytes >= newLimitBytes) {
        return fail({
          code: 'BELOW_USAGE',
          usedBytes,
          newLimitBytes,
          message:
            'You are storing more than Solo allows. Nothing will be deleted, but once the change takes effect new uploads stop until you are under the new quota.',
        });
      }
    }
    // Marked before Stripe is called, so the Solo editor limit already applies while
    // the schedule is being written and nobody can be added after the owner confirmed.
    // A failure puts back what was there, which may be an earlier confirmed move.
    const previous = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        pendingEditorDemotions: true,
        pendingBillingPlan: true,
      },
    });
    await db.user.update({
      where: { id: userId },
      data: {
        pendingEditorDemotions: confirmation.ids,
        pendingBillingPlan: BillingPlan.SOLO,
      },
    });
    let result: BillingChangeResult;
    try {
      result = await applyAtPeriodEnd(subscription, target);
    } catch (error) {
      await db.user.update({ where: { id: userId }, data: previous });
      throw error;
    }
    if (!result.ok) {
      await db.user.update({ where: { id: userId }, data: previous });
    }
    return syncAfter(user.stripeCustomerId!, result);
  }

  const result = await applyAtPeriodEnd(subscription, target, userId);
  if (result.ok && target.plan !== BillingPlan.SOLO) {
    await db.user.update({
      where: { id: userId },
      data: { pendingEditorDemotions: [] },
    });
  }
  return syncAfter(user.stripeCustomerId!, result);
}

/**
 * The editors other than the owner who become reviewers when an account lands on Solo,
 * and whether the caller confirmed exactly that set. Checked against the current list,
 * so a stale confirmation cannot demote somebody the owner never saw, and an account
 * with only its owner needs no confirmation at all.
 */
export async function checkDemotionConfirmation(
  userId: string,
  confirmDemotions: string[] | undefined
): Promise<{ ok: true; ids: string[] } | { ok: false; error: BillingChangeError }> {
  const editors = await listAccountEditorsForReview(userId);
  const expected = editors.map((editor) => editor.id).sort();
  const confirmed = [...new Set(confirmDemotions ?? [])].sort();
  if (
    editors.length > 0 &&
    (expected.length !== confirmed.length || expected.some((id, i) => id !== confirmed[i]))
  ) {
    return {
      ok: false,
      error: {
        code: 'DEMOTION_CONFIRMATION_REQUIRED',
        message:
          'Solo includes one editor. These people will become reviewers when the change takes effect. Confirm to continue.',
        editors,
      },
    };
  }
  return { ok: true, ids: expected };
}

/** Calls off whatever was scheduled for the period end and forgets confirmed demotions. */
export async function cancelPendingChange(userId: string): Promise<BillingChangeResult> {
  if (!(await hasActiveSubscription(userId))) return NO_SUBSCRIPTION;
  return withBillingChangeLock(
    userId,
    () => cancelPendingChangeLocked(userId),
    () => BUSY
  );
}

async function cancelPendingChangeLocked(userId: string): Promise<BillingChangeResult> {
  const loaded = await loadChangeable(userId);
  if ('error' in loaded) return fail(loaded.error!);
  const schedule = scheduleOf(loaded.subscription);
  if (!schedule) return fail({ code: 'INVALID', message: 'No change is scheduled.' });
  await getStripe().subscriptionSchedules.release(schedule.id);
  await db.user.update({
    where: { id: userId },
    data: { pendingEditorDemotions: [], pendingBillingPlan: null },
  });
  return syncAfter(loaded.user.stripeCustomerId!, {
    ok: true,
    effective: 'now',
    effectiveAt: null,
  });
}

/**
 * Releases a schedule before cancelling, which Stripe refuses while one is attached.
 * Returns whether one was released.
 */
export async function releaseSubscriptionSchedule(subscription: Stripe.Subscription) {
  const schedule = subscription.schedule;
  if (!schedule) return false;
  const id = typeof schedule === 'string' ? schedule : schedule.id;
  const status = typeof schedule === 'string' ? null : schedule.status;
  if (status && status !== 'active' && status !== 'not_started') return false;
  await getStripe().subscriptionSchedules.release(id);
  return true;
}

/** Everything the billing settings need to draw the plan and storage controls. */
export async function getPlanOverview(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      ...EDITOR_BILLING_SELECT,
      billingInterval: true,
      storageBlocks: true,
      pendingBillingInterval: true,
      pendingStorageBlocks: true,
      pendingChangeAt: true,
      pendingEditorDemotions: true,
    },
  });
  if (!user) throw new Error(`User ${userId} not found`);

  const isPaid = isPaidTier(user);
  const isFounding = isFoundingAccount(user);
  const entitlement = { isPaid, billingPlan: user.billingPlan, isFounding };
  const storageBlocks = isPaid ? user.storageBlocks : 0;
  const editorIds = await listAccountEditorIds(userId);

  const priceAvailable = (plan: BillingPlan, interval: BillingInterval) =>
    Boolean(getPlanPriceId(plan, interval));

  return {
    plan: user.billingPlan,
    interval: user.billingInterval,
    isFounding,
    storageBlocks,
    maxStorageBlocks: getMaxStorageBlocks(entitlement),
    storageCeilingOffer: getStorageCeilingOffer(entitlement),
    limitBytes: getStorageLimitBytesForPlan({ ...entitlement, storageBlocks }).toString(),
    baseStorageBytes: PLAN_DEFINITIONS[user.billingPlan].baseStorageBytes.toString(),
    storageBlockBytes: STORAGE_BLOCK_BYTES.toString(),
    pending:
      user.pendingChangeAt && user.pendingBillingPlan
        ? {
            plan: user.pendingBillingPlan,
            interval: user.pendingBillingInterval,
            storageBlocks: user.pendingStorageBlocks ?? 0,
            at: user.pendingChangeAt.toISOString(),
            editorDemotionCount:
              user.pendingBillingPlan === BillingPlan.SOLO ? user.pendingEditorDemotions.length : 0,
          }
        : null,
    editorCount: editorIds.size,
    editorLimit: getEditorLimitForUser(user),
    recommendedPlan: recommendPlanForEditorCount(editorIds.size),
    // Founding accounts never see Studio offered to them.
    showStudioUpsell: !isFounding,
    prices: {
      SOLO: PLAN_DEFINITIONS.SOLO.priceCents,
      STUDIO: PLAN_DEFINITIONS.STUDIO.priceCents,
      storage: STORAGE_BLOCK_PRICE_CENTS,
    },
    available: {
      SOLO: {
        MONTH: priceAvailable(BillingPlan.SOLO, BillingInterval.MONTH),
        YEAR: priceAvailable(BillingPlan.SOLO, BillingInterval.YEAR),
      },
      STUDIO: {
        MONTH: priceAvailable(BillingPlan.STUDIO, BillingInterval.MONTH),
        YEAR: priceAvailable(BillingPlan.STUDIO, BillingInterval.YEAR),
      },
      storage: {
        MONTH: Boolean(getStoragePriceId(BillingInterval.MONTH)),
        YEAR: Boolean(getStoragePriceId(BillingInterval.YEAR)),
      },
    },
  };
}
