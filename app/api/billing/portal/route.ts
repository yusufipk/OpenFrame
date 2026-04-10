import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { getBillingOverview } from '@/lib/billing';
import { rateLimit } from '@/lib/rate-limit';
import { isStripeFeatureEnabled } from '@/lib/feature-flags';
import { getStripe, isStripeConfigured } from '@/lib/stripe';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { logError } from '@/lib/logger';

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

    const billing = await getBillingOverview(session.user.id);
    if (!billing.subscription.stripeCustomerId) {
      return apiErrors.badRequest('No Stripe customer exists for this account');
    }

    const stripe = getStripe();
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: billing.subscription.stripeCustomerId,
      return_url: `${getAppOrigin(request)}/settings`,
    });

    const response = successResponse({ url: portalSession.url });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error creating Stripe portal session:', error);
    return apiErrors.internalError('Failed to open billing portal');
  }
}
