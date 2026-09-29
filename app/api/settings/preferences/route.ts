import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { logError } from '@/lib/logger';

const preferenceSelect = { requireProjectDeleteNameConfirmation: true } as const;

// GET /api/settings/preferences: the signed-in user's own UI preferences
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: preferenceSelect,
    });
    if (!user) {
      return apiErrors.unauthorized();
    }

    return withCacheControl(successResponse(user), 'private, no-store');
  } catch (error) {
    logError('Error fetching preferences:', error);
    return apiErrors.internalError('Failed to fetch preferences');
  }
}

// PATCH /api/settings/preferences: update the signed-in user's own UI preferences
export async function PATCH(request: NextRequest) {
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

    const body = await request.json().catch(() => null);
    const value = (body as { requireProjectDeleteNameConfirmation?: unknown } | null)
      ?.requireProjectDeleteNameConfirmation;
    if (typeof value !== 'boolean') {
      return apiErrors.badRequest('requireProjectDeleteNameConfirmation must be a boolean');
    }

    const user = await db.user.update({
      where: { id: session.user.id },
      data: { requireProjectDeleteNameConfirmation: value },
      select: preferenceSelect,
    });

    return withCacheControl(successResponse(user), 'private, no-store');
  } catch (error) {
    logError('Error updating preferences:', error);
    return apiErrors.internalError('Failed to update preferences');
  }
}
