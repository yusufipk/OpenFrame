import { NextRequest } from 'next/server';
import { BillingInterval, BillingPlan } from '@prisma/client';
import { auth } from '@/lib/auth';
import { apiErrors } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { isStripeFeatureEnabled } from '@/lib/feature-flags';
import { isStripeConfigured } from '@/lib/stripe';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { logError } from '@/lib/logger';
import { cancelPendingChange, changePlan } from '@/lib/billing-changes';
import { billingChangeResponse, readChargeConfirmation } from '@/lib/billing-change-response';

async function guard(request: NextRequest) {
  const limited = await rateLimit(request, 'mutate');
  if (limited) return { response: limited };

  if (!isTrustedSameOriginRequest(request)) {
    return { response: apiErrors.forbidden('Invalid request origin') };
  }

  const session = await auth();
  if (!session?.user?.id) {
    return { response: apiErrors.unauthorized() };
  }

  if (!isStripeFeatureEnabled()) {
    return { response: apiErrors.badRequest('Stripe billing is disabled by this host') };
  }

  if (!isStripeConfigured()) {
    return { response: apiErrors.internalError('Stripe billing is not configured') };
  }

  return { userId: session.user.id };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 500 && value.every((v) => typeof v === 'string');
}

// POST /api/billing/plan - Move to another plan or billing interval
export async function POST(request: NextRequest) {
  try {
    const guarded = await guard(request);
    if ('response' in guarded) return guarded.response;

    const body = await request.json().catch(() => null);
    const plan = body?.plan;
    const interval = body?.interval;
    if (
      !Object.values(BillingPlan).includes(plan) ||
      !Object.values(BillingInterval).includes(interval)
    ) {
      return apiErrors.badRequest('Choose a plan and a billing interval');
    }
    if (body.confirmDemotions !== undefined && !isStringArray(body.confirmDemotions)) {
      return apiErrors.badRequest('confirmDemotions must be a list of user ids');
    }

    const result = await changePlan(guarded.userId, {
      plan,
      interval,
      confirmDemotions: body.confirmDemotions,
      acknowledgeFoundingLoss: body.acknowledgeFoundingLoss === true,
      confirmBelowUsage: body.confirmBelowUsage === true,
      confirmCharge: readChargeConfirmation(body.confirmCharge),
    });
    return billingChangeResponse(result);
  } catch (error) {
    logError('Error changing plan:', error);
    return apiErrors.internalError('Failed to change plan');
  }
}

// DELETE /api/billing/plan - Call off a change scheduled for the period end
export async function DELETE(request: NextRequest) {
  try {
    const guarded = await guard(request);
    if ('response' in guarded) return guarded.response;

    return billingChangeResponse(await cancelPendingChange(guarded.userId));
  } catch (error) {
    logError('Error cancelling scheduled plan change:', error);
    return apiErrors.internalError('Failed to cancel the scheduled change');
  }
}
