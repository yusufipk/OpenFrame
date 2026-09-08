import { BillingSubscriptionStatus } from '@prisma/client';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { getBillingOverview, getOpenInvoiceForCustomer } from '@/lib/billing';
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

    // Only looked up when the account actually owes something, so the common path does not
    // pay for a Stripe round trip.
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
      // Gated on the status rather than on the mirrored subscription id: the id survives a
      // cancellation until the deletion webhook arrives, and offering Cancel on an already
      // canceled subscription just returns an error.
      cancelAvailable:
        isStripeConfigured() &&
        billing.subscription.hasRecoverableSubscription &&
        !billing.subscription.cancelAt &&
        !billing.subscription.cancelAtPeriodEnd,
      needsPaymentFix,
      // Whether cancelling ends the subscription there and then rather than at the period
      // end, which is what the confirmation copy has to say. Mirrors the branch the cancel
      // route takes: nothing was paid for the open period, so there is nothing to run out.
      cancelIsImmediate:
        needsPaymentFix || billing.subscription.status === BillingSubscriptionStatus.INCOMPLETE,
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
