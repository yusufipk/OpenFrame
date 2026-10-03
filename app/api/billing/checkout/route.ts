import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import {
  findBlockingStripeSubscription,
  getOrCreateStripeCustomerId,
  getStripeCheckoutState,
} from '@/lib/billing';
import { rateLimit } from '@/lib/rate-limit';
import { isStripeFeatureEnabled } from '@/lib/feature-flags';
import { BillingInterval, BillingPlan } from '@prisma/client';
import { getStripe, isStripeConfigured } from '@/lib/stripe';
import { getPlanPriceId } from '@/lib/billing-plans';
import { checkDemotionConfirmation } from '@/lib/billing-changes';
import { billingChangeResponse } from '@/lib/billing-change-response';
import { db } from '@/lib/db';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { logError } from '@/lib/logger';
import { eventKey, recordEvent } from '@/lib/analytics/record';

function getAppOrigin(request: NextRequest) {
  if (isTrustedSameOriginRequest(request)) {
    const origin = request.headers.get('origin');
    if (origin) {
      return new URL(origin).origin;
    }
  }

  return request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    if (!isTrustedSameOriginRequest(request)) {
      return apiErrors.forbidden('Invalid request origin');
    }

    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    if (!isStripeFeatureEnabled()) {
      return apiErrors.badRequest('Stripe billing is disabled by this host');
    }

    if (!isStripeConfigured()) {
      return apiErrors.internalError('Stripe billing is not configured');
    }

    const checkoutState = await getStripeCheckoutState(session.user.id);
    // Block a fresh checkout whenever the customer already has a live subscription
    // (active/trialing OR a recoverable one like past_due/unpaid/incomplete).
    // Stripe Checkout in subscription mode always creates a NEW subscription, so
    // letting a past_due user through here duplicates their subscription instead
    // of recovering it. They should manage the existing one via the billing portal.
    if (checkoutState.hasRecoverableSubscription) {
      return apiErrors.badRequest(
        'A subscription already exists for this account. Manage it from the billing portal.'
      );
    }

    // Older clients send no body; they get the original plan, Solo monthly.
    const body = await request.json().catch(() => null);
    const plan = body?.plan ?? BillingPlan.SOLO;
    const interval = body?.interval ?? BillingInterval.MONTH;
    if (
      !Object.values(BillingPlan).includes(plan) ||
      !Object.values(BillingInterval).includes(interval)
    ) {
      return apiErrors.badRequest('Choose a plan and a billing interval');
    }
    const priceId = getPlanPriceId(plan, interval);
    if (!priceId) {
      return apiErrors.badRequest('This plan is not available right now');
    }

    // A trial has no editor limit, so an account can arrive here with a whole team
    // uploading. Choosing Solo means everybody but the owner becomes a reviewer once the
    // subscription is paid; the owner is shown who and confirms, as on a move from
    // Studio. The sync applies it when it sees an active Solo subscription, to whoever
    // edits at that moment. A Studio checkout leaves an earlier confirmation alone, so
    // opening a second checkout session cannot undo the one that ends up paid.
    const confirmDemotions = body?.confirmDemotions;
    if (
      confirmDemotions !== undefined &&
      !(
        Array.isArray(confirmDemotions) &&
        confirmDemotions.length <= 500 &&
        confirmDemotions.every((id: unknown) => typeof id === 'string')
      )
    ) {
      return apiErrors.badRequest('confirmDemotions must be a list of user ids');
    }
    let demotions: string[] | null = null;
    if (plan === BillingPlan.SOLO) {
      const confirmation = await checkDemotionConfirmation(session.user.id, confirmDemotions);
      if (!confirmation.ok) return billingChangeResponse(confirmation);
      demotions = confirmation.ids;
    }

    const stripe = getStripe();
    const customerId = await getOrCreateStripeCustomerId(session.user.id);

    // The guard above reads the local mirror, which can be stale or cleared: the incident
    // that prompted this had a customer holding three subscriptions at once because the
    // mirror said there were none. Stripe is the one that knows.
    const blockingSubscription = await findBlockingStripeSubscription(customerId);
    if (blockingSubscription) {
      return apiErrors.badRequest(
        'A subscription already exists for this account. Manage it from the billing portal.'
      );
    }

    if (demotions) {
      await db.user.update({
        where: { id: session.user.id },
        data: { pendingEditorDemotions: demotions },
      });
    }

    const appOrigin = getAppOrigin(request);

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${appOrigin}/settings?billing=success`,
      cancel_url: `${appOrigin}/settings?billing=canceled`,
      metadata: {
        userId: session.user.id,
      },
      // No trial here. The free trial is granted in the product when the email
      // address is verified, so by the time anyone reaches checkout they have
      // already had it and this subscription bills immediately.
      subscription_data: {
        metadata: {
          userId: session.user.id,
        },
      },
    });

    if (!checkoutSession.url) {
      throw new Error('Stripe did not return a checkout URL');
    }

    // Keyed on the Stripe session, so an abandoned checkout followed by a second
    // attempt counts twice. That is the intent: the gap between checkouts started
    // and subscriptions started is the number worth watching.
    await recordEvent({
      name: 'CHECKOUT_STARTED',
      dedupeKey: eventKey('CHECKOUT_STARTED', checkoutSession.id),
      userId: session.user.id,
    });

    const response = successResponse({ url: checkoutSession.url });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error creating Stripe checkout session:', error);
    return apiErrors.internalError('Failed to start checkout');
  }
}
