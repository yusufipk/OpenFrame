import type { NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { apiErrors, successResponse } from '@/lib/api-response';
import { refreshLiveParticipantAccess } from '@/lib/live-review/access';

export async function POST(request: NextRequest) {
  const secret = process.env.LIVE_REVIEW_SECRET;
  const supplied = request.headers.get('x-live-review-secret');
  if (!secret || !supplied) return apiErrors.forbidden();
  const a = Buffer.from(secret);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return apiErrors.forbidden();
  let body: { participantId?: unknown };
  try {
    body = (await request.json()) as { participantId?: unknown };
  } catch {
    return apiErrors.badRequest();
  }
  if (typeof body.participantId !== 'string' || body.participantId.length > 128)
    return apiErrors.badRequest();
  return successResponse(await refreshLiveParticipantAccess(body.participantId));
}
