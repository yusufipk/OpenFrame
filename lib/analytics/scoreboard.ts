// The Monday scoreboard, as queries.
//
// Two decisions here are worth stating, because they are what make the numbers
// readable rather than merely present:
//
//  1. Rates, not just counts. A funnel is a set of ratios; the step with the
//     worst ratio is the thing to fix, and a column of absolute numbers hides it.
//  2. Every rate carries its denominator. At this volume a weekly per-channel
//     cell holds single digits, and 1 out of 3 renders as "33%" exactly as
//     confidently as 340 out of 1020. The channel view therefore runs on a
//     rolling 28-day window rather than a week, and still reports `n`.

import type { AcquisitionChannel } from '@prisma/client';
import { db } from '@/lib/db';
import { getCachedStripeStats } from '@/lib/admin-stats';

/** What "using the product" means for a paying account. */
export const VALUE_EVENT_NAMES = [
  'VIDEO_ADDED',
  'SHARE_LINK_CREATED',
  'FIRST_GUEST_COMMENT',
  'APPROVAL_COMPLETED',
  'PROJECT_CREATED',
] as const;

/** A paid account that has produced nothing for this long is drifting away. */
export const AT_RISK_SILENT_DAYS = 14;

const DEFAULT_WEEKS = 12;
const CHANNEL_WINDOW_DAYS = 28;

/**
 * How many paid accounts the per-account table carries.
 *
 * The list is ordered quietest first, so the cap drops the accounts that are
 * using the product most, which are the ones nobody needs to read a row about.
 * It is reported rather than applied silently: a truncated table that looks
 * complete is worse than a smaller one that says so.
 */
const PAID_ACCOUNT_LIMIT = 500;

export interface WeeklyRow {
  weekStart: Date;
  visitors: number;
  ctaClicks: number;
  signupStarted: number;
  signups: number;
  emailVerified: number;
  firstVideo: number;
  shareLinks: number;
  externalFeedback: number;
  trials: number;
  newPaid: number;
  canceled: number;
  /** Running net of started minus canceled. Derived, not a Stripe snapshot. */
  activePaid: number;
  mrrCents: number;
}

export interface ChannelRow {
  channel: AcquisitionChannel;
  visitors: number;
  signups: number;
  trials: number;
  paid: number;
}

export interface PaidAccountRow {
  userId: string;
  name: string | null;
  email: string | null;
  status: string;
  valueEvents7: number;
  valueEvents30: number;
  lastValueEventAt: Date | null;
  channel: AcquisitionChannel | null;
  selfReported: AcquisitionChannel | null;
}

/**
 * How long an account gets to convert before its cohort is scored.
 *
 * Fixed rather than "since signup" so the two cohorts are compared over equal
 * time. Without it the newer cohort is measured over a shorter life than the
 * older one and always looks worse, whatever the change did.
 */
export const COHORT_OBSERVATION_DAYS = 30;

export type TrialCohort = 'CARD_FIRST' | 'CARDLESS';

export interface CohortRow {
  cohort: TrialCohort;
  windowStart: Date;
  windowEnd: Date;
  signups: number;
  trials: number;
  paid: number;
}

export interface CohortComparison {
  cutover: Date;
  observationDays: number;
  /** Length of each side's window. Equal by construction; reported so it can be judged. */
  windowDays: number;
  rows: CohortRow[];
}

export interface Scoreboard {
  weeks: WeeklyRow[];
  channels: ChannelRow[];
  channelWindowDays: number;
  paidAccounts: PaidAccountRow[];
  /** True when there are more paid accounts than the table shows. */
  paidAccountsTruncated: boolean;
  paidAccountLimit: number;
  atRisk: PaidAccountRow[];
  currentActivePaid: number | null;
  currentMrrCents: number | null;
  currency: string;
  /** Null until OPENFRAME_CARDLESS_TRIAL_LAUNCHED_AT names the switchover date. */
  cohorts: CohortComparison | null;
}

interface WeeklyQueryRow {
  week: Date;
  name: string;
  subjects: number;
}

interface ChannelQueryRow {
  channel: AcquisitionChannel | null;
  name: string;
  subjects: number;
}

interface PaidQueryRow {
  user_id: string;
  name: string | null;
  email: string | null;
  status: string;
  channel: AcquisitionChannel | null;
  self_reported: AcquisitionChannel | null;
  value_events_7: number;
  value_events_30: number;
  last_value_event_at: Date | null;
}

function startOfWeek(date: Date): Date {
  const copy = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0)
  );
  // Postgres date_trunc('week') starts on Monday; match it so the two halves of
  // the table line up.
  const isoDayIndex = (copy.getUTCDay() + 6) % 7;
  copy.setUTCDate(copy.getUTCDate() - isoDayIndex);
  return copy;
}

