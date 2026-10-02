// The proxy is where a visitor gets an identity, and it is the only place that
// can: it runs on the edge, before the page, on every document request.
//
// Two load-bearing details below. The id is written to the *request* as well as
// the response, because a cookie set only on the response is invisible to the
// page rendering that same request, so the very first landing view, the one
// carrying the campaign tags that brought the visitor, would go unrecorded. And
// both cookies are signed, because they are read straight into database columns
// and httpOnly stops JavaScript, not curl.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import {
  ANONYMOUS_ID_COOKIE,
  FIRST_TOUCH_COOKIE,
  readAnonymousIdCookie,
  readFirstTouchCookie,
} from '@/lib/analytics/cookies';

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

function documentRequest(
  url: string,
  init?: { headers?: Record<string, string>; cookies?: Record<string, string> }
) {
  const headers = new Headers({
    'user-agent': BROWSER_UA,
    'sec-fetch-dest': 'document',
    ...init?.headers,
  });
  const cookies = Object.entries(init?.cookies ?? {});
  if (cookies.length > 0) {
    headers.set('cookie', cookies.map(([name, value]) => `${name}=${value}`).join('; '));
  }
  return new NextRequest(new URL(url), { headers });
}

beforeEach(() => {
  vi.stubEnv('NEXTAUTH_SECRET', 'proxy-test-secret');
  // getPublicOrigin prefers a configured origin over the request URL, so the
  // tests that care about the request URL have to start from neither being set.
  vi.stubEnv('NEXTAUTH_URL', undefined);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('proxy', () => {
  it('always sets the content security policy', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'false');

    const response = await proxy(documentRequest('https://open-frame.net/'));

    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('sets no acquisition cookie at all when the flag is off', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'false');

    const response = await proxy(documentRequest('https://open-frame.net/?utm_source=github'));

    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)).toBeUndefined();
    expect(response.cookies.get(FIRST_TOUCH_COOKIE)).toBeUndefined();
  });

  it('gives a new visitor an id and stores what brought them', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
    const request = documentRequest(
      'https://open-frame.net/?utm_source=youtube&utm_medium=video&utm_campaign=launch'
    );

    const response = await proxy(request);

    const cookie = response.cookies.get(ANONYMOUS_ID_COOKIE);
    expect(await readAnonymousIdCookie(cookie?.value)).toMatch(/^[a-z0-9]{32}$/);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.secure).toBe(true);

    const touch = await readFirstTouchCookie(response.cookies.get(FIRST_TOUCH_COOKIE)?.value);
    expect(touch).toEqual({
      channel: 'YOUTUBE',
      utmSource: 'youtube',
      utmMedium: 'video',
      utmCampaign: 'launch',
      referrerHost: null,
      landingPath: '/',
    });

    // The page rendering this same request has to be able to read both.
    expect(request.cookies.get(ANONYMOUS_ID_COOKIE)?.value).toBe(cookie?.value);
    expect(request.cookies.get(FIRST_TOUCH_COOKIE)?.value).toBeDefined();
  });

  it('classifies a visit that only carries a referrer', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');

    const response = await proxy(
      documentRequest('https://open-frame.net/vs/frameio', {
        headers: { referer: 'https://github.com/yusufipk/OpenFrame' },
      })
    );

    expect(
      await readFirstTouchCookie(response.cookies.get(FIRST_TOUCH_COOKIE)?.value)
    ).toMatchObject({
      channel: 'GITHUB',
      referrerHost: 'github.com',
      landingPath: '/vs/frameio',
    });
  });

  it('does not file a click through our own pages as a referral behind a reverse proxy', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
    // Inside the container the request URL is the internal address, so only the
    // configured origin knows the site is open-frame.net.
    vi.stubEnv('NEXTAUTH_URL', 'https://open-frame.net');
    const issued = await proxy(documentRequest('http://localhost:3000/'));

    const response = await proxy(
      documentRequest('http://localhost:3000/vs/frameio', {
        headers: { referer: 'https://open-frame.net/pricing' },
        cookies: {
          [ANONYMOUS_ID_COOKIE]: issued.cookies.get(ANONYMOUS_ID_COOKIE)?.value ?? '',
        },
      })
    );

    expect(
      await readFirstTouchCookie(response.cookies.get(FIRST_TOUCH_COOKIE)?.value)
    ).toMatchObject({ channel: 'DIRECT', referrerHost: null, landingPath: '/vs/frameio' });
  });

  it('counts no visitor for a cookieless client coming from our own pages', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
    vi.stubEnv('NEXTAUTH_URL', 'https://open-frame.net');
    const request = documentRequest('http://localhost:3000/vs/frameio', {
      headers: { referer: 'https://www.open-frame.net/' },
    });

    const response = await proxy(request);

    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)).toBeUndefined();
    expect(response.cookies.get(FIRST_TOUCH_COOKIE)).toBeUndefined();
    // The page reads the request cookies, so nothing may be set there either.
    expect(request.cookies.get(ANONYMOUS_ID_COOKIE)).toBeUndefined();
  });

  it('re-issues an id to a browser whose cookie stopped verifying, even mid-site', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
    vi.stubEnv('NEXTAUTH_URL', 'https://open-frame.net');
    const issued = await proxy(documentRequest('http://localhost:3000/'));
    const stale = issued.cookies.get(ANONYMOUS_ID_COOKIE)?.value ?? '';

    // The secret was rotated: the browser still holds a cookie, and it no longer verifies.
    vi.stubEnv('NEXTAUTH_SECRET', 'a-rotated-secret');
    const response = await proxy(
      documentRequest('http://localhost:3000/pricing', {
        headers: { referer: 'https://open-frame.net/' },
        cookies: { [ANONYMOUS_ID_COOKIE]: stale },
      })
    );

    const fresh = await readAnonymousIdCookie(response.cookies.get(ANONYMOUS_ID_COOKIE)?.value);
    expect(fresh).toMatch(/^[a-z0-9]{32}$/);
  });

  it('still counts a cookieless client that an outside site sent', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
    vi.stubEnv('NEXTAUTH_URL', 'https://open-frame.net');

    const response = await proxy(
      documentRequest('http://localhost:3000/vs/frameio', {
        headers: { referer: 'https://some-blog.example/post' },
      })
    );

    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)?.value).toBeDefined();
    expect(
      await readFirstTouchCookie(response.cookies.get(FIRST_TOUCH_COOKIE)?.value)
    ).toMatchObject({ channel: 'REFERRAL', referrerHost: 'some-blog.example' });
  });

  it('does not overwrite the first touch of a returning visitor', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
    const issued = await proxy(documentRequest('https://open-frame.net/?utm_source=github'));

    const response = await proxy(
      documentRequest('https://open-frame.net/?utm_source=google', {
        cookies: {
          [ANONYMOUS_ID_COOKIE]: issued.cookies.get(ANONYMOUS_ID_COOKIE)?.value ?? '',
          [FIRST_TOUCH_COOKIE]: issued.cookies.get(FIRST_TOUCH_COOKIE)?.value ?? '',
        },
      })
    );

    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)).toBeUndefined();
    expect(response.cookies.get(FIRST_TOUCH_COOKIE)).toBeUndefined();
  });

  it('replaces an id it did not sign, however well formed it looks', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');

    // The shape a real id has, chosen by the caller rather than issued here.
    // Accepting it would let anyone mint visitors, and claim the events of one
    // whose id they guessed.
    const forged = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

    const response = await proxy(
      documentRequest('https://open-frame.net/', {
        cookies: { [ANONYMOUS_ID_COOKIE]: forged },
      })
    );

    const issued = await readAnonymousIdCookie(response.cookies.get(ANONYMOUS_ID_COOKIE)?.value);
    expect(issued).toMatch(/^[a-z0-9]{32}$/);
    expect(issued).not.toBe(forged);
  });

  it('replaces an id signed with another deployment key', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
    const issued = await proxy(documentRequest('https://open-frame.net/'));
    const stolen = issued.cookies.get(ANONYMOUS_ID_COOKIE)?.value ?? '';

    vi.stubEnv('NEXTAUTH_SECRET', 'a-different-secret');
    const response = await proxy(
      documentRequest('https://open-frame.net/', {
        cookies: { [ANONYMOUS_ID_COOKIE]: stolen },
      })
    );

    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)?.value).toBeDefined();
    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)?.value).not.toBe(stolen);
  });

  it('sets nothing when there is no secret to sign with', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
    vi.stubEnv('NEXTAUTH_SECRET', undefined);
    vi.stubEnv('AUTH_SECRET', undefined);

    const response = await proxy(documentRequest('https://open-frame.net/'));

    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)).toBeUndefined();
    expect(response.cookies.get(FIRST_TOUCH_COOKIE)).toBeUndefined();
  });

  it('ignores crawlers, so they never enter the visitor count', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');

    const response = await proxy(
      documentRequest('https://open-frame.net/', {
        headers: { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' },
      })
    );

    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)).toBeUndefined();
  });

  it('ignores a prefetch and an API call', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');

    const prefetch = await proxy(
      documentRequest('https://open-frame.net/register', {
        headers: { 'next-router-prefetch': '1' },
      })
    );
    const api = await proxy(
      documentRequest('https://open-frame.net/api/projects', {
        headers: { 'sec-fetch-dest': 'empty' },
      })
    );

    expect(prefetch.cookies.get(ANONYMOUS_ID_COOKIE)).toBeUndefined();
    expect(api.cookies.get(ANONYMOUS_ID_COOKIE)).toBeUndefined();
  });

  it('leaves the cookie insecure on plain http, so local development works', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');

    const response = await proxy(documentRequest('http://localhost:3000/'));

    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)?.secure).toBe(false);
  });

  it('keeps the cookie secure behind a TLS-terminating proxy', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
    // What a Docker deployment looks like from inside the container: the request
    // arrived over http on an internal address, and only the configured origin
    // knows the site is served over TLS.
    vi.stubEnv('NEXTAUTH_URL', 'https://open-frame.net');

    const response = await proxy(documentRequest('http://localhost:3000/'));

    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)?.secure).toBe(true);
  });
});
