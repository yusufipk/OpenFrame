import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { apiErrors, successResponse } from '@/lib/api-response';
import { checkRateLimit, rateLimitHeaders, RATE_LIMIT_CONFIGS } from '@/lib/rate-limit';

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return apiErrors.unauthorized();
  }

  const cfg = RATE_LIMIT_CONFIGS['onboarding-complete'];
  const rl = await checkRateLimit(session.user.id, 'onboarding-complete', cfg);
  if (!rl.allowed) {
    return new Response(JSON.stringify({ error: 'Too many requests. Please try again later.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', ...rateLimitHeaders(rl, cfg.maxRequests) },
    });
  }

  await db.user.update({
    where: { id: session.user.id },
    data: { onboardingCompletedAt: new Date() },
  });

  return successResponse({ completed: true });
}