function emptyWeek(weekStart: Date): WeeklyRow {
  return {
    weekStart,
    visitors: 0,
    ctaClicks: 0,
    signupStarted: 0,
    signups: 0,
    emailVerified: 0,
    firstVideo: 0,
    shareLinks: 0,
    externalFeedback: 0,
    trials: 0,
    newPaid: 0,
    canceled: 0,
    activePaid: 0,
    mrrCents: 0,
  };
}

const WEEK_COLUMN_BY_EVENT: Record<string, keyof WeeklyRow> = {
  LANDING_VIEW: 'visitors',
  CTA_CLICKED: 'ctaClicks',
  SIGNUP_STARTED: 'signupStarted',
  SIGNUP_COMPLETED: 'signups',
  EMAIL_VERIFIED: 'emailVerified',
  VIDEO_ADDED: 'firstVideo',
  SHARE_LINK_CREATED: 'shareLinks',
  FIRST_GUEST_COMMENT: 'externalFeedback',
  TRIAL_STARTED: 'trials',
  SUBSCRIPTION_STARTED: 'newPaid',
  SUBSCRIPTION_CANCELED: 'canceled',
};

export interface FunnelRates {
  visitorToSignup: number | null;
  signupToFirstVideo: number | null;
  firstVideoToShare: number | null;
  shareToFeedback: number | null;
  trialToPaid: number | null;
}

/**
 * Step-to-step conversion, or null when the denominator is zero.
 *
 * Null rather than 0 on purpose: "no visitors, so no rate" and "visitors, none
 * of whom converted" are different facts, and showing the first as 0% invents a
 * problem that is not there.
 */
export function conversionRates(row: {
  visitors: number;
  signups: number;
  firstVideo: number;
  shareLinks: number;
  externalFeedback: number;
  trials: number;
  newPaid: number;
}): FunnelRates {
  const ratio = (numerator: number, denominator: number) =>
    denominator > 0 ? numerator / denominator : null;

  return {
    visitorToSignup: ratio(row.signups, row.visitors),
    signupToFirstVideo: ratio(row.firstVideo, row.signups),
    firstVideoToShare: ratio(row.shareLinks, row.firstVideo),
    shareToFeedback: ratio(row.externalFeedback, row.shareLinks),
    trialToPaid: ratio(row.newPaid, row.trials),
  };
}

/**
 * The day the cardless trial replaced the card-first one, if it has been set.
 *
 * Kept in the environment rather than in code because it is a fact about a
 * deployment, not about the product: a self-hosted instance never switched over
 * at all, and the hosted one only knows the date once it has shipped.
 */
export function getCardlessTrialCutover(): Date | null {
  const raw = process.env.OPENFRAME_CARDLESS_TRIAL_LAUNCHED_AT?.trim();
  if (!raw) return null;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The two equal-length windows either side of the cutover.
 *
 * The `after` window stops `COHORT_OBSERVATION_DAYS` short of now, because an
 * account that signed up yesterday has not had its chance to convert yet and
 * counting it would drag the new cohort's rate down for a month. The `before`
 * window is then cut to the same length, ending at the cutover.
 */
export function cohortWindows(
  cutover: Date,
  now: Date,
  observationDays: number = COHORT_OBSERVATION_DAYS
) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const afterStart = cutover;
  const afterEnd = new Date(now.getTime() - observationDays * msPerDay);
  const spanMs = Math.max(0, afterEnd.getTime() - afterStart.getTime());

  return {
    afterStart,
    afterEnd: new Date(afterStart.getTime() + spanMs),
    beforeStart: new Date(cutover.getTime() - spanMs),
    beforeEnd: cutover,
    windowDays: Math.floor(spanMs / msPerDay),
  };
}

interface CohortQueryRow {
  cohort: string;
  signups: number;
  trials: number;
  paid: number;
}

/**
 * Card-first against cardless, on signup-to-paid rather than trial-to-paid.
 *
 * Trial-to-paid is the wrong ratio for this comparison and will mislead whoever
 * reads it: handing out trials without a card multiplies the denominator, so the
 * rate can halve while the number of paying customers goes up. Signups are the
 * honest denominator because they are the one thing the change does not move.
 */
