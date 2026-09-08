import type Stripe from 'stripe';
import type { CancellationReason } from '@prisma/client';
import { db } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import {
  getSubscriptionPeriodEnd,
  hasActiveSubscription,
  syncStripeSubscriptionToUser,
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
  | { ok: true; periodEnd: Date | null }
  | { ok: false; code: 'NO_SUBSCRIPTION' | 'ALREADY_CANCELING' | 'STRIPE_REJECTED' };

function isStripeInvalidRequest(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    (error as { type?: unknown }).type === 'StripeInvalidRequestError'
  );
}

/**
 * Schedules the account's subscription to end at the close of the current
 * billing period and records why.
 *
 * The order of the writes is deliberate. The local flag is claimed first with
 * a conditional update, so two requests racing for the same subscription (a
 * double click, a retried request) cannot both reach Stripe and both write a
 * reason row: the second one loses the claim and gets `ALREADY_CANCELING`.
 * Stripe goes second because it is the only step that can refuse, and a
 * refusal hands the claim back. The reason row goes third, straight after
 * Stripe accepts, so it exists even if the sync below throws. The sync goes
 * last and is best effort: the webhook for the same update is already on its
 * way and will write the identical state, so a failure here only delays what
 * the settings page shows, it never loses the cancellation.
 */
export async function cancelSubscriptionAtPeriodEnd(params: {
  userId: string;
  reason: CancellationReason | null;
  note: string | null;
}): Promise<CancelSubscriptionResult> {
  const user = await db.user.findUnique({
    where: { id: params.userId },
    select: {
      subscriptionStatus: true,
      stripeSubscriptionId: true,
      stripeCancelAtPeriodEnd: true,
      stripeCurrentPeriodEnd: true,
    },
  });

  if (!user?.stripeSubscriptionId || !hasActiveSubscription(user.subscriptionStatus)) {
    return { ok: false, code: 'NO_SUBSCRIPTION' };
  }

  const subscriptionId = user.stripeSubscriptionId;
  const claimed = await db.user.updateMany({
    where: {
      id: params.userId,
      stripeSubscriptionId: subscriptionId,
      stripeCancelAtPeriodEnd: false,
    },
    data: { stripeCancelAtPeriodEnd: true },
  });
  if (claimed.count === 0) {
    return { ok: false, code: 'ALREADY_CANCELING' };
  }

  let subscription: Stripe.Subscription;
  try {
    subscription = await getStripe().subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
      cancellation_details: params.reason ? { feedback: STRIPE_FEEDBACK[params.reason] } : {},
    });
  } catch (error) {
    await db.user.updateMany({
      where: { id: params.userId, stripeSubscriptionId: subscriptionId },
      data: { stripeCancelAtPeriodEnd: false },
    });
    // The subscription Stripe knows about is not the one we hold, most often
    // because it already ended there and the webhook has not caught up. That
    // is the customer's state, not a server fault, and the portal can show it.
    if (isStripeInvalidRequest(error)) {
      logError('billing.cancel.rejected', error);
      return { ok: false, code: 'STRIPE_REJECTED' };
    }
    throw error;
  }

  const periodEndUnix = getSubscriptionPeriodEnd(subscription);
  const periodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : user.stripeCurrentPeriodEnd;

  await db.subscriptionCancellation.create({
    data: {
      userId: params.userId,
      stripeSubscriptionId: subscriptionId,
      reason: params.reason,
      note: params.note,
      periodEnd,
    },
  });

  try {
    await syncStripeSubscriptionToUser(subscription);
  } catch (error) {
    logError('billing.cancel.sync', error);
  }

  return { ok: true, periodEnd };
}
