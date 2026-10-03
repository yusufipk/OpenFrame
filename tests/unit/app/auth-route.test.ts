// The NextAuth POST handler limits password attempts per IP. It used to count
// every POST, so starting a Google sign-in a few times from one address locked
// that whole address out of signing in for fifteen minutes.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const rateLimit = vi.fn();
const authPost = vi.fn();

vi.mock('@/lib/rate-limit', () => ({ rateLimit: (...args: unknown[]) => rateLimit(...args) }));
vi.mock('@/lib/auth', () => ({
  handlers: { GET: vi.fn(), POST: (...args: unknown[]) => authPost(...args) },
}));

const { POST } = await import('@/app/api/auth/[...nextauth]/route');

function post(path: string) {
  return new Request(`https://open-frame.net${path}`, { method: 'POST' });
}

beforeEach(() => {
  rateLimit.mockReset().mockResolvedValue(null);
  authPost.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
});

describe('NextAuth POST rate limiting', () => {
  it.each([
    '/api/auth/signin/google',
    '/api/auth/signin/github',
    '/api/auth/signout',
    '/api/auth/session',
  ])('does not count %s', async (path) => {
    await POST(post(path));

    expect(rateLimit).not.toHaveBeenCalled();
    expect(authPost).toHaveBeenCalledOnce();
  });

  it.each([
    '/api/auth/callback/credentials',
    '/api/auth/callback/credentials/',
    '/api/auth//callback//credentials',
    '/api/auth/unknown',
  ])('counts %s', async (path) => {
    await POST(post(path));

    expect(rateLimit).toHaveBeenCalledWith(expect.any(Request), 'login');
  });

  it('returns the limiter response without reaching Auth.js', async () => {
    rateLimit.mockResolvedValue(new Response(null, { status: 429 }));

    const response = await POST(post('/api/auth/callback/credentials'));

    expect(response.status).toBe(429);
    expect(authPost).not.toHaveBeenCalled();
  });

  it('passes a redirect from Auth.js through with Cache-Control set', async () => {
    // Auth.js answers a failed password POST without JavaScript with
    // Response.redirect(), whose headers are immutable. Setting Cache-Control on it
    // threw and turned the redirect into a 500.
    authPost.mockResolvedValue(
      Response.redirect('https://open-frame.net/login?error=CredentialsSignin', 302)
    );

    const response = await POST(post('/api/auth/callback/credentials'));

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      'https://open-frame.net/login?error=CredentialsSignin'
    );
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
