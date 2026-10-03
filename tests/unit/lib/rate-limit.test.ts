import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RATE_LIMIT_CONFIGS,
  checkRateLimit,
  getClientIp,
  rateLimit,
  rateLimitHeaders,
} from '@/lib/rate-limit';

const dbMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: dbMock, default: dbMock, disconnectDb: vi.fn() }));

function requestWith(headers: Record<string, string>): Request {
  return new Request('https://example.com/api/comments', { headers });
}

/**
 * The interpolated values of the most recent `$queryRaw` tagged template, in order:
 * the stored key, the stored action, then the window length twice.
 */
function valuesOfLastQuery(): unknown[] {
  const calls = dbMock.$queryRaw.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('no $queryRaw call was recorded');
  return last.slice(1);
}

beforeEach(() => {
  vi.stubEnv('TRUSTED_PROXY_MODE', undefined);
  vi.stubEnv('DISABLE_RATE_LIMIT', undefined);
  dbMock.$queryRaw.mockReset();
  dbMock.$executeRaw.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getClientIp without TRUSTED_PROXY_MODE', () => {
  it('ignores every proxy header and returns the loopback address', () => {
    const request = requestWith({
      'cf-connecting-ip': '203.0.113.7',
      'x-real-ip': '203.0.113.8',
      'x-forwarded-for': '203.0.113.9',
    });

    expect(getClientIp(request)).toBe('127.0.0.1');
  });

  it('returns the loopback address when no headers are present at all', () => {
    expect(getClientIp(requestWith({}))).toBe('127.0.0.1');
  });

  it('ignores an unrecognised proxy mode', () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'apache');
    expect(getClientIp(requestWith({ 'x-real-ip': '203.0.113.8' }))).toBe('127.0.0.1');
  });
});

