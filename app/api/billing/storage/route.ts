import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { isStripeFeatureEnabled } from '@/lib/feature-flags';
import { isStripeConfigured } from '@/lib/stripe';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { logError } from '@/lib/logger';
import { changeStorageBlocks } from '@/lib/billing-changes';
import { billingChangeResponse, readChargeConfirmation } from '@/lib/billing-change-response';

// POST /api/billing/storage - Set the number of 100 GB storage blocks
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

    const body = await request.json().catch(() => null);
    const blocks = body?.blocks;
    if (typeof blocks !== 'number' || !Number.isSafeInteger(blocks) || blocks < 0 || blocks > 100) {
      return apiErrors.badRequest('blocks must be a whole number');
    }

    const result = await changeStorageBlocks(session.user.id, blocks, {
      confirmBelowUsage: body?.confirmBelowUsage === true,
      confirmCharge: readChargeConfirmation(body?.confirmCharge),
    });
    return billingChangeResponse(result);
  } catch (error) {
    logError('Error changing storage blocks:', error);
    return apiErrors.internalError('Failed to change storage');
  }
}
