// Exercises the scoreboard queries against a real database.
//
// These are raw SQL: a date_trunc grouping, a COALESCE across two tables and a
// filtered left join. None of that is checked by the type system, so a seeded
// week with known counts is the only thing standing between a renamed column and
// a growth page that renders zeros forever.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { AcquisitionChannel, AnalyticsEventName } from '@prisma/client';
import { db } from '@/lib/db';
import {
  AT_RISK_SILENT_DAYS,
  getCohortComparison,
  getScoreboard,
} from '@/lib/analytics/scoreboard';
import { GET as growthRoute } from '@/app/api/admin/growth/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { createUser } from '../factories';

function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

/**
 * The Monday this week started, in UTC.
 *
 * Anything asserted per week has to be seeded from here rather than from
 * `daysAgo`: weeks start on Monday, so "three days ago" is last week on a
 * Wednesday and this week on a Saturday, and a suite written the second way
 * fails on the days the calendar disagrees.
 */
function startOfThisWeek(): Date {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start;
}

/** `days` into the week beginning at `weekStart`. Negative walks back a week. */
function intoWeek(weekStart: Date, days: number): Date {
  const date = new Date(weekStart);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

let sequence = 0;

async function seedEvent(params: {
  name: AnalyticsEventName;
  occurredAt: Date;
  userId?: string;
  anonymousId?: string;
  channel?: AcquisitionChannel;
}) {
  sequence += 1;
  await db.analyticsEvent.create({
    data: {
      name: params.name,
      dedupeKey: `${params.name}:seed-${sequence}`,
      occurredAt: params.occurredAt,
      userId: params.userId ?? null,
      anonymousId: params.anonymousId ?? null,
      channel: params.channel ?? null,
    },
  });
}

beforeEach(() => {
  sequence = 0;
  vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getScoreboard', () => {
  it('returns an empty week for every week in the window when nothing happened', async () => {
    const scoreboard = await getScoreboard({ weeks: 4 });

    expect(scoreboard.weeks).toHaveLength(4);
    expect(scoreboard.weeks.every((week) => week.visitors === 0)).toBe(true);
    expect(scoreboard.channels).toEqual([]);
    expect(scoreboard.paidAccounts).toEqual([]);
  });

  it('counts a returning visitor once per week, not once per visit', async () => {
    // Landing views are deduped per visitor per day, so the same person on three
    // days is three rows. Weekly visitors is a distinct count over the id.
    // Seeded into last week, which is whole however the suite is scheduled.
    const lastWeek = intoWeek(startOfThisWeek(), -7);
    for (const day of [0, 1, 2]) {
      await seedEvent({
        name: 'LANDING_VIEW',
        occurredAt: intoWeek(lastWeek, day),
        anonymousId: 'visitor-one',
        channel: 'GITHUB',
      });
    }
    await seedEvent({
      name: 'LANDING_VIEW',
      occurredAt: intoWeek(lastWeek, 1),
      anonymousId: 'visitor-two',
      channel: 'GOOGLE',
    });

    const scoreboard = await getScoreboard({ weeks: 2 });
    const total = scoreboard.weeks.reduce((sum, week) => sum + week.visitors, 0);

    expect(total).toBe(2);
  });

  it('reads a signed-up visitor through the channel on their account', async () => {
    const user = await createUser();
    await db.userAcquisition.create({
      data: { userId: user.id, channel: 'YOUTUBE', anonymousId: 'visitor-three' },
    });

    // The visitor event carries GITHUB from the cookie, but the account says
    // YouTube. The account wins, so correcting a channel corrects its history.
    await seedEvent({
      name: 'LANDING_VIEW',
      occurredAt: daysAgo(2),
      anonymousId: 'visitor-three',
      channel: 'GITHUB',
      userId: user.id,
    });
    await seedEvent({
      name: 'SIGNUP_COMPLETED',
      occurredAt: daysAgo(2),
      userId: user.id,
      anonymousId: 'visitor-three',
    });

    const scoreboard = await getScoreboard({ weeks: 2 });
    const youtube = scoreboard.channels.find((row) => row.channel === 'YOUTUBE');

    expect(youtube).toMatchObject({ visitors: 1, signups: 1 });
    expect(scoreboard.channels.find((row) => row.channel === 'GITHUB')).toBeUndefined();
  });

  it('breaks the REFERRAL channel down by referring host and landing path', async () => {
    const touches = [
      { anonymousId: 'ref-a', referrerHost: 'blog.example', landingPath: '/' },
      { anonymousId: 'ref-b', referrerHost: 'blog.example', landingPath: '/' },
      { anonymousId: 'ref-c', referrerHost: 'spam.example', landingPath: '/vs/frameio' },
    ];
    for (const touch of touches) {
      await db.acquisitionTouch.create({ data: { ...touch, channel: 'REFERRAL' } });
      await seedEvent({
        name: 'LANDING_VIEW',
        occurredAt: daysAgo(3),
        anonymousId: touch.anonymousId,
        channel: 'REFERRAL',
      });
    }
    // The same visitor on a second day is still one visitor.
    await seedEvent({
      name: 'LANDING_VIEW',
      occurredAt: daysAgo(4),
      anonymousId: 'ref-a',
      channel: 'REFERRAL',
    });
    // Another channel, and a referral older than the window: neither belongs here.
    await db.acquisitionTouch.create({
      data: { anonymousId: 'gh', channel: 'GITHUB', referrerHost: 'github.com', landingPath: '/' },
    });
    await seedEvent({
      name: 'LANDING_VIEW',
      occurredAt: daysAgo(3),
      anonymousId: 'gh',
      channel: 'GITHUB',
    });
    await db.acquisitionTouch.create({
      data: {
        anonymousId: 'old',
        channel: 'REFERRAL',
        referrerHost: 'old.example',
        landingPath: '/',
      },
    });
    await seedEvent({
      name: 'LANDING_VIEW',
      occurredAt: daysAgo(40),
      anonymousId: 'old',
      channel: 'REFERRAL',
    });

    // Only landing views count as visitors, so another REFERRAL event adds no row.
    await seedEvent({
      name: 'SIGNUP_STARTED',
      occurredAt: daysAgo(3),
      anonymousId: 'ref-x',
      channel: 'REFERRAL',
    });
    await db.acquisitionTouch.create({
      data: {
        anonymousId: 'ref-x',
        channel: 'REFERRAL',
        referrerHost: 'x.example',
        landingPath: '/',
      },
    });
    // A signed-up visitor is read through the account, as the channels table does:
    // the event and touch say GITHUB, the account says REFERRAL from forum.example.
    const user = await createUser();
    await db.userAcquisition.create({
      data: {
        userId: user.id,
        anonymousId: 'ref-u',
        channel: 'REFERRAL',
        referrerHost: 'forum.example',
        landingPath: '/pricing',
      },
    });
    await db.acquisitionTouch.create({
      data: {
        anonymousId: 'ref-u',
        channel: 'GITHUB',
        referrerHost: 'github.com',
        landingPath: '/',
      },
    });
    await seedEvent({
      name: 'LANDING_VIEW',
      occurredAt: daysAgo(3),
      anonymousId: 'ref-u',
      userId: user.id,
      channel: 'GITHUB',
    });

    const scoreboard = await getScoreboard({ weeks: 2 });

    expect(scoreboard.referrals).toEqual([
      { referrerHost: 'blog.example', landingPath: '/', visitors: 2 },
      { referrerHost: 'forum.example', landingPath: '/pricing', visitors: 1 },
      { referrerHost: 'spam.example', landingPath: '/vs/frameio', visitors: 1 },
    ]);
    expect(scoreboard.channels.find((row) => row.channel === 'REFERRAL')?.visitors).toBe(4);
  });

  it('carries subscriptions started before the window into the running total', async () => {
    // The pair has to land in the week the assertions read, which is this one.
    const thisWeek = startOfThisWeek();
    await seedEvent({ name: 'SUBSCRIPTION_STARTED', occurredAt: daysAgo(120) });
    await seedEvent({ name: 'SUBSCRIPTION_STARTED', occurredAt: thisWeek });
    await seedEvent({ name: 'SUBSCRIPTION_CANCELED', occurredAt: thisWeek });

    const scoreboard = await getScoreboard({ weeks: 2 });
    const last = scoreboard.weeks[scoreboard.weeks.length - 1];

    // One from before the window, plus one started and one canceled inside it.
    expect(last?.activePaid).toBe(1);
    expect(last?.newPaid).toBe(1);
    expect(last?.canceled).toBe(1);
  });

  it('flags a paid account that has produced nothing recently', async () => {
    const busy = await createUser({ subscriptionStatus: 'ACTIVE' });
    const silent = await createUser({ subscriptionStatus: 'ACTIVE' });
    const trialing = await createUser({ subscriptionStatus: 'TRIALING' });
    // Free with nothing left to run, so it stays out of the table.
    await createUser({ subscriptionStatus: 'FREE', trialEndsAt: null });

    await seedEvent({ name: 'VIDEO_ADDED', occurredAt: daysAgo(2), userId: busy.id });
    await seedEvent({ name: 'SHARE_LINK_CREATED', occurredAt: daysAgo(20), userId: busy.id });
    await seedEvent({
      name: 'VIDEO_ADDED',
      occurredAt: daysAgo(AT_RISK_SILENT_DAYS + 5),
      userId: silent.id,
    });
    // A signup is not a value event, so it must not clear the risk flag.
    await seedEvent({ name: 'SIGNUP_COMPLETED', occurredAt: daysAgo(1), userId: trialing.id });

    const scoreboard = await getScoreboard({ weeks: 4 });
    const ids = scoreboard.paidAccounts.map((row) => row.userId).sort();
    const atRisk = scoreboard.atRisk.map((row) => row.userId).sort();

    expect(ids).toEqual([busy.id, silent.id, trialing.id].sort());
    expect(atRisk).toEqual([silent.id, trialing.id].sort());

    const busyRow = scoreboard.paidAccounts.find((row) => row.userId === busy.id);
    expect(busyRow?.valueEvents7).toBe(1);
    expect(busyRow?.valueEvents30).toBe(2);
  });

  // A cardless trial has no Stripe subscription to hold the status, so it sits at
  // FREE with only a date behind it. Filtering on the status column alone left
  // every trial account out of this table and out of the at-risk list with it.
  it('includes a cardless trial and reports it as trialing', async () => {
    const cardless = await createUser({
      subscriptionStatus: 'FREE',
      trialEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const expired = await createUser({
      subscriptionStatus: 'FREE',
      trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const scoreboard = await getScoreboard({ weeks: 4 });
    const ids = scoreboard.paidAccounts.map((row) => row.userId);

    expect(ids).toEqual([cardless.id]);
    expect(ids).not.toContain(expired.id);
    expect(scoreboard.paidAccounts[0]?.status).toBe('TRIALING');
  });

  it('leaves an account an admin excluded out of every table', async () => {
    const thisWeek = startOfThisWeek();
    const counted = await createUser({ subscriptionStatus: 'ACTIVE' });
    const excluded = await createUser({ subscriptionStatus: 'ACTIVE' });
    await db.user.update({ where: { id: excluded.id }, data: { excludedFromStats: true } });
    await db.userAcquisition.create({
      data: { userId: excluded.id, channel: 'REFERRAL', anonymousId: 'tester' },
    });
    await db.acquisitionTouch.create({
      data: {
        anonymousId: 'tester',
        channel: 'REFERRAL',
        referrerHost: 'test.example',
        landingPath: '/',
      },
    });

    for (const user of [counted, excluded]) {
      await seedEvent({ name: 'SIGNUP_COMPLETED', occurredAt: thisWeek, userId: user.id });
      await seedEvent({ name: 'SUBSCRIPTION_STARTED', occurredAt: thisWeek, userId: user.id });
    }
    // Before the window, so only the running total can pick it up.
    await seedEvent({
      name: 'SUBSCRIPTION_STARTED',
      occurredAt: daysAgo(120),
      userId: excluded.id,
    });
    // Signed-out visits carry only the visitor cookie the account signed up with: one
    // tied to the account at signup, and one made later after signing out.
    await seedEvent({
      name: 'LANDING_VIEW',
      occurredAt: thisWeek,
      anonymousId: 'tester',
      userId: excluded.id,
      channel: 'REFERRAL',
    });
    await seedEvent({
      name: 'LANDING_VIEW',
      occurredAt: thisWeek,
      anonymousId: 'tester',
      channel: 'REFERRAL',
    });
    // A stranger's visit still counts.
    await seedEvent({ name: 'LANDING_VIEW', occurredAt: thisWeek, anonymousId: 'stranger' });

    const scoreboard = await getScoreboard({ weeks: 2 });
    const last = scoreboard.weeks[scoreboard.weeks.length - 1];

    expect(last).toMatchObject({ visitors: 1, signups: 1, newPaid: 1, activePaid: 1 });
    expect(scoreboard.channels.find((row) => row.channel === 'REFERRAL')).toBeUndefined();
    expect(scoreboard.referrals).toEqual([]);
    expect(scoreboard.paidAccounts.map((row) => row.userId)).toEqual([counted.id]);
  });
});

// The cohort comparison is another block of raw SQL, and the part most easily
// got wrong is the observation window: a conversion that arrives two months
// after signup belongs to neither cohort's score.
describe('getCohortComparison', () => {
  const CUTOVER = '2026-03-01T00:00:00.000Z';
  const NOW = new Date('2026-05-01T00:00:00.000Z');

  async function seedAccount(params: { createdAt: string; trialAt?: string; paidAt?: string }) {
    const user = await createUser();
    await db.user.update({
      where: { id: user.id },
      data: { createdAt: new Date(params.createdAt) },
    });

    if (params.trialAt) {
      await seedEvent({
        name: 'TRIAL_STARTED',
        occurredAt: new Date(params.trialAt),
        userId: user.id,
      });
    }
    if (params.paidAt) {
      await seedEvent({
        name: 'SUBSCRIPTION_STARTED',
        occurredAt: new Date(params.paidAt),
        userId: user.id,
      });
    }

    return user;
  }

  it('is null on a deployment that never named a switchover date', async () => {
    vi.stubEnv('OPENFRAME_CARDLESS_TRIAL_LAUNCHED_AT', '');

    expect(await getCohortComparison(NOW)).toBeNull();
  });

  it('splits accounts by the cutover and scores each within its 30 days', async () => {
    vi.stubEnv('OPENFRAME_CARDLESS_TRIAL_LAUNCHED_AT', CUTOVER);

    // Card first: one converted inside the window, one long after it.
    await seedAccount({
      createdAt: '2026-02-10T00:00:00.000Z',
      paidAt: '2026-02-20T00:00:00.000Z',
    });
    await seedAccount({
      createdAt: '2026-02-10T00:00:00.000Z',
      paidAt: '2026-03-25T00:00:00.000Z',
    });
    // Cardless: both took the trial, one paid for it.
    await seedAccount({
      createdAt: '2026-03-10T00:00:00.000Z',
      trialAt: '2026-03-10T00:00:00.000Z',
      paidAt: '2026-03-20T00:00:00.000Z',
    });
    await seedAccount({
      createdAt: '2026-03-15T00:00:00.000Z',
      trialAt: '2026-03-15T00:00:00.000Z',
    });
    // Older than the matched window, and too new to have been observed yet.
    await seedAccount({
      createdAt: '2026-01-01T00:00:00.000Z',
      paidAt: '2026-01-05T00:00:00.000Z',
    });
    await seedAccount({
      createdAt: '2026-04-15T00:00:00.000Z',
      paidAt: '2026-04-16T00:00:00.000Z',
    });

    const comparison = await getCohortComparison(NOW);

    expect(comparison?.rows).toEqual([
      expect.objectContaining({ cohort: 'CARD_FIRST', signups: 2, trials: 0, paid: 1 }),
      expect.objectContaining({ cohort: 'CARDLESS', signups: 2, trials: 2, paid: 1 }),
    ]);
  });

  it('leaves an account an admin excluded out of its cohort', async () => {
    vi.stubEnv('OPENFRAME_CARDLESS_TRIAL_LAUNCHED_AT', CUTOVER);
    await seedAccount({ createdAt: '2026-03-10T00:00:00.000Z' });
    const excluded = await seedAccount({
      createdAt: '2026-03-11T00:00:00.000Z',
      trialAt: '2026-03-11T00:00:00.000Z',
      paidAt: '2026-03-12T00:00:00.000Z',
    });
    await db.user.update({ where: { id: excluded.id }, data: { excludedFromStats: true } });

    const comparison = await getCohortComparison(NOW);

    expect(comparison?.rows[1]).toMatchObject({
      cohort: 'CARDLESS',
      signups: 1,
      trials: 0,
      paid: 0,
    });
  });

  it('reports both cohorts as empty rows rather than omitting them', async () => {
    vi.stubEnv('OPENFRAME_CARDLESS_TRIAL_LAUNCHED_AT', CUTOVER);

    const comparison = await getCohortComparison(NOW);

    expect(comparison?.rows.map((row) => row.cohort)).toEqual(['CARD_FIRST', 'CARDLESS']);
    expect(comparison?.rows.every((row) => row.signups === 0)).toBe(true);
  });
});

// The token path exists so a scheduled digest can read this endpoint with no
// browser. It is the only way into admin data that carries no session, so the
// cases that matter are the ones where it must not open: unset, wrong, and a
// caller who is signed in but not an admin.
describe('GET /api/admin/growth', () => {
  const TOKEN = 'wq7Fr2Tn8Vb4Kd1Mw6Hs9Lp3Cf5Gj0Ye';

  function growthRequest(headers?: Record<string, string>) {
    return callRoute(growthRoute, apiRequest('/api/admin/growth', { headers }));
  }

  it('refuses an anonymous caller when no token is configured', async () => {
    signedOut();
    vi.stubEnv('OPENFRAME_ADMIN_API_TOKEN', '');

    // The header a caller would send if they had guessed the scheme but there is
    // nothing to guess: an unset token must never match.
    const response = await growthRequest({ authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(401);
  });

  it('refuses a signed-in caller who is not an admin', async () => {
    const user = await createUser();
    signedInAs({ id: user.id, email: user.email, isAdmin: false });

    const response = await growthRequest();
    expect(response.status).toBe(403);
  });

  it('refuses a bearer token that is not the configured one', async () => {
    signedOut();
    vi.stubEnv('OPENFRAME_ADMIN_API_TOKEN', TOKEN);

    const response = await growthRequest({
      authorization: 'Bearer wq7Fr2Tn8Vb4Kd1Mw6Hs9Lp3Cf5Gj0Yf',
    });
    expect(response.status).toBe(401);
  });

  it('serves the scoreboard to a caller carrying the configured token', async () => {
    signedOut();
    vi.stubEnv('OPENFRAME_ADMIN_API_TOKEN', TOKEN);

    const paying = await createUser({ subscriptionStatus: 'ACTIVE' });
    await seedEvent({ name: 'SIGNUP_COMPLETED', occurredAt: daysAgo(1), userId: paying.id });

    const response = await growthRequest({ authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(200);

    const scoreboard = await readData(response);
    expect(scoreboard.paidAccounts.map((row: { userId: string }) => row.userId)).toContain(
      paying.id
    );
    // Rates ride along with each week; the digest reads them rather than
    // recomputing the denominators.
    expect(scoreboard.weeks.at(-1)).toHaveProperty('rates');
  });

  it('still refuses the token when analytics are off, without saying so', async () => {
    signedOut();
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'false');
    vi.stubEnv('OPENFRAME_ADMIN_API_TOKEN', TOKEN);

    // Authorized, but the flag is off: a 400, not a scoreboard.
    const authorized = await growthRequest({ authorization: `Bearer ${TOKEN}` });
    expect(authorized.status).toBe(400);

    // Unauthorized callers must not learn the flag's state from the status code.
    const anonymous = await growthRequest();
    expect(anonymous.status).toBe(401);
  });
});
