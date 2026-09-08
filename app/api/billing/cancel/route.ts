import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import {
  CANCELLATION_NOTE_MAX_LENGTH,
  cancelSubscriptionAtPeriodEnd,
  isCancellationReason,
} from '@/lib/cancellation';
import { RATE_LIMIT_CONFIGS, checkRateLimit, rateLimit, rateLimitHeaders } from '@/lib/rate-limit';
import { isStripeFeatureEnabled } from '@/lib/feature-flags';
import { isStripeConfigured } from '@/lib/stripe';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { logError } from '@/lib/logger';

/**
 * In-app cancellation: end the subscription at the close of the current
 * period and keep the one answer the customer gave about why.
 *
 * This exists beside the Stripe portal rather than instead of it. The portal
 * cannot ask a question of our own, and by the time its webhook arrives the
 * customer has already left the page. Both fields are optional: skipping the
 * question is allowed and must never stand between someone and cancelling.
 */
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

    // A second limit keyed on the account. The IP-keyed one above is shared by
    // every mutating route and, without TRUSTED_PROXY_MODE, by every caller,
    // so it is the wrong thing to lean on for the one action a leaving
    // customer most needs to succeed.
    const config = RATE_LIMIT_CONFIGS['billing-cancel'];
    const limit = await checkRateLimit(session.user.id, 'billing-cancel', config);
    if (!limit.allowed) {
      return new Response(JSON.stringify({ error: 'Too many requests. Please try again later.' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          ...rateLimitHeaders(limit, config.maxRequests),
        },
      });
    }

    if (!isStripeFeatureEnabled()) {
      return apiErrors.badRequest('Stripe billing is disabled by this host');
    }

    if (!isStripeConfigured()) {
      return apiErrors.internalError('Stripe billing is not configured');
    }

    const body = await request.json().catch(() => null);
    const rawReason = body?.reason ?? null;
    if (rawReason !== null && !isCancellationReason(rawReason)) {
      return apiErrors.badRequest('Unknown cancellation reason');
    }

    const rawNote = body?.note;
    if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string') {
      return apiErrors.badRequest('Note must be text');
    }
    const trimmedNote = typeof rawNote === 'string' ? rawNote.trim() : '';
    if (trimmedNote.length > CANCELLATION_NOTE_MAX_LENGTH) {
      return apiErrors.badRequest(
        `Note must be at most ${CANCELLATION_NOTE_MAX_LENGTH} characters`
      );
    }

    const result = await cancelSubscriptionAtPeriodEnd({
      userId: session.user.id,
      reason: rawReason,
      note: trimmedNote.length > 0 ? trimmedNote : null,
    });

    if (!result.ok) {
      switch (result.code) {
        case 'ALREADY_CANCELING':
          return apiErrors.conflict(
            'Your subscription is already set to end at the close of this period'
          );
        case 'STRIPE_REJECTED':
          return apiErrors.conflict(
            'Stripe could not find this subscription. Open Manage Subscription to see its current state.'
          );
        default:
          return apiErrors.conflict('There is no active subscription to cancel');
      }
    }

    const response = successResponse({
      cancelAtPeriodEnd: true,
      periodEnd: result.periodEnd?.toISOString() ?? null,
    });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('billing.cancel', error);
    return apiErrors.internalError('Failed to cancel subscription');
  }
}
