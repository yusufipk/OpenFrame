import { BillingSubscriptionStatus } from '@prisma/client';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import {
  findCancelableStripeSubscription,
  isUnpaidStripeSubscription,
  getBillingOverview,
  getOpenInvoiceForCustomer,
} from '@/lib/billing';
import { isStripeFeatureEnabled } from '@/lib/feature-flags';
import { hasStripeRuntimeConfig, isStripeConfigured } from '@/lib/stripe';
import { logError } from '@/lib/logger';

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const billing = await getBillingOverview(session.user.id);
    const isEnabled = isStripeFeatureEnabled();
    const isConfigured = hasStripeRuntimeConfig();

    // Invoice details are only needed when the current subscription is behind on payment.
    const needsPaymentFix =
      billing.subscription.status === BillingSubscriptionStatus.PAST_DUE ||
      billing.subscription.status === BillingSubscriptionStatus.UNPAID;
    const openInvoice =
      isStripeConfigured() && needsPaymentFix && billing.subscription.stripeCustomerId
        ? await getOpenInvoiceForCustomer(
            billing.subscription.stripeCustomerId,
            billing.subscription.stripeSubscriptionId
          )
        : null;

    const cancelable =
      isStripeConfigured() && billing.subscription.stripeCustomerId
        ? await findCancelableStripeSubscription(billing.subscription.stripeCustomerId)
        : null;

    const response = successResponse({
      isEnabled,
      isConfigured,
      status: !isEnabled ? 'disabled' : isStripeConfigured() ? 'ready' : 'misconfigured',
      checkoutAvailable: isStripeConfigured() && !billing.subscription.hasRecoverableSubscription,
      // A customer id alone is not enough: it is created on the first checkout attempt, so
      // someone who abandoned checkout would be sent to an empty portal.
      portalAvailable:
        isStripeConfigured() &&
        Boolean(billing.subscription.stripeCustomerId) &&
        (billing.subscription.hasRecoverableSubscription ||
          Boolean(billing.subscription.stripeSubscriptionId)),
      // An already scheduled unpaid subscription still needs immediate cancellation.
      // A different unscheduled subscription may also remain after an earlier cancel.
      cancelAvailable: Boolean(cancelable),
      needsPaymentFix,
      cancelIsImmediate: Boolean(
        cancelable &&
        (isUnpaidStripeSubscription(cancelable) ||
          ['canceled', 'incomplete_expired'].includes(cancelable.status))
      ),
      openInvoice: openInvoice
        ? {
            id: openInvoice.id,
            hostedInvoiceUrl: openInvoice.hostedInvoiceUrl,
            amountDue: openInvoice.amountDue,
            currency: openInvoice.currency,
            attemptCount: openInvoice.attemptCount,
            nextPaymentAttempt: openInvoice.nextPaymentAttempt?.toISOString() ?? null,
          }
        : null,
      subscription: {
        status: billing.subscription.status,
        label: billing.subscription.label,
        hasActiveSubscription: billing.subscription.hasActiveSubscription,
        hasRecoverableSubscription: billing.subscription.hasRecoverableSubscription,
        hasActiveTrial: billing.subscription.hasActiveTrial,
        hasBillingAccess: billing.subscription.hasBillingAccess,
        isPaid: billing.subscription.isPaid,
        priceId: billing.subscription.stripePriceId,
        currentPeriodEnd: billing.subscription.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: billing.subscription.cancelAtPeriodEnd ?? false,
        cancelAt: billing.subscription.cancelAt?.toISOString() ?? null,
        trialEndsAt: billing.subscription.trialEndsAt?.toISOString() ?? null,
        billingAccessEndedAt: billing.subscription.billingAccessEndedAt?.toISOString() ?? null,
        storageCleanupEligibleAt:
          billing.subscription.storageCleanupEligibleAt?.toISOString() ?? null,
      },
      workspaceCreation: billing.workspaceCreation,
    });

    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error fetching billing overview:', error);
    return apiErrors.internalError('Failed to fetch billing overview');
  }
}