export async function getCohortComparison(
  now: Date = new Date()
): Promise<CohortComparison | null> {
  const cutover = getCardlessTrialCutover();
  if (!cutover) return null;

  const { afterStart, afterEnd, beforeStart, beforeEnd, windowDays } = cohortWindows(cutover, now);
  const observationInterval = `${COHORT_OBSERVATION_DAYS} days`;

  const rows = await db.$queryRaw<CohortQueryRow[]>`
    SELECT CASE WHEN u."createdAt" >= ${cutover} THEN 'CARDLESS' ELSE 'CARD_FIRST' END AS cohort,
           COUNT(*)::int AS signups,
           COUNT(*) FILTER (WHERE t.started_at IS NOT NULL)::int AS trials,
           COUNT(*) FILTER (WHERE p.paid_at IS NOT NULL)::int AS paid
    FROM users u
    LEFT JOIN LATERAL (
      SELECT MIN(e.occurred_at) AS started_at
      FROM analytics_events e
      WHERE e.user_id = u.id
        AND e.name::text = 'TRIAL_STARTED'
        AND e.occurred_at <= u."createdAt" + ${observationInterval}::interval
    ) t ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(e.occurred_at) AS paid_at
      FROM analytics_events e
      WHERE e.user_id = u.id
        AND e.name::text = 'SUBSCRIPTION_STARTED'
        AND e.occurred_at <= u."createdAt" + ${observationInterval}::interval
    ) p ON TRUE
    WHERE (u."createdAt" >= ${beforeStart} AND u."createdAt" < ${beforeEnd})
       OR (u."createdAt" >= ${afterStart} AND u."createdAt" < ${afterEnd})
    GROUP BY 1
  `;

  const byCohort = new Map(rows.map((row) => [row.cohort, row]));
  const build = (cohort: TrialCohort, windowStart: Date, windowEnd: Date): CohortRow => {
    const row = byCohort.get(cohort);
    return {
      cohort,
      windowStart,
      windowEnd,
      signups: row?.signups ?? 0,
      trials: row?.trials ?? 0,
      paid: row?.paid ?? 0,
    };
  };

  return {
    cutover,
    observationDays: COHORT_OBSERVATION_DAYS,
    windowDays,
    rows: [build('CARD_FIRST', beforeStart, beforeEnd), build('CARDLESS', afterStart, afterEnd)],
  };
}

