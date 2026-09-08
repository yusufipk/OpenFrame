import { NextRequest } from 'next/server';
import type Stripe from 'stripe';
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

async function readRequestedFlow(request: NextRequest) {
  try {
    const body = await request.json();
    return body?.flow === 'payment_method_update' ? 'payment_method_update' : null;
  } catch {
    return null;
  }
}

async function createPortalSession(
  stripe: Stripe,
  customer: string,
  returnUrl: string,
  flow: 'payment_method_update' | null
) {
  if (flow === 'payment_method_update') {
    try {
      return await stripe.billingPortal.sessions.create({
        customer,
        return_url: returnUrl,
        flow_data: { type: 'payment_method_update' },
      });
    } catch (error) {
      // The portal configuration may not expose this flow; the plain portal still works.
      logError('Falling back to the default Stripe portal flow:', error);
    }
  }

  return stripe.billingPortal.sessions.create({
    customer,
    return_url: returnUrl,
  });
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
    const portalSession = await createPortalSession(
      stripe,
      billing.subscription.stripeCustomerId,
      `${getAppOrigin(request)}/settings`,
      await readRequestedFlow(request)
    );

    const response = successResponse({ url: portalSession.url });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error creating Stripe portal session:', error);
    return apiErrors.internalError('Failed to open billing portal');
  }
}
