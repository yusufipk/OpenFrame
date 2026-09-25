export function liveReviewEnabled(): boolean {
  return process.env.OPENFRAME_ENABLE_LIVE_REVIEW === 'true';
}

export function liveReviewPublicUrl(): string | null {
  const value = process.env.LIVE_REVIEW_PUBLIC_URL;
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'wss:' ||
      (url.protocol === 'ws:' && (process.env.NODE_ENV !== 'production' || loopback))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function liveReviewAvailable(): boolean {
  return (
    liveReviewEnabled() &&
    Boolean(
      process.env.LIVE_REVIEW_SECRET &&
      process.env.LIVE_REVIEW_INTERNAL_URL &&
      liveReviewPublicUrl()
    )
  );
}

export async function liveReviewHealthy(): Promise<boolean> {
  if (!liveReviewAvailable()) return false;
  try {
    const response = await fetch(new URL('/health', process.env.LIVE_REVIEW_INTERNAL_URL), {
      headers: { 'x-live-review-secret': process.env.LIVE_REVIEW_SECRET! },
      signal: AbortSignal.timeout(1000),
      cache: 'no-store',
    });
    return response.status === 204;
  } catch {
    return false;
  }
}
