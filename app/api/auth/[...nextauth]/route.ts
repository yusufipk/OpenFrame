import { handlers } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { withCacheControl } from '@/lib/api-response';

export const { GET } = handlers;

const AUTH_BASE_PATH = '/api/auth';

// POST actions that cannot test a password: starting a Google or GitHub sign-in,
// signing out, refreshing the session. Counting them let a few OAuth retries from
// one office lock everyone behind that address out of signing in for fifteen
// minutes.
const UNLIMITED_ACTIONS = new Set(['signin', 'signout', 'session']);

/**
 * Everything else is limited, the credentials callback included. The action is
 * read the way Auth.js reads it (empty segments dropped), so an extra or trailing
 * slash cannot dress a password attempt up as an exempt action.
 */
function isLimitedAction(request: Request): boolean {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(AUTH_BASE_PATH)) return true;
  const [action] = pathname.slice(AUTH_BASE_PATH.length).split('/').filter(Boolean);
  return !UNLIMITED_ACTIONS.has(action);
}

export async function POST(request: Request) {
  if (isLimitedAction(request)) {
    const limited = await rateLimit(request, 'login');
    if (limited) return limited;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await handlers.POST(request as any);
  return withCacheControl(response, 'private, no-store');
}
