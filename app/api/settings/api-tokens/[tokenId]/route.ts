import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ tokenId: string }> };

// DELETE /api/settings/api-tokens/[tokenId]: revoke one of the signed-in user's tokens
export async function DELETE(request: NextRequest, { params }: RouteParams) {
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

    const { tokenId } = await params;

    // Scoped by owner in the same statement, so someone else's token id answers
    // exactly like one that never existed.
    const deleted = await db.apiToken.deleteMany({
      where: { id: tokenId, userId: session.user.id },
    });
    if (deleted.count === 0) {
      return apiErrors.notFound('API token');
    }

    return withCacheControl(successResponse({ message: 'API token revoked' }), 'private, no-store');
  } catch (error) {
    logError('Error revoking API token:', error);
    return apiErrors.internalError('Failed to revoke API token');
  }
}
