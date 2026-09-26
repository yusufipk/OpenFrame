// Run as a file because container healthcheck forms can reject inline JavaScript.
export {};

const secret = process.env.LIVE_REVIEW_SECRET;
const port = process.env.LIVE_REVIEW_PORT || '3101';

if (!secret || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  process.exit(1);
}

try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { 'x-live-review-secret': secret },
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  process.exit(response.status === 204 ? 0 : 1);
} catch {
  process.exit(1);
}
