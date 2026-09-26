import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyLiveReviewComments } from '@/lib/live-review/notify';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('live comment notification', () => {
  it('does not make requests while disabled', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_LIVE_REVIEW', 'false');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await notifyLiveReviewComments('version-one');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends only a version invalidation and tolerates transport failure', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_LIVE_REVIEW', 'true');
    vi.stubEnv('LIVE_REVIEW_SECRET', 'test-notification-secret');
    vi.stubEnv('LIVE_REVIEW_INTERNAL_URL', 'http://review:3101');
    vi.stubEnv('LIVE_REVIEW_PUBLIC_URL', 'wss://review.example.com');
    const fetchMock = vi.fn().mockRejectedValue(new Error('Disconnected'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(notifyLiveReviewComments('version-one')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe('http://review:3101/comments');
    expect(JSON.parse(options.body)).toEqual({ versionId: 'version-one' });
    expect(options.headers['X-Live-Review-Secret']).toBe('test-notification-secret');
  });
});