export async function getScoreboard(options?: { weeks?: number }): Promise<Scoreboard> {
  const weeks = Math.min(Math.max(options?.weeks ?? DEFAULT_WEEKS, 1), 52);
  const now = new Date();
  const firstWeekStart = startOfWeek(now);
  firstWeekStart.setUTCDate(firstWeekStart.getUTCDate() - (weeks - 1) * 7);

  const channelWindowStart = new Date(now);
  channelWindowStart.setUTCDate(channelWindowStart.getUTCDate() - CHANNEL_WINDOW_DAYS);

  const [weekRows, channelRows, priorPaid, paidAccounts, stripeStats, cohorts] = await Promise.all([
    // COUNT(DISTINCT COALESCE(anonymous_id, id)) rather than COUNT(*): a landing
    // view is deduped per visitor per day, so a visitor who came back on three
    // days would otherwise be three weekly visitors. Rows with no anonymous id
    // fall back to their own primary key and stay distinct.
    db.$queryRaw<WeeklyQueryRow[]>`
      SELECT date_trunc('week', occurred_at) AS week,
             name::text AS name,
             COUNT(DISTINCT COALESCE(anonymous_id, id))::int AS subjects
      FROM analytics_events
      WHERE occurred_at >= ${firstWeekStart}
      GROUP BY 1, 2
    `,
    db.$queryRaw<ChannelQueryRow[]>`
      SELECT COALESCE(ua.channel, e.channel) AS channel,
             e.name::text AS name,
             COUNT(DISTINCT COALESCE(e.anonymous_id, e.id))::int AS subjects
      FROM analytics_events e
      LEFT JOIN user_acquisitions ua ON ua.user_id = e.user_id
      WHERE e.occurred_at >= ${channelWindowStart}
      GROUP BY 1, 2
    `,
    db.$queryRaw<Array<{ started: number; canceled: number }>>`
      SELECT
        COUNT(*) FILTER (WHERE name::text = 'SUBSCRIPTION_STARTED')::int AS started,
        COUNT(*) FILTER (WHERE name::text = 'SUBSCRIPTION_CANCELED')::int AS canceled
      FROM analytics_events
      WHERE occurred_at < ${firstWeekStart}
    `,
    db.$queryRaw<PaidQueryRow[]>`
      SELECT u.id AS user_id,
             u.name,
             u.email,
             u."subscriptionStatus"::text AS status,
             ua.channel,
             ua.self_reported,
             COUNT(e.id) FILTER (WHERE e.occurred_at >= NOW() - INTERVAL '7 days')::int
               AS value_events_7,
             COUNT(e.id) FILTER (WHERE e.occurred_at >= NOW() - INTERVAL '30 days')::int
               AS value_events_30,
             MAX(e.occurred_at) AS last_value_event_at
      FROM users u
      LEFT JOIN user_acquisitions ua ON ua.user_id = u.id
      LEFT JOIN analytics_events e
        ON e.user_id = u.id
       AND e.name::text = ANY(${[...VALUE_EVENT_NAMES]}::text[])
      WHERE u."subscriptionStatus"::text IN ('ACTIVE', 'TRIALING')
      GROUP BY u.id, u.name, u.email, u."subscriptionStatus", ua.channel, ua.self_reported
      ORDER BY MAX(e.occurred_at) ASC NULLS FIRST
      LIMIT ${PAID_ACCOUNT_LIMIT + 1}
    `,
    getCachedStripeStats(),
    getCohortComparison(now),
  ]);

  const byWeek = new Map<number, WeeklyRow>();
  for (let index = 0; index < weeks; index += 1) {
    const weekStart = new Date(firstWeekStart);
    weekStart.setUTCDate(weekStart.getUTCDate() + index * 7);
    byWeek.set(weekStart.getTime(), emptyWeek(weekStart));
  }

  for (const row of weekRows) {
    const bucket = byWeek.get(startOfWeek(row.week).getTime());
    const column = WEEK_COLUMN_BY_EVENT[row.name];
    if (!bucket || !column) continue;
    (bucket[column] as number) = row.subjects;
  }

  // One flat plan, so a per-subscription price is enough to turn a subscriber
  // count into MRR. Taken from Stripe rather than hardcoded, and zero when
  // billing is not configured at all.
  const unitAmountCents =
    stripeStats && stripeStats.activeSubscribers > 0
      ? Math.round(stripeStats.mrrCents / stripeStats.activeSubscribers)
      : 0;

  let running = (priorPaid[0]?.started ?? 0) - (priorPaid[0]?.canceled ?? 0);
  const orderedWeeks = [...byWeek.values()].sort(
    (a, b) => a.weekStart.getTime() - b.weekStart.getTime()
  );
  for (const week of orderedWeeks) {
    running += week.newPaid - week.canceled;
    week.activePaid = Math.max(running, 0);
    week.mrrCents = week.activePaid * unitAmountCents;
  }

  const channelBuckets = new Map<AcquisitionChannel, ChannelRow>();
  for (const row of channelRows) {
    const channel = row.channel ?? 'OTHER';
    const bucket = channelBuckets.get(channel) ?? {
      channel,
      visitors: 0,
      signups: 0,
      trials: 0,
      paid: 0,
    };
    if (row.name === 'LANDING_VIEW') bucket.visitors += row.subjects;
    if (row.name === 'SIGNUP_COMPLETED') bucket.signups += row.subjects;
    if (row.name === 'TRIAL_STARTED') bucket.trials += row.subjects;
    if (row.name === 'SUBSCRIPTION_STARTED') bucket.paid += row.subjects;
    channelBuckets.set(channel, bucket);
  }

  // One row over the limit was fetched purely to tell "exactly full" from "cut off".
  const paidAccountsTruncated = paidAccounts.length > PAID_ACCOUNT_LIMIT;
  const accounts: PaidAccountRow[] = paidAccounts.slice(0, PAID_ACCOUNT_LIMIT).map((row) => ({
    userId: row.user_id,
    name: row.name,
    email: row.email,
    status: row.status,
    channel: row.channel,
    selfReported: row.self_reported,
    valueEvents7: row.value_events_7,
    valueEvents30: row.value_events_30,
    lastValueEventAt: row.last_value_event_at,
  }));

  const silentBefore = new Date(now);
  silentBefore.setUTCDate(silentBefore.getUTCDate() - AT_RISK_SILENT_DAYS);

  return {
    weeks: orderedWeeks,
    channels: [...channelBuckets.values()].sort((a, b) => b.visitors - a.visitors),
    channelWindowDays: CHANNEL_WINDOW_DAYS,
    paidAccounts: accounts,
    paidAccountsTruncated,
    paidAccountLimit: PAID_ACCOUNT_LIMIT,
    atRisk: accounts.filter(
      (account) => !account.lastValueEventAt || account.lastValueEventAt < silentBefore
    ),
    currentActivePaid: stripeStats?.activeSubscribers ?? null,
    currentMrrCents: stripeStats?.mrrCents ?? null,
    currency: stripeStats?.currency ?? 'usd',
    cohorts,
  };
}
