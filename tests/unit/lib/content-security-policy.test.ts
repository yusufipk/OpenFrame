import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildContentSecurityPolicy } from '@/lib/content-security-policy';

const MANAGED_ENV = [
  'BUNNY_CDN_URL',
  'NEXT_PUBLIC_BUNNY_CDN_URL',
  'R2_ENDPOINT',
  'R2_PRESIGN_ENDPOINT',
  'R2_PUBLIC_BASE_URL',
  'R2_ACCOUNT_ID',
  'R2_BUCKET_NAME',
  'OPENFRAME_ENABLE_LIVE_REVIEW',
  'LIVE_REVIEW_PUBLIC_URL',
];

function directives(): Record<string, string[]> {
  const entries = buildContentSecurityPolicy()
    .split('; ')
    .map((part) => {
      const [name, ...values] = part.split(' ');
      return [name, values] as const;
    });

  return Object.fromEntries(entries);
}

beforeEach(() => {
  for (const name of MANAGED_ENV) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv('NODE_ENV', 'production');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildContentSecurityPolicy', () => {
  it('allows only the configured live WebSocket origin when enabled', () => {
    vi.stubEnv('LIVE_REVIEW_PUBLIC_URL', 'wss://review.example.com/socket');
    expect(directives()['connect-src']).not.toContain('wss://review.example.com');
    vi.stubEnv('OPENFRAME_ENABLE_LIVE_REVIEW', 'true');
    expect(directives()['connect-src']).toContain('wss://review.example.com');
    expect(directives()['connect-src']).not.toContain('wss:');
    vi.stubEnv('LIVE_REVIEW_PUBLIC_URL', 'https://review.example.com');
    expect(directives()['connect-src']).not.toContain('https://review.example.com');
  });

  it('locks down the directives that never depend on configuration', () => {
    const csp = directives();

    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['font-src']).toEqual(["'self'"]);
    expect(csp['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp['worker-src']).toEqual(["'self'", 'blob:']);
  });

  it('emits exactly one entry per directive name', () => {
    const parts = buildContentSecurityPolicy().split('; ');
    const names = parts.map((part) => part.split(' ')[0]);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(13);
  });

  it.each(['production', 'development', 'test'])(
    'never allows unsafe-eval with NODE_ENV=%s',
    (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      expect(buildContentSecurityPolicy()).not.toContain('unsafe-eval');
    }
  );

  it('allows the inline hydration scripts and the YouTube iframe API in script-src', () => {
    expect(directives()['script-src']).toEqual([
      "'self'",
      "'unsafe-inline'",
      'https://www.youtube.com',
    ]);
  });

  it('allows the YouTube and Bunny iframe hosts in frame-src', () => {
    expect(directives()['frame-src']).toEqual([
      "'self'",
      'https://www.youtube.com',
      'https://iframe.mediadelivery.net',
    ]);
  });

  it('omits any Bunny CDN origin when none is configured', () => {
    const csp = directives();

    expect(csp['media-src']).toEqual(["'self'", 'blob:']);
    expect(csp['img-src']).toEqual([
      "'self'",
      'data:',
      'blob:',
      'https://img.youtube.com',
      'https://i.ytimg.com',
      'https://images.unsplash.com',
      'https://vz-thumbnail.b-cdn.net',
    ]);
    expect(csp['connect-src'].filter((src) => src.includes('b-cdn.net'))).toEqual([]);
    // An empty cdnOrigin must be filtered out rather than left as a bare token.
    expect(csp['connect-src']).not.toContain('');
  });

  it('adds a configured Bunny CDN origin to connect-src, img-src and media-src', () => {
    vi.stubEnv('BUNNY_CDN_URL', 'https://cdn.example.b-cdn.net');
    const csp = directives();

    expect(csp['connect-src']).toContain('https://cdn.example.b-cdn.net');
    expect(csp['img-src']).toContain('https://cdn.example.b-cdn.net');
    expect(csp['media-src']).toContain('https://cdn.example.b-cdn.net');
  });

  it('strips a path and trailing slash from the Bunny CDN url', () => {
    vi.stubEnv('BUNNY_CDN_URL', 'https://cdn.example.b-cdn.net/videos/');

    expect(directives()['media-src']).toContain('https://cdn.example.b-cdn.net');
  });

  it('upgrades a protocol-less Bunny CDN host to https', () => {
    vi.stubEnv('BUNNY_CDN_URL', 'cdn.example.b-cdn.net');

    expect(directives()['media-src']).toContain('https://cdn.example.b-cdn.net');
  });

  it('falls back to the public Bunny CDN variable', () => {
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', 'https://public.b-cdn.net');

    expect(directives()['media-src']).toContain('https://public.b-cdn.net');
  });

  it('prefers the server Bunny CDN variable when both are set', () => {
    vi.stubEnv('BUNNY_CDN_URL', 'https://server.b-cdn.net');
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', 'https://public.b-cdn.net');
    const mediaSrc = directives()['media-src'];

    expect(mediaSrc).toContain('https://server.b-cdn.net');
    expect(mediaSrc).not.toContain('https://public.b-cdn.net');
  });

  it('allows the local MinIO defaults in connect-src outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const connectSrc = directives()['connect-src'];

    expect(connectSrc).toContain('http://localhost:9000');
    expect(connectSrc).toContain('http://127.0.0.1:9000');
  });

  // They are a local development convenience, and allowing plaintext loopback object
  // storage in every deployment weakened the policy for a case production never has.
  it('drops the local MinIO defaults from connect-src in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const connectSrc = directives()['connect-src'];

    expect(connectSrc).not.toContain('http://localhost:9000');
    expect(connectSrc).not.toContain('http://127.0.0.1:9000');
  });

  it('still allows a loopback R2_ENDPOINT in production when one is configured', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('R2_ENDPOINT', 'http://127.0.0.1:9000');

    expect(directives()['connect-src']).toContain('http://127.0.0.1:9000');
  });

  it('reduces a custom R2 endpoint to its origin', () => {
    vi.stubEnv('R2_ENDPOINT', 'https://minio.internal:9443/openframe-bucket');

    expect(directives()['connect-src']).toContain('https://minio.internal:9443');
  });

  it('includes the presign and public base origins', () => {
    vi.stubEnv('R2_PRESIGN_ENDPOINT', 'https://presign.example.com');
    vi.stubEnv('R2_PUBLIC_BASE_URL', 'https://public.example.com/assets');
    const connectSrc = directives()['connect-src'];

    expect(connectSrc).toContain('https://presign.example.com');
    expect(connectSrc).toContain('https://public.example.com');
  });

  it('deduplicates identical R2 origins', () => {
    vi.stubEnv('R2_ENDPOINT', 'https://minio.internal:9443/bucket-a');
    vi.stubEnv('R2_PRESIGN_ENDPOINT', 'https://minio.internal:9443/bucket-b');
    const occurrences = directives()['connect-src'].filter(
      (src) => src === 'https://minio.internal:9443'
    );

    expect(occurrences).toHaveLength(1);
  });

  it('ignores an unparseable R2 endpoint instead of throwing', () => {
    vi.stubEnv('R2_ENDPOINT', 'not a url at all');

    expect(() => buildContentSecurityPolicy()).not.toThrow();
    expect(directives()['connect-src']).not.toContain('not');
  });

  it('derives the Cloudflare R2 hosts from the account id', () => {
    vi.stubEnv('R2_ACCOUNT_ID', 'acct123');
    const connectSrc = directives()['connect-src'];

    expect(connectSrc).toContain('https://acct123.r2.cloudflarestorage.com');
    expect(connectSrc).toContain('https://*.r2.cloudflarestorage.com');
  });

  it('adds the bucket-scoped Cloudflare R2 host when a bucket name is set', () => {
    vi.stubEnv('R2_ACCOUNT_ID', 'acct123');
    vi.stubEnv('R2_BUCKET_NAME', 'openframe');

    expect(directives()['connect-src']).toContain(
      'https://openframe.acct123.r2.cloudflarestorage.com'
    );
  });

  it('does not emit a Cloudflare R2 host from a bucket name alone', () => {
    vi.stubEnv('R2_BUCKET_NAME', 'openframe');

    expect(
      directives()['connect-src'].some((src) => src.includes('r2.cloudflarestorage.com'))
    ).toBe(false);
  });

  it('allows the Next.js HMR websocket only in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(buildContentSecurityPolicy()).toContain('ws://localhost:*');

    vi.stubEnv('NODE_ENV', 'production');
    expect(buildContentSecurityPolicy()).not.toContain('ws://localhost:*');
  });

  it('keeps the YouTube thumbnail hosts in img-src', () => {
    const imgSrc = directives()['img-src'];

    expect(imgSrc).toContain('https://img.youtube.com');
    expect(imgSrc).toContain('https://i.ytimg.com');
    expect(imgSrc).toContain('data:');
    expect(imgSrc).toContain('blob:');
  });
});
