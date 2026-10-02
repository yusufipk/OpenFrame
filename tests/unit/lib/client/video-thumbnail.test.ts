import { describe, expect, it } from 'vitest';
import { withRetryParam } from '@/lib/client/video-thumbnail';

describe('withRetryParam', () => {
  it('leaves the URL alone before the first retry', () => {
    expect(withRetryParam('https://cdn.test/a/thumbnail.jpg', 0)).toBe(
      'https://cdn.test/a/thumbnail.jpg'
    );
  });

  it('starts a query string on an unsigned URL', () => {
    expect(withRetryParam('https://cdn.test/a/thumbnail.jpg', 3)).toBe(
      'https://cdn.test/a/thumbnail.jpg?t=3'
    );
  });

  it('extends the query string of a signed URL instead of corrupting its expiry', () => {
    expect(
      withRetryParam('https://cdn.test/a/thumbnail.jpg?token=HS256-x&expires=1700000000', 3)
    ).toBe('https://cdn.test/a/thumbnail.jpg?token=HS256-x&expires=1700000000&t=3');
  });
});
