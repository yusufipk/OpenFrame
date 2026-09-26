import { liveReviewAvailable } from '@/lib/live-review/config';

/** Comments remain durable even when their live notification cannot be delivered. */
export async function notifyLiveReviewComments(versionId: string): Promise<void> {
  if (!liveReviewAvailable()) return;
  try {
    await fetch(new URL('/comments', process.env.LIVE_REVIEW_INTERNAL_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Live-Review-Secret': process.env.LIVE_REVIEW_SECRET!,
      },
      body: JSON.stringify({ versionId }),
      signal: AbortSignal.timeout(1000),
      cache: 'no-store',
    });
  } catch {
    // Polling and reconnect snapshots recover a missed notification.
  }
}
