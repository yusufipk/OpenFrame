import { createHash, randomBytes } from 'node:crypto';
import { db } from '@/lib/db';

export function hashLiveTicket(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function issueLiveTicket(sessionId: string, participantId: string): Promise<string> {
  const ticket = randomBytes(32).toString('base64url');
  await db.liveReviewTicket.create({
    data: {
      tokenHash: hashLiveTicket(ticket),
      sessionId,
      participantId,
      expiresAt: new Date(Date.now() + 30_000),
    },
  });
  return ticket;
}

export async function redeemLiveTicket(
  value: string
): Promise<{ sessionId: string; participantId: string } | null> {
  if (typeof value !== 'string' || value.length > 128 || value.length < 32) return null;
  const now = new Date();
  const tokenHash = hashLiveTicket(value);
  const claimed = await db.liveReviewTicket.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: now }, session: { status: 'active' } },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) return null;
  const row = await db.liveReviewTicket.findUnique({
    where: { tokenHash },
    select: { sessionId: true, participantId: true },
  });
  return row;
}
