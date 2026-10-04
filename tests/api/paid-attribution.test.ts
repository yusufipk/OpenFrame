// A paid ad click, followed from the landing URL to the growth endpoint.
//
// Every step here is the real one: the proxy classifies the URL and signs the
// cookies, the register route copies the first touch onto the account, the
// billing helper records the conversion, and the admin endpoint reports it. The
// question it answers is the one an ad test depends on: does a signup that came
// from `?gclid=...&utm_medium=cpc` show up as its own paid channel, with its
// paying customer, and not inside organic Google?

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { proxy } from '@/proxy';
import { POST as register } from '@/app/api/auth/register/route';
import { GET as growthRoute } from '@/app/api/admin/growth/route';
import { recordSubscriptionTransition } from '@/lib/analytics/billing-events';
import { ANONYMOUS_ID_COOKIE, FIRST_TOUCH_COOKIE } from '@/lib/analytics/cookies';
import type { ChannelRow } from '@/lib/analytics/scoreboard';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedOut } from '../helpers/session';

const SECRET = 'paid-attribution-secret';
const ADMIN_TOKEN = 'Hk3Qw9Zr5Tb1Np7Ls2Xv8Jd4Cm6Fy0Ge';
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/** The cookies the proxy issues for a first visit to `url`. */
async function landOn(url: string, referer?: string): Promise<Record<string, string>> {
  const headers = new Headers({ 'user-agent': BROWSER_UA, 'sec-fetch-dest': 'document' });
  if (referer) headers.set('referer', referer);
  const response = await proxy(new NextRequest(new URL(url), { headers }));

  const anonymousId = response.cookies.get(ANONYMOUS_ID_COOKIE)?.value ?? '';
  const firstTouch = response.cookies.get(FIRST_TOUCH_COOKIE)?.value ?? '';
  expect(anonymousId, 'proxy issued no visitor id').not.toBe('');
  expect(firstTouch, 'proxy issued no first touch').not.toBe('');
  return { [ANONYMOUS_ID_COOKIE]: anonymousId, [FIRST_TOUCH_COOKIE]: firstTouch };
}

async function signUp(email: string, cookies: Record<string, string>): Promise<string> {
  const response = await callRoute(
    register,
    apiRequest('/api/auth/register', {
      body: {
        name: 'Ad Visitor',
        email,
        password: 'correct horse battery',
        inviteCode: 'test-invite',
      },
      headers: { 'user-agent': BROWSER_UA },
      cookies,
    })
  );
  expect(response.status).toBe(201);
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  return user.id;
}

async function pay(userId: string) {
  await recordSubscriptionTransition({
    userId,
    subscriptionId: `sub_${userId}`,
    before: { status: 'FREE', cancelAtPeriodEnd: false, hadTrial: false },
    after: {
      status: 'ACTIVE',
      cancelAtPeriodEnd: false,
      trialEndsAt: null,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
}

async function growthChannels(): Promise<ChannelRow[]> {
  const response = await callRoute(
    growthRoute,
    apiRequest('/api/admin/growth', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })
  );
  expect(response.status).toBe(200);
  const data = await readData<{ channels: ChannelRow[] }>(response);
  return data.channels;
}

beforeEach(() => {
  signedOut();
  vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
  vi.stubEnv('NEXTAUTH_SECRET', SECRET);
  vi.stubEnv('NEXTAUTH_URL', undefined);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
  vi.stubEnv('OPENFRAME_ADMIN_API_TOKEN', ADMIN_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('paid ad attribution, landing URL to growth endpoint', () => {
  it('reports a signup from a tagged ad click as PAID, apart from organic Google', async () => {
    const adCookies = await landOn(
      'https://open-frame.net/?gclid=test&utm_source=google&utm_medium=cpc&utm_campaign=frameio_alt',
      'https://www.google.com/'
    );
    const organicCookies = await landOn('https://open-frame.net/', 'https://www.google.com/');

    const adUserId = await signUp('ad-visitor@example.com', adCookies);
    const organicUserId = await signUp('organic-visitor@example.com', organicCookies);
    await pay(adUserId);

    const adAcquisition = await db.userAcquisition.findUniqueOrThrow({
      where: { userId: adUserId },
    });
    expect(adAcquisition).toMatchObject({
      channel: 'PAID',
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'frameio_alt',
    });
    const organicAcquisition = await db.userAcquisition.findUniqueOrThrow({
      where: { userId: organicUserId },
    });
    expect(organicAcquisition.channel).toBe('GOOGLE');

    const channels = await growthChannels();
    expect(channels.find((row) => row.channel === 'PAID')).toMatchObject({ signups: 1, paid: 1 });
    expect(channels.find((row) => row.channel === 'GOOGLE')).toMatchObject({
      signups: 1,
      paid: 0,
    });
  });

  it('reports an auto-tagged click with no UTM tags at all as PAID', async () => {
    // Google Ads auto-tagging appends only gclid, and the referrer is plain
    // google.com, which on its own reads as organic search.
    const cookies = await landOn(
      'https://open-frame.net/vs/frameio?gclid=abc123',
      'https://www.google.com/'
    );

    const userId = await signUp('autotagged@example.com', cookies);

    const acquisition = await db.userAcquisition.findUniqueOrThrow({ where: { userId } });
    expect(acquisition).toMatchObject({ channel: 'PAID', landingPath: '/vs/frameio' });
    expect((await growthChannels()).map((row) => row.channel)).toEqual(['PAID']);
  });
});
