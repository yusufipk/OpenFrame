/**
 * Personal access tokens: how a script or an AI agent uses OpenFrame without a
 * browser.
 *
 * A token stands in for its owner, but only on the route handlers wrapped in
 * `withApiToken(scope, handler)` and only when the token carries that scope.
 * The wrapper resolves the token and runs the handler with the owner's session
 * available through `getSession()`, so the handler and every helper it calls
 * go through the same access checks as the browser. A handler that is not
 * wrapped (billing, settings, token management, admin) never looks at the
 * header, and `getSession()` there is exactly `auth()`: new routes are closed
 * to tokens until someone decides otherwise.
 *
 * Tokens are 256 bits of randomness, so a plain SHA-256 is enough to store them:
 * there is no dictionary to run against the digest, which is what a slow hash
 * like bcrypt exists to defend. A fast hash also lets the lookup be a unique
 * index hit instead of a scan.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import type { Session } from 'next-auth';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { apiErrors } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { isApiTokenScope, type ApiTokenScope } from '@/lib/api-token-scopes';

/** Every token starts with this, so a secret scanner can recognise one in a leak. */
export const API_TOKEN_PREFIX = 'of_pat_';

/** Characters of the token kept in plaintext for the settings list. */
export const API_TOKEN_DISPLAY_PREFIX_LENGTH = API_TOKEN_PREFIX.length + 6;

export const MAX_API_TOKENS_PER_USER = 10;
export { MAX_API_TOKEN_NAME_LENGTH } from '@/lib/api-token-scopes';

/**
 * lastUsedAt is written at most this often per token. A script uploading one
 * version makes four or five authenticated calls in a few seconds, and a write
 * on each would turn every read into a write for no information gained.
 */
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;

/** How long the session a token stands in for claims to last. Nothing reads it. */
const TOKEN_SESSION_LIFETIME_MS = 60 * 1000;

const TOKEN_BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateApiToken(): { token: string; tokenHash: string; prefix: string } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    token,
    tokenHash: hashApiToken(token),
    prefix: token.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH),
  };
}

/**
 * The token out of `Authorization: Bearer of_pat_...`, or null when the request
 * carries no OpenFrame token. A value that has the prefix but is otherwise
 * malformed comes back as an empty string, so the caller can tell "no token
 * sent" (fall back to the session) from "a bad token sent" (refuse).
 *
 * Any other Authorization header counts as no token. A self-hosted instance
 * behind HTTP basic auth, or behind a proxy that forwards its own bearer, has
 * the browser attach that header to every request, and treating it as a failed
 * token would lock every signed-in user out.
 */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;

  const [scheme, value, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !value?.startsWith(API_TOKEN_PREFIX)) return null;
  if (rest.length > 0) return '';
  if (!TOKEN_BODY_PATTERN.test(value.slice(API_TOKEN_PREFIX.length))) return '';
  return value;
}

export interface ResolvedApiToken {
  scopes: ApiTokenScope[];
  session: Session;
}

/** The owner and scopes of a token, or null when it matches nothing. */
export async function resolveApiToken(token: string): Promise<ResolvedApiToken | null> {
  const row = await db.apiToken.findUnique({
    where: { tokenHash: hashApiToken(token) },
    select: {
      id: true,
      scopes: true,
      lastUsedAt: true,
      user: { select: { id: true, name: true, email: true, image: true } },
    },
  });
  if (!row) return null;

  const now = Date.now();
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    // Not awaited: this is bookkeeping, and a failed write must not turn a call
    // that has already been authenticated into a 500. updateMany rather than
    // update, so a token revoked in between is a no-op and not an error.
    db.apiToken
      .updateMany({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } })
      .catch((error: unknown) => logError('Failed to record API token use:', error));
  }

  const session = {
    user: {
      id: row.user.id,
      name: row.user.name,
      email: row.user.email,
      image: row.user.image,
      // Admin rights come from the signed-in email and are never extended to a
      // token, and no admin route is wrapped anyway.
      isAdmin: false,
    },
    expires: new Date(now + TOKEN_SESSION_LIFETIME_MS).toISOString(),
  } as Session;

  return { scopes: (row.scopes ?? []).filter(isApiTokenScope), session };
}