describe('getClientIp in cloudflare mode', () => {
  beforeEach(() => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'cloudflare');
  });

  it('trusts cf-connecting-ip', () => {
    expect(getClientIp(requestWith({ 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('normalises a padded and mixed-case mode value', () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', '  CloudFlare  ');
    expect(getClientIp(requestWith({ 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('does not fall back to x-forwarded-for, which a client can set', () => {
    const request = requestWith({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.8' });
    expect(getClientIp(request)).toBe('127.0.0.1');
  });

  it('rejects an implausible cf-connecting-ip rather than trusting it', () => {
    expect(getClientIp(requestWith({ 'cf-connecting-ip': 'not-an-ip' }))).toBe('127.0.0.1');
  });

  it('rejects a cf-connecting-ip longer than 45 characters', () => {
    const tooLong = '1'.repeat(46);
    expect(getClientIp(requestWith({ 'cf-connecting-ip': tooLong }))).toBe('127.0.0.1');
  });

  it('accepts an IPv6 address', () => {
    expect(getClientIp(requestWith({ 'cf-connecting-ip': '2001:db8::1' }))).toBe('2001:db8::1');
  });
});

describe('getClientIp in nginx mode', () => {
  beforeEach(() => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'nginx');
  });

  it('prefers x-real-ip over x-forwarded-for', () => {
    const request = requestWith({ 'x-real-ip': '203.0.113.8', 'x-forwarded-for': '203.0.113.9' });
    expect(getClientIp(request)).toBe('203.0.113.8');
  });

  it('takes the last x-forwarded-for entry so a spoofed prefix is ignored', () => {
    const request = requestWith({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.9' });
    expect(getClientIp(request)).toBe('203.0.113.9');
  });

  it('trims whitespace around the last x-forwarded-for entry', () => {
    expect(getClientIp(requestWith({ 'x-forwarded-for': '1.1.1.1,   203.0.113.9   ' }))).toBe(
      '203.0.113.9'
    );
  });

  it('handles a single-entry x-forwarded-for', () => {
    expect(getClientIp(requestWith({ 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('falls back to x-forwarded-for when x-real-ip is implausible', () => {
    const request = requestWith({
      'x-real-ip': 'evil<script>',
      'x-forwarded-for': '203.0.113.9',
    });
    expect(getClientIp(request)).toBe('203.0.113.9');
  });

  it('returns the loopback address when the last x-forwarded-for entry is implausible', () => {
    expect(getClientIp(requestWith({ 'x-forwarded-for': '203.0.113.9, bogus-host' }))).toBe(
      '127.0.0.1'
    );
  });

  it('rejects an x-real-ip carrying a SQL fragment', () => {
    const request = requestWith({ 'x-real-ip': "1.2.3.4'; DROP TABLE rate_limits; --" });
    expect(getClientIp(request)).toBe('127.0.0.1');
  });

  it('accepts a bare hex string because IP_PATTERN is only a loose shape check', () => {
    // Documents the deliberate looseness: the pattern guards the length and the
    // character set, it is not a full IP parser.
    expect(getClientIp(requestWith({ 'x-real-ip': 'dead' }))).toBe('dead');
  });
});

describe('rateLimitHeaders', () => {
  it('renders the limit, the remaining count and the reset as unix seconds', () => {
    const result = {
      allowed: true,
      remaining: 7,
      resetAt: new Date('2026-01-15T00:00:00.000Z'),
    };

    expect(rateLimitHeaders(result, 15)).toEqual({
      'X-RateLimit-Limit': '15',
      'X-RateLimit-Remaining': '7',
      'X-RateLimit-Reset': '1768435200',
    });
  });

  it('floors sub-second precision on the reset timestamp', () => {
    const result = {
      allowed: false,
      remaining: 0,
      resetAt: new Date('2026-01-15T00:00:00.999Z'),
    };

    const headers = rateLimitHeaders(result, 1) as Record<string, string>;

    expect(headers['X-RateLimit-Reset']).toBe('1768435200');
  });
});

describe('RATE_LIMIT_CONFIGS', () => {
  const entries = Object.entries(RATE_LIMIT_CONFIGS);

  it('is not empty', () => {
    expect(entries.length).toBeGreaterThan(20);
  });

  it.each(entries)('%s has a positive window and a positive request cap', (_action, config) => {
    expect(config.windowMs).toBeGreaterThan(0);
    expect(config.maxRequests).toBeGreaterThan(0);
    expect(Number.isInteger(config.maxRequests)).toBe(true);
    expect(config.windowMs % 1000).toBe(0);
  });

  it('defines the api fallback that unknown actions resolve to', () => {
    expect(RATE_LIMIT_CONFIGS.api).toEqual({ windowMs: 60_000, maxRequests: 100 });
  });

  // "Download all" paces itself to 100 asset requests per 61 s and a project download
  // sends one version request per video. Single-digit limits here stopped both part way.
  it('pins the download buckets at the sizes a bulk download was tuned for', () => {
    expect(RATE_LIMIT_CONFIGS['asset-download']).toEqual({ windowMs: 60_000, maxRequests: 120 });
    expect(RATE_LIMIT_CONFIGS['video-download']).toEqual({ windowMs: 60_000, maxRequests: 60 });
    expect(RATE_LIMIT_CONFIGS['video-download-prepare']).toEqual({
      windowMs: 60_000,
      maxRequests: 30,
    });
  });

  it('keeps auth actions stricter per minute than the general api bucket', () => {
    const perMinute = (action: string) =>
      (RATE_LIMIT_CONFIGS[action].maxRequests / RATE_LIMIT_CONFIGS[action].windowMs) * 60_000;

    expect(perMinute('login')).toBeLessThan(perMinute('api'));
    expect(perMinute('register')).toBeLessThan(perMinute('login'));
  });
});

describe('checkRateLimit', () => {
  const windowStart = new Date('2026-01-15T00:00:00.000Z');

  function rowsWithCount(count: number) {
    return [{ count, window_start: windowStart, is_new_window: false }];
  }

  it('allows without querying the database when DISABLE_RATE_LIMIT is set', async () => {
    vi.stubEnv('DISABLE_RATE_LIMIT', '1');

    const result = await checkRateLimit('1.2.3.4', 'comment');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(RATE_LIMIT_CONFIGS.comment.maxRequests);
    expect(dbMock.$queryRaw).not.toHaveBeenCalled();
  });

  it.each(['1', 'true', 'YES', ' on '])('treats DISABLE_RATE_LIMIT=%s as disabled', async (raw) => {
    vi.stubEnv('DISABLE_RATE_LIMIT', raw);
    await checkRateLimit('1.2.3.4', 'comment');
    expect(dbMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('still enforces the limit for a non-truthy DISABLE_RATE_LIMIT value', async () => {
    vi.stubEnv('DISABLE_RATE_LIMIT', 'false');
    dbMock.$queryRaw.mockResolvedValue(rowsWithCount(1));

    await checkRateLimit('1.2.3.4', 'comment');

    expect(dbMock.$queryRaw).toHaveBeenCalledTimes(1);
  });

  // A key wider than rate_limits.key used to be skipped, which meant no limit applied at
  // all. It is hashed instead, so the query still runs and the caller is still counted.
  it('hashes a key wider than the column instead of skipping the query', async () => {
    dbMock.$queryRaw.mockResolvedValue(rowsWithCount(1));

    await checkRateLimit('k'.repeat(256), 'comment');

    expect(dbMock.$queryRaw).toHaveBeenCalledTimes(1);
    const storedKey = valuesOfLastQuery()[0] as string;
    expect(storedKey).toBe(createHash('sha256').update('k'.repeat(256)).digest('hex'));
    expect(storedKey.length).toBeLessThanOrEqual(255);
  });

  it('gives the same over-long key the same bucket every time', async () => {
    dbMock.$queryRaw.mockResolvedValue(rowsWithCount(1));

    await checkRateLimit('k'.repeat(300), 'comment');
    const first = valuesOfLastQuery()[0];
    await checkRateLimit('k'.repeat(300), 'comment');
    const second = valuesOfLastQuery()[0];

    expect(first).toBe(second);
  });

  it('gives two different over-long keys different buckets', async () => {
    dbMock.$queryRaw.mockResolvedValue(rowsWithCount(1));

    await checkRateLimit(`a${'k'.repeat(300)}`, 'comment');
    const first = valuesOfLastQuery()[0];
    await checkRateLimit(`b${'k'.repeat(300)}`, 'comment');
    const second = valuesOfLastQuery()[0];

    expect(first).not.toBe(second);
  });

  it('passes a key that fits the column through untouched', async () => {
    dbMock.$queryRaw.mockResolvedValue(rowsWithCount(1));

    await checkRateLimit('k'.repeat(255), 'comment');

    expect(valuesOfLastQuery()[0]).toBe('k'.repeat(255));
  });

  it('hashes an action wider than its narrower column', async () => {
    dbMock.$queryRaw.mockResolvedValue(rowsWithCount(1));

    await checkRateLimit('1.2.3.4', 'a'.repeat(51));

    expect(dbMock.$queryRaw).toHaveBeenCalledTimes(1);
    const storedAction = valuesOfLastQuery()[1] as string;
    expect(storedAction).toBe(
      createHash('sha256').update('a'.repeat(51)).digest('hex').slice(0, 50)
    );
    expect(storedAction.length).toBe(50);
  });

  it('passes an action that fits its column through untouched', async () => {
    dbMock.$queryRaw.mockResolvedValue(rowsWithCount(1));

    await checkRateLimit('1.2.3.4', 'comment');

    expect(valuesOfLastQuery()[1]).toBe('comment');
  });

  it('reports the remaining budget and the reset instant from the stored window', async () => {
    dbMock.$queryRaw.mockResolvedValue(rowsWithCount(4));

    const result = await checkRateLimit('1.2.3.4', 'comment');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(RATE_LIMIT_CONFIGS.comment.maxRequests - 4);
    expect(result.resetAt.toISOString()).toBe('2026-01-15T00:01:00.000Z');
  });

  it('still allows the request that lands exactly on the cap', async () => {
    dbMock.$queryRaw.mockResolvedValue(rowsWithCount(RATE_LIMIT_CONFIGS.comment.maxRequests));

    const result = await checkRateLimit('1.2.3.4', 'comment');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it('blocks the first request past the cap and never reports a negative remainder', async () => {
    dbMock.$queryRaw.mockResolvedValue(rowsWithCount(RATE_LIMIT_CONFIGS.comment.maxRequests + 3));

    const result = await checkRateLimit('1.2.3.4', 'comment');

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('falls back to the api bucket for an unknown action', async () => {
    dbMock.$queryRaw.mockResolvedValue(rowsWithCount(1));

    const result = await checkRateLimit('1.2.3.4', 'action-that-does-not-exist');

    expect(result.remaining).toBe(RATE_LIMIT_CONFIGS.api.maxRequests - 1);
  });

  it('prefers an explicitly supplied config over the table', async () => {
    dbMock.$queryRaw.mockResolvedValue(rowsWithCount(2));

    const result = await checkRateLimit('1.2.3.4', 'comment', {
      windowMs: 10_000,
      maxRequests: 3,
    });

    expect(result.remaining).toBe(1);
    expect(result.resetAt.toISOString()).toBe('2026-01-15T00:00:10.000Z');
  });

  it('fails open when the rate limit table query throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.$queryRaw.mockRejectedValue(new Error('relation "rate_limits" does not exist'));

    const result = await checkRateLimit('1.2.3.4', 'comment');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(RATE_LIMIT_CONFIGS.comment.maxRequests);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe('rateLimit', () => {
  it('returns null while the caller is under the cap', async () => {
    dbMock.$queryRaw.mockResolvedValue([
      { count: 1, window_start: new Date('2026-01-15T00:00:00.000Z'), is_new_window: true },
    ]);

    expect(await rateLimit(requestWith({}), 'comment')).toBeNull();
  });

  it('returns a 429 with rate limit headers once the cap is passed', async () => {
    dbMock.$queryRaw.mockResolvedValue([
      { count: 99, window_start: new Date('2026-01-15T00:00:00.000Z'), is_new_window: false },
    ]);

    const response = await rateLimit(requestWith({}), 'comment');

    expect(response?.status).toBe(429);
    expect(response?.headers.get('X-RateLimit-Limit')).toBe(
      String(RATE_LIMIT_CONFIGS.comment.maxRequests)
    );
    expect(response?.headers.get('X-RateLimit-Remaining')).toBe('0');
    await expect(response?.json()).resolves.toEqual({
      error: 'Too many requests. Please try again later.',
    });
  });

  it('keys the limit on the resolved client ip', async () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'nginx');
    dbMock.$queryRaw.mockResolvedValue([
      { count: 1, window_start: new Date('2026-01-15T00:00:00.000Z'), is_new_window: true },
    ]);

    await rateLimit(requestWith({ 'x-real-ip': '203.0.113.8' }), 'comment');

    const values = dbMock.$queryRaw.mock.calls[0].slice(1);
    expect(values).toContain('203.0.113.8');
  });
});
