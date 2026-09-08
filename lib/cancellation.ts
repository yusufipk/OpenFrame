import type Stripe from 'stripe';
import type { CancellationReason } from '@prisma/client';
import { db } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import {
  getSubscriptionPeriodEnd,
  findCancelableStripeSubscription,
  isUnpaidStripeSubscription,
  syncStripeCustomerSubscriptions,
  voidOpenSubscriptionInvoices,
} from '@/lib/billing';
import { logError } from '@/lib/logger';

export {
  CANCELLATION_NOTE_MAX_LENGTH,
  CANCELLATION_REASONS,
  getCancellationReasonLabel,
  isCancellationReason,
} from '@/lib/cancellation-reasons';

// Stripe keeps its own fixed list of cancellation feedback values. Mirroring
// ours onto it costs nothing and puts the category next to the subscription in
// the Stripe dashboard, where it is read during a refund or a support reply.
// The free-text note deliberately stays on our side: the dialog does not say
// the text leaves the product, so it does not.
const STRIPE_FEEDBACK: Record<
  CancellationReason,
  Stripe.SubscriptionUpdateParams.CancellationDetails.Feedback
> = {
  NOT_USING: 'unused',
  MISSING_FEATURE: 'missing_features',
  PRICE_OR_BILLING: 'too_expensive',
  PROJECT_ENDED: 'other',
  OTHER: 'other',
};

export type CancelSubscriptionResult =
  | {
      ok: true;
      periodEnd: Date | null;
      canceledImmediately: boolean;
      voidedInvoices: string[];
      status: Stripe.Subscription.Status;
      cancelAt: Date | null;
    }
  | { ok: false; code: 'NO_SUBSCRIPTION' | 'ALREADY_CANCELING' | 'STRIPE_REJECTED' };

function isStripeInvalidRequest(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    (error as { type?: unknown }).type === 'StripeInvalidRequestError'
  );
}

