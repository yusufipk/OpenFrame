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
import { createUser } from '../factories';

function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
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
    for (const days of [1, 2, 3]) {
      await seedEvent({
        name: 'LANDING_VIEW',
        occurredAt: daysAgo(days),
        anonymousId: 'visitor-one',
        channel: 'GITHUB',
      });
    }
    await seedEvent({
      name: 'LANDING_VIEW',
      occurredAt: daysAgo(1),
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

  it('carries subscriptions started before the window into the running total', async () => {
    await seedEvent({ name: 'SUBSCRIPTION_STARTED', occurredAt: daysAgo(120) });
    await seedEvent({ name: 'SUBSCRIPTION_STARTED', occurredAt: daysAgo(3) });
    await seedEvent({ name: 'SUBSCRIPTION_CANCELED', occurredAt: daysAgo(3) });

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
    await createUser({ subscriptionStatus: 'FREE' });

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

  it('reports both cohorts as empty rows rather than omitting them', async () => {
    vi.stubEnv('OPENFRAME_CARDLESS_TRIAL_LAUNCHED_AT', CUTOVER);

    const comparison = await getCohortComparison(NOW);

    expect(comparison?.rows.map((row) => row.cohort)).toEqual(['CARD_FIRST', 'CARDLESS']);
    expect(comparison?.rows.every((row) => row.signups === 0)).toBe(true);
  });
});
