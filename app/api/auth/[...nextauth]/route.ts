import { handlers } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { withCacheControl } from '@/lib/api-response';

export const { GET } = handlers;

// Wrap NextAuth POST with login rate limiting
export async function POST(request: Request) {
  const limited = await rateLimit(request, 'login');
  if (limited) return limited;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await handlers.POST(request as any);
  return withCacheControl(response, 'private, no-store');
}