/** Expire every open Checkout session for this incomplete subscription, including later pages. */
async function expireSubscriptionCheckout(customerId: string, subscriptionId: string) {
  const stripe = getStripe();
  let startingAfter: string | undefined;
  let expired = false;
  do {
    const sessions = await stripe.checkout.sessions.list({
      customer: customerId,
      status: 'open',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const matching = sessions.data.filter((session) => {
      const owner = typeof session.customer === 'string' ? session.customer : session.customer?.id;
      const id =
        typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
      return owner === customerId && id === subscriptionId && session.status === 'open';
    });
    await Promise.all(matching.map((session) => stripe.checkout.sessions.expire(session.id)));
    expired ||= matching.length > 0;
    startingAfter = sessions.has_more ? sessions.data.at(-1)?.id : undefined;
  } while (startingAfter);
  return expired;
}

/**
 * Paid subscriptions end at period end; unpaid subscriptions end immediately.
 * Record the reason before invoice cleanup so a failed cleanup can be retried
 * on the canceled subscription without losing or duplicating the answer.
 */
export async function cancelSubscription(params: {
  userId: string;
  reason: CancellationReason | null;
  note: string | null;
}): Promise<CancelSubscriptionResult> {
  const requestStartedAt = new Date();
  const user = await db.user.findUnique({
    where: { id: params.userId },
    select: {
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      stripeCancelAtPeriodEnd: true,
      stripeCurrentPeriodEnd: true,
    },
  });
  if (!user?.stripeCustomerId) return { ok: false, code: 'NO_SUBSCRIPTION' };

  const customerId = user.stripeCustomerId;
  const original = await findCancelableStripeSubscription(customerId);
  if (!original) return { ok: false, code: 'NO_SUBSCRIPTION' };
  const owner = typeof original.customer === 'string' ? original.customer : original.customer.id;
  if (owner !== customerId) return { ok: false, code: 'NO_SUBSCRIPTION' };

  const subscriptionId = original.id;
  const cleanupRetry = original.status === 'canceled' || original.status === 'incomplete_expired';
  const canceledImmediately = cleanupRetry || isUnpaidStripeSubscription(original);
  if (!canceledImmediately && original.status !== 'active' && original.status !== 'trialing') {
    return { ok: false, code: 'NO_SUBSCRIPTION' };
  }
  if (!canceledImmediately && (original.cancel_at_period_end || original.cancel_at)) {
    return { ok: false, code: 'ALREADY_CANCELING' };
  }

  // Retain the paid mirror's conditional claim for double-clicks. It cannot
  // guard an unpaid cancellation, cleanup retry, or a different subscription.
  const claimPaidMirror = !canceledImmediately && user.stripeSubscriptionId === subscriptionId;
  if (claimPaidMirror) {
    const claimed = await db.user.updateMany({
      where: {
        id: params.userId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        stripeCancelAtPeriodEnd: false,
      },
      data: { stripeCancelAtPeriodEnd: true },
    });
    if (claimed.count === 0) return { ok: false, code: 'ALREADY_CANCELING' };
  }

  let subscription = original;
  try {
    const stripe = getStripe();
    const cancellationDetails = params.reason ? { feedback: STRIPE_FEEDBACK[params.reason] } : {};
    if (!cleanupRetry) {
      if (!canceledImmediately) {
        subscription = await stripe.subscriptions.update(subscriptionId, {
          cancel_at_period_end: true,
          cancellation_details: cancellationDetails,
        });
      } else if (
        original.status === 'incomplete' &&
        (await expireSubscriptionCheckout(customerId, subscriptionId))
      ) {
        // Checkout owns incomplete subscriptions it created. Expiration cancels
        // them; retrieving gives the response the actual resulting Stripe state.
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
        if (subscription.status !== 'canceled' && subscription.status !== 'incomplete_expired') {
          throw new Error('Checkout expiration did not end the subscription');
        }
      } else {
        subscription = await stripe.subscriptions.cancel(subscriptionId, {
          cancellation_details: cancellationDetails,
        });
      }
    }
  } catch (error) {
    if (claimPaidMirror) {
      await db.user.updateMany({
        where: { id: params.userId, stripeSubscriptionId: subscriptionId },
        data: { stripeCancelAtPeriodEnd: false },
      });
    }
    if (isStripeInvalidRequest(error)) {
      logError('billing.cancel.rejected', error);
      return { ok: false, code: 'STRIPE_REJECTED' };
    }
    throw error;
  }

  const periodEndUnix = getSubscriptionPeriodEnd(original);
  const periodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : user.stripeCurrentPeriodEnd;
  await db.$transaction(async (tx) => {
    // The paid mirror's claim does not cover other subscriptions. Serialize every
    // reason write and reuse only a row written during this request, so a resumed
    // subscription can record another cancellation without duplicating concurrent calls.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${subscriptionId}))`;
    // Cleanup can be retried long after the request that canceled the subscription.
    // Match that period and, when Stripe reports it, the terminal transition time.
    // An incomplete expiration may have no ended_at, so its period is the fallback.
    const existing = await tx.subscriptionCancellation.findFirst({
      where: {
        userId: params.userId,
        stripeSubscriptionId: subscriptionId,
        ...(cleanupRetry
          ? {
              periodEnd,
              ...(original.ended_at
                ? { createdAt: { gte: new Date(original.ended_at * 1000) } }
                : {}),
            }
          : { createdAt: { gte: requestStartedAt } }),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!existing) {
      await tx.subscriptionCancellation.create({
        data: {
          userId: params.userId,
          stripeSubscriptionId: subscriptionId,
          reason: params.reason,
          note: params.note,
          periodEnd,
        },
      });
    }
  });

  let voidedInvoices: string[] = [];
  try {
    if (canceledImmediately) {
      // Eligibility must use the pre-cancellation period, not a shortened one.
      // Failures propagate; the selector exposes canceled cleanup candidates.
      voidedInvoices = await voidOpenSubscriptionInvoices(customerId, subscriptionId, original);
    }
  } finally {
    // Reconcile the whole customer even if cleanup failed. Another subscription
    // may still provide access. Webhooks can repair a failed local sync.
    try {
      await syncStripeCustomerSubscriptions(customerId);
    } catch (error) {
      logError('billing.cancel.sync', error);
    }
  }

  return {
    ok: true,
    periodEnd,
    canceledImmediately,
    voidedInvoices,
    status: subscription.status,
    cancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : null,
  };
}
