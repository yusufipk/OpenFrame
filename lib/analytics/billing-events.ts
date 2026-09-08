// Turning Stripe state and accepted cancellations into funnel events.
// Sync compares before/after state; in-app cancellation also records acceptance
// because its local claim can hide that transition. Shared cycle keys make both
// paths and replayed webhooks count the same cancellation once.

import type { BillingSubscriptionStatus } from '@prisma/client';
import { eventKey, recordEvent } from '@/lib/analytics/record';
import { isProductAnalyticsEnabled } from '@/lib/feature-flags';

export interface SubscriptionStateBefore {
  status: BillingSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  /** Whether this account had already consumed a trial before this sync. */
  hadTrial: boolean;
}

export interface SubscriptionStateAfter {
  status: BillingSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

/**
 * A cancellation and the reactivation that may follow it both belong to a
 * billing cycle. Keying them on the period end lets a customer cancel, come
 * back, and cancel again in a later cycle without the second one being
 * swallowed as a duplicate, while the two Stripe writes that describe a single
 * cancellation (the `cancel_at_period_end` flag now, the `canceled` status
 * later) collapse into one event.
 */
function cycleMarker(currentPeriodEnd: Date | null): string {
  return String(currentPeriodEnd ? currentPeriodEnd.getTime() : 0);
}

/** Shared by accepted in-app cancellations and sync; recordEvent logs write failures. */
export async function recordSubscriptionCancellation(params: {
  userId: string;
  subscriptionId: string;
  currentPeriodEnd: Date | null;
}): Promise<void> {
  await recordEvent({
    name: 'SUBSCRIPTION_CANCELED',
    dedupeKey: `SUBSCRIPTION_CANCELED:${params.subscriptionId}:${cycleMarker(params.currentPeriodEnd)}`,
    userId: params.userId,
  });
}

export async function recordSubscriptionTransition(params: {
  userId: string;
  subscriptionId: string;
  before: SubscriptionStateBefore;
  after: SubscriptionStateAfter;
}): Promise<void> {
  if (!isProductAnalyticsEnabled()) return;

  const { userId, subscriptionId, before, after } = params;
  const cycle = cycleMarker(after.currentPeriodEnd);

  // Once per account for its lifetime. A second trial is not a second start of
  // the funnel, and Stripe will not grant one anyway.
  if (after.trialEndsAt && !before.hadTrial) {
    await recordEvent({
      name: 'TRIAL_STARTED',
      dedupeKey: eventKey('TRIAL_STARTED', userId),
      userId,
    });
  }

  // The paying moment. With a trial the status goes trialing -> active, so this
  // fires on conversion rather than on signup for the trial.
  if (after.status === 'ACTIVE' && before.status !== 'ACTIVE') {
    await recordEvent({
      name: 'SUBSCRIPTION_STARTED',
      dedupeKey: eventKey('SUBSCRIPTION_STARTED', subscriptionId),
      userId,
    });
  }

  const startedCanceling = after.cancelAtPeriodEnd && !before.cancelAtPeriodEnd;
  const becameCanceled = after.status === 'CANCELED' && before.status !== 'CANCELED';
  if (startedCanceling || becameCanceled) {
    await recordSubscriptionCancellation({
      userId,
      subscriptionId,
      currentPeriodEnd: after.currentPeriodEnd,
    });
  }

  if (!after.cancelAtPeriodEnd && before.cancelAtPeriodEnd && after.status !== 'CANCELED') {
    await recordEvent({
      name: 'SUBSCRIPTION_REACTIVATED',
      dedupeKey: `SUBSCRIPTION_REACTIVATED:${subscriptionId}:${cycle}`,
      userId,
    });
  }
}