interface TokenContext {
  session: Session;
  scopes: readonly ApiTokenScope[];
}

const tokenContextStore = new AsyncLocalStorage<TokenContext>();

/**
 * The caller's session: the token owner's inside a handler that a valid token
 * reached through `withApiToken`, the browser session everywhere else.
 */
export async function getSession(): Promise<Session | null> {
  return tokenContextStore.getStore()?.session ?? auth();
}

/**
 * A 403 when the current request came in on a token that lacks `scope`, null
 * otherwise (a browser session, or a token that has it).
 *
 * For the few handlers that do several different jobs behind one method, where
 * the scope on the wrapper can only say "one of these" and the handler has to
 * narrow it once it knows which job it was asked for.
 */
export function apiTokenScopeRefusal(scope: ApiTokenScope): Response | null {
  if (!apiTokenLacksScope(scope)) return null;
  return apiErrors.forbidden(`This API token does not have the "${scope}" permission`);
}

/** True only when the current request came in on a token that lacks `scope`. */
export function apiTokenLacksScope(scope: ApiTokenScope): boolean {
  const context = tokenContextStore.getStore();
  return Boolean(context && !context.scopes.includes(scope));
}

// A few handlers are typed as possibly returning undefined; the wrapper passes
// whatever they return straight through.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteHandler = (...args: any[]) => Promise<Response | undefined> | Response | undefined;

/** Where a wrapped handler records the scopes it accepts, for the route classification test. */
export const API_TOKEN_SCOPES_KEY = Symbol.for('openframe.apiTokenScopes');

/**
 * Opens a route handler to personal access tokens that carry one of `scope`.
 *
 * A request with no OpenFrame token runs the handler untouched. A request with
 * one never falls back to a session cookie sent alongside it: a wrong or
 * revoked token is a 401 and a token without the scope a 403. A share-link
 * cookie is a different matter; it is a credential of its own and adds what
 * the link grants, exactly as it does for a signed-in browser. Falling back would let a script with a revoked token keep
 * working for as long as someone happens to be signed in on the same machine,
 * and would hide the revocation from the person who made it.
 */
export function withApiToken<H extends RouteHandler>(
  scope: ApiTokenScope | readonly ApiTokenScope[],
  handler: H
): H {
  const accepted: readonly ApiTokenScope[] = typeof scope === 'string' ? [scope] : scope;

  const wrapped = async (...args: Parameters<H>): Promise<Response | undefined> => {
    const request = args[0] as Request;
    const token = readBearerToken(request);
    if (token === null) return handler(...args);

    let resolved: ResolvedApiToken | null = null;
    if (token) {
      try {
        resolved = await resolveApiToken(token);
      } catch (error) {
        // Outside the handler's own try/catch, so answer in the API's shape here
        // rather than letting Next.js turn it into a bare 500.
        logError('Failed to resolve API token:', error);
        return apiErrors.internalError('Failed to check the API token');
      }
    }
    if (!resolved) {
      return (await rateLimit(request, 'api-token-refused')) ?? apiErrors.unauthorized();
    }

    if (!accepted.some((candidate) => resolved.scopes.includes(candidate))) {
      const names = accepted.map((candidate) => `"${candidate}"`).join(' or ');
      return (
        (await rateLimit(request, 'api-token-refused')) ??
        apiErrors.forbidden(`This API token does not have the ${names} permission`)
      );
    }

    return tokenContextStore.run(resolved, () => handler(...args));
  };

  Object.defineProperty(wrapped, API_TOKEN_SCOPES_KEY, { value: accepted });
  return wrapped as unknown as H;
}
