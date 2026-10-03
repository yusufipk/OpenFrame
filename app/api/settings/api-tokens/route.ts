import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { logError } from '@/lib/logger';
import { buildBillingAccessWhereInput, hasBillingAccess } from '@/lib/billing';
import { listEditedAccountOwnerIds } from '@/lib/account-editors';
import { API_TOKEN_SCOPES, isApiTokenScope } from '@/lib/api-token-scopes';
import {
  generateApiToken,
  MAX_API_TOKEN_NAME_LENGTH,
  MAX_API_TOKENS_PER_USER,
} from '@/lib/api-tokens';

// Token management is session-only on purpose: these handlers call auth() and
// never read an Authorization header, so a token cannot list, mint or revoke
// tokens. A leaked token stays exactly as powerful as it was when it leaked.

const tokenSelect = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  lastUsedAt: true,
  createdAt: true,
} as const;

/**
 * Minting a token needs billing access: the caller's own (a paid plan or a running
 * trial), or that of an account the caller is an editor on, so an editor on a Studio
 * team can create one without a plan of their own. The owner's plan is not checked:
 * a non-founding Solo account has no editor but its owner, so in practice this is
 * Studio, founding and trial accounts. Being a reviewer somewhere counts for nothing.
 * This gates minting only; every call a token makes still runs the workspace owner's
 * billing check. Tokens already held can always be listed and revoked.
 */
async function canCreateApiToken(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      subscriptionStatus: true,
      trialEndsAt: true,
      stripeCurrentPeriodEnd: true,
      billingAccessEndedAt: true,
    },
  });
  if (!user) return false;
  if (hasBillingAccess(user)) return true;

  const ownerIds = (await listEditedAccountOwnerIds(userId)).filter((id) => id !== userId);
  if (ownerIds.length === 0) return false;
  const payingOwner = await db.user.findFirst({
    where: { id: { in: ownerIds }, ...buildBillingAccessWhereInput() },
    select: { id: true },
  });
  return payingOwner !== null;
}

// GET /api/settings/api-tokens: the signed-in user's tokens, without their secrets
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const [tokens, canCreate] = await Promise.all([
      db.apiToken.findMany({
        where: { userId: session.user.id },
        orderBy: { createdAt: 'desc' },
        select: tokenSelect,
      }),
      canCreateApiToken(session.user.id),
    ]);

    return withCacheControl(successResponse({ tokens, canCreate }), 'private, no-store');
  } catch (error) {
    logError('Error listing API tokens:', error);
    return apiErrors.internalError('Failed to list API tokens');
  }
}

// POST /api/settings/api-tokens: create a token. The plaintext is in this response only.
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
    const userId = session.user.id;

    if (!(await canCreateApiToken(userId))) {
      return apiErrors.forbidden(
        'Creating an API token needs an active plan of your own or on an account you edit.'
      );
    }

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      scopes?: unknown;
    } | null;
    const rawName = body?.name;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) {
      return apiErrors.badRequest('Token name is required');
    }
    if (name.length > MAX_API_TOKEN_NAME_LENGTH) {
      return apiErrors.badRequest(
        `Token name must be ${MAX_API_TOKEN_NAME_LENGTH} characters or fewer`
      );
    }

    const rawScopes = body?.scopes;
    if (!Array.isArray(rawScopes) || rawScopes.length === 0) {
      return apiErrors.badRequest('Choose at least one permission for the token');
    }
    const unknownScope = rawScopes.find((scope) => !isApiTokenScope(scope));
    if (unknownScope !== undefined) {
      return apiErrors.badRequest(`Unknown permission. Use any of: ${API_TOKEN_SCOPES.join(', ')}`);
    }
    // Stored in the canonical order and without duplicates, so two tokens with
    // the same rights read the same on the settings page.
    const scopes = API_TOKEN_SCOPES.filter((scope) => rawScopes.includes(scope));

    const { token, tokenHash, prefix } = generateApiToken();

    // Count and insert under one per-user lock, so two concurrent requests cannot
    // both read nine and both write a tenth.
    const created = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`api-tokens:${userId}`}))`;
      const count = await tx.apiToken.count({ where: { userId } });
      if (count >= MAX_API_TOKENS_PER_USER) return null;
      return tx.apiToken.create({
        data: { userId, name, tokenHash, prefix, scopes },
        select: tokenSelect,
      });
    });
    if (!created) {
      return apiErrors.badRequest(
        `You can have at most ${MAX_API_TOKENS_PER_USER} API tokens. Revoke one first.`
      );
    }

    return withCacheControl(successResponse({ ...created, token }, 201), 'private, no-store');
  } catch (error) {
    logError('Error creating API token:', error);
    return apiErrors.internalError('Failed to create API token');
  }
}
