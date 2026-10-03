import { NextRequest } from 'next/server';
import { revalidateTag } from 'next/cache';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { apiErrors, successResponse } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { STRIPE_STATS_CACHE_TAG } from '@/lib/admin-stats';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ userId: string }> };

// PATCH /api/admin/users/[userId]
// Body: { excludedFromStats: boolean }. Leaves an account out of the admin counts, or
// puts it back; nothing about the account itself changes.
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.isAdmin) {
      return apiErrors.forbidden('Admin access required');
    }

    const { userId } = await params;
    const body = await request.json().catch(() => null);
    const excludedFromStats = (body as { excludedFromStats?: unknown } | null)?.excludedFromStats;
    if (typeof excludedFromStats !== 'boolean') {
      return apiErrors.badRequest('excludedFromStats must be true or false');
    }

    const { count } = await db.user.updateMany({
      where: { id: userId },
      data: { excludedFromStats },
    });
    if (count === 0) {
      return apiErrors.notFound('User');
    }

    revalidateTag(STRIPE_STATS_CACHE_TAG, { expire: 0 });

    return successResponse({ id: userId, excludedFromStats });
  } catch (error) {
    logError('Error updating user stats exclusion:', error);
    return apiErrors.internalError('Failed to update user');
  }
}
