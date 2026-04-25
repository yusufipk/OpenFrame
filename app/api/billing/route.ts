import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { getBillingOverview } from '@/lib/billing';
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
    const response = successResponse({
      isEnabled,
      isConfigured,
      status: !isEnabled ? 'disabled' : isStripeConfigured() ? 'ready' : 'misconfigured',
      checkoutAvailable: isStripeConfigured() && !billing.subscription.hasActiveSubscription,
      portalAvailable: isStripeConfigured() && Boolean(billing.subscription.stripeCustomerId),
      subscription: {
        status: billing.subscription.status,
        label: billing.subscription.label,
        hasActiveSubscription: billing.subscription.hasActiveSubscription,
        hasActiveTrial: billing.subscription.hasActiveTrial,
        hasBillingAccess: billing.subscription.hasBillingAccess,
        isTrialEligible: billing.subscription.isTrialEligible,
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
