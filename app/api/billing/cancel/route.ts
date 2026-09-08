import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import {
  findLiveStripeSubscription,
  getBillingOverview,
  isUnpaidStripeSubscription,
  syncStripeCustomerSubscriptions,
  voidOpenSubscriptionInvoices,
} from '@/lib/billing';
import { rateLimit } from '@/lib/rate-limit';
import { isStripeFeatureEnabled } from '@/lib/feature-flags';
import { getStripe, isStripeConfigured } from '@/lib/stripe';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { logError } from '@/lib/logger';

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

    const billing = await getBillingOverview(session.user.id);
    const customerId = billing.subscription.stripeCustomerId;
    if (!customerId) {
      return apiErrors.badRequest('No Stripe customer exists for this account');
    }

    const subscription = await findLiveStripeSubscription(customerId);
    if (!subscription) {
      return apiErrors.badRequest('No subscription to cancel');
    }

    const stripe = getStripe();
    const unpaid = isUnpaidStripeSubscription(subscription);

    // Scheduling an unpaid subscription to the end of its period leaves the customer
    // owing money for a period they never paid for, while the already issued invoice
    // keeps retrying their card on its own. Those cancel immediately instead, and the
    // invoice for the unserved period is voided in the same pass.
    const canceled = unpaid
      ? await stripe.subscriptions.cancel(subscription.id)
      : await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true });

    const voidedInvoices = unpaid
      ? await voidOpenSubscriptionInvoices(customerId, subscription.id)
      : [];

    // Re-derived from the customer's whole set rather than written from `canceled` alone.
    // A customer can hold more than one subscription, and mirroring just the one that was
    // cancelled would lock out an account still being billed on another.
    await syncStripeCustomerSubscriptions(customerId);

    const response = successResponse({
      canceledImmediately: unpaid,
      status: canceled.status,
      cancelAt: canceled.cancel_at ? new Date(canceled.cancel_at * 1000).toISOString() : null,
      voidedInvoices,
    });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error canceling Stripe subscription:', error);
    return apiErrors.internalError('Failed to cancel subscription');
  }
}
