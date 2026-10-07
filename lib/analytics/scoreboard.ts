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
import {
  getTeamUploadersByAccount,
  uploaderWindowStart,
  type TeamUploader,
} from '@/lib/uploader-stats';
import { countedEventSql } from '@/lib/stats-exclusion';

/**
 * What "using the product" means for a paying account.
 *
 * The second half is everyday use, written at most once per account per day, so
 * an account that only pushes new versions or reviews live is not read as
 * silent. None of it is in WEEK_COLUMN_BY_EVENT, which keeps the funnel as it
 * was. Those events only exist from the day they shipped; earlier activity of
 * that kind was never recorded and cannot be backfilled. They also raise the
 * 7- and 30-day counts (up to five a day for a busy account), so those counts
 * are not comparable with ones taken before the change; the silence check only
 * reads the latest event and is unaffected.
 */
export const VALUE_EVENT_NAMES = [
  'VIDEO_ADDED',
  'SHARE_LINK_CREATED',
  'FIRST_GUEST_COMMENT',
  'APPROVAL_COMPLETED',
  'PROJECT_CREATED',
  'VERSION_ADDED',
  'COMMENT_ADDED',
  'LIVE_REVIEW_STARTED',
  'LIVE_REVIEW_JOINED',
  'APPROVAL_REQUESTED',
] as const;

/** A paid account that has produced nothing for this long is drifting away. */
export const AT_RISK_SILENT_DAYS = 14;

const DEFAULT_WEEKS = 12;
const CHANNEL_WINDOW_DAYS = 28;
const REFERRAL_ROW_LIMIT = 25;

/**
 * The row a PAID visitor with no utm_campaign is filed under. sanitizeTag never
 * stores parentheses, so no real keyword can collide with it.
 */
export const NO_KEYWORD_LABEL = '(no keyword)';

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

/**
 * Where the REFERRAL channel's visitors came from and where they landed.
 *
 * REFERRAL is the catch-all for a site no list recognises, so its total says
 * nothing until it is broken down: one forum thread, a spam referrer and our own
 * pages filed by mistake all look the same as a single number.
 *
 * Touches recorded before the proxy compared referrers against the public host
 * can still show our own domain here; they age out of the window, they are not
 * rewritten.
 */
export interface ReferralRow {
  referrerHost: string | null;
  landingPath: string | null;
  visitors: number;
}

/**
 * One keyword of the paid search campaign, read from utm_campaign.
 *
 * Visitors are first touches and signups are accounts created in the window, so
 * both are counted where they started. Trials and paid follow the channels rows:
 * events in the window, read through the account's first touch.
 */
export interface PaidCampaignRow {
  campaign: string;
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
  /**
   * Distinct collaborators who uploaded into this account's workspaces in the
   * last UPLOADER_WINDOW_DAYS, excluding the workspace owner.
   */
  uploaders30: number;
  teamUploaders30: TeamUploader[];
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
  /** The busiest REFERRAL host and landing path pairs over the channel window. */
  referrals: ReferralRow[];
  /** The PAID channel per utm_campaign over the channel window, busiest first. */
  paidCampaigns: PaidCampaignRow[];
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

interface ReferralQueryRow {
  referrer_host: string | null;
  landing_path: string | null;
  visitors: number;
}

export interface CampaignCountRow {
  campaign: string | null;
  subjects: number;
}

export interface CampaignEventRow extends CampaignCountRow {
  name: string;
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
 * Folds the three per-campaign counts into one row per keyword.
 *
 * Each source groups on its own, so a keyword can appear in any of them alone: a
 * signup whose first touch is older than the window still gets its row.
 */
export function mergePaidCampaigns(
  visitorRows: CampaignCountRow[],
  signupRows: CampaignCountRow[],
  eventRows: CampaignEventRow[]
): PaidCampaignRow[] {
  const byCampaign = new Map<string, PaidCampaignRow>();
  const bucket = (campaign: string | null) => {
    const label = campaign ?? NO_KEYWORD_LABEL;
    const existing = byCampaign.get(label);
    if (existing) return existing;
    const row = { campaign: label, visitors: 0, signups: 0, trials: 0, paid: 0 };
    byCampaign.set(label, row);
    return row;
  };

  for (const row of visitorRows) bucket(row.campaign).visitors += row.subjects;
  for (const row of signupRows) bucket(row.campaign).signups += row.subjects;
  for (const row of eventRows) {
    if (row.name === 'TRIAL_STARTED') bucket(row.campaign).trials += row.subjects;
    if (row.name === 'SUBSCRIPTION_STARTED') bucket(row.campaign).paid += row.subjects;
  }

  return [...byCampaign.values()].sort(
    (a, b) => b.visitors - a.visitors || a.campaign.localeCompare(b.campaign)
  );
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
    WHERE ((u."createdAt" >= ${beforeStart} AND u."createdAt" < ${beforeEnd})
       OR (u."createdAt" >= ${afterStart} AND u."createdAt" < ${afterEnd}))
      AND NOT u."excludedFromStats"
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

  const [
    weekRows,
    channelRows,
    referralRows,
    campaignVisitorRows,
    campaignSignupRows,
    campaignEventRows,
    priorPaid,
    paidAccounts,
    stripeStats,
    cohorts,
    uploaders,
  ] = await Promise.all([
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
        AND ${countedEventSql('analytics_events')}
      GROUP BY 1, 2
    `,
    db.$queryRaw<ChannelQueryRow[]>`
      SELECT COALESCE(ua.channel, e.channel) AS channel,
             e.name::text AS name,
             COUNT(DISTINCT COALESCE(e.anonymous_id, e.id))::int AS subjects
      FROM analytics_events e
      LEFT JOIN user_acquisitions ua ON ua.user_id = e.user_id
      WHERE e.occurred_at >= ${channelWindowStart}
        AND ${countedEventSql('e')}
      GROUP BY 1, 2
    `,
    // Same channel rule as the table above, so these rows add up to its REFERRAL
    // visitors whenever there are no more than the limit.
    db.$queryRaw<ReferralQueryRow[]>`
      SELECT COALESCE(ua.referrer_host, t.referrer_host) AS referrer_host,
             COALESCE(ua.landing_path, t.landing_path) AS landing_path,
             COUNT(DISTINCT COALESCE(e.anonymous_id, e.id))::int AS visitors
      FROM analytics_events e
      LEFT JOIN user_acquisitions ua ON ua.user_id = e.user_id
      LEFT JOIN acquisition_touches t ON t.anonymous_id = e.anonymous_id
      WHERE e.occurred_at >= ${channelWindowStart}
        AND e.name::text = 'LANDING_VIEW'
        AND COALESCE(ua.channel, e.channel)::text = 'REFERRAL'
        AND ${countedEventSql('e')}
      GROUP BY 1, 2
      ORDER BY 3 DESC, 1 ASC NULLS LAST, 2 ASC NULLS LAST
      LIMIT ${REFERRAL_ROW_LIMIT}
    `,
    // A touch left by a browser that later signed up to an excluded account is
    // dropped, the same rule countedEventSql applies to the channels' visitors.
    db.$queryRaw<CampaignCountRow[]>`
      SELECT t.utm_campaign AS campaign, COUNT(*)::int AS subjects
      FROM acquisition_touches t
      WHERE t.channel::text = 'PAID'
        AND t.created_at >= ${channelWindowStart}
        AND NOT EXISTS (
          SELECT 1 FROM user_acquisitions excluded_visit
          JOIN users excluded ON excluded.id = excluded_visit.user_id
          WHERE excluded_visit.anonymous_id = t.anonymous_id AND excluded."excludedFromStats"
        )
      GROUP BY 1
    `,
    db.$queryRaw<CampaignCountRow[]>`
      SELECT ua.utm_campaign AS campaign, COUNT(*)::int AS subjects
      FROM user_acquisitions ua
      JOIN users u ON u.id = ua.user_id
      WHERE ua.channel::text = 'PAID'
        AND ua.created_at >= ${channelWindowStart}
        AND NOT u."excludedFromStats"
      GROUP BY 1
    `,
    // The channel rule of the channels table. The keyword comes from the account
    // when there is one, even a null one, so it always agrees with the channel
    // it was read beside; only an event with no account falls back to the touch.
    db.$queryRaw<CampaignEventRow[]>`
      SELECT CASE WHEN ua.user_id IS NOT NULL THEN ua.utm_campaign ELSE t.utm_campaign END
               AS campaign,
             e.name::text AS name,
             COUNT(DISTINCT COALESCE(e.anonymous_id, e.id))::int AS subjects
      FROM analytics_events e
      LEFT JOIN user_acquisitions ua ON ua.user_id = e.user_id
      LEFT JOIN acquisition_touches t ON t.anonymous_id = e.anonymous_id
      WHERE e.occurred_at >= ${channelWindowStart}
        AND e.name::text IN ('TRIAL_STARTED', 'SUBSCRIPTION_STARTED')
        AND COALESCE(ua.channel, e.channel)::text = 'PAID'
        AND ${countedEventSql('e')}
      GROUP BY 1, 2
    `,
    db.$queryRaw<Array<{ started: number; canceled: number }>>`
      SELECT
        COUNT(*) FILTER (WHERE name::text = 'SUBSCRIPTION_STARTED')::int AS started,
        COUNT(*) FILTER (WHERE name::text = 'SUBSCRIPTION_CANCELED')::int AS canceled
      FROM analytics_events
      WHERE occurred_at < ${firstWeekStart}
        AND ${countedEventSql('analytics_events')}
    `,
    db.$queryRaw<PaidQueryRow[]>`
      SELECT u.id AS user_id,
             u.name,
             u.email,
             -- A cardless trial has no Stripe subscription to carry the status,
             -- so it sits at FREE with only a date to go on. Reported as the
             -- trial it is, and matched by the WHERE below for the same reason.
             CASE
               WHEN u."subscriptionStatus"::text = 'FREE' AND u."trialEndsAt" > NOW()
                 THEN 'TRIALING'
               ELSE u."subscriptionStatus"::text
             END AS status,
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
      WHERE (u."subscriptionStatus"::text IN ('ACTIVE', 'TRIALING')
         OR (u."subscriptionStatus"::text = 'FREE' AND u."trialEndsAt" > NOW()))
        AND NOT u."excludedFromStats"
      GROUP BY u.id, u.name, u.email, u."subscriptionStatus", u."trialEndsAt", ua.channel,
               ua.self_reported
      ORDER BY MAX(e.occurred_at) ASC NULLS FIRST
      LIMIT ${PAID_ACCOUNT_LIMIT + 1}
    `,
    getCachedStripeStats(),
    getCohortComparison(now),
    getTeamUploadersByAccount(uploaderWindowStart(now)),
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
    uploaders30: uploaders[row.user_id]?.length ?? 0,
    teamUploaders30: uploaders[row.user_id] ?? [],
  }));

  const silentBefore = new Date(now);
  silentBefore.setUTCDate(silentBefore.getUTCDate() - AT_RISK_SILENT_DAYS);

  return {
    weeks: orderedWeeks,
    channels: [...channelBuckets.values()].sort((a, b) => b.visitors - a.visitors),
    channelWindowDays: CHANNEL_WINDOW_DAYS,
    referrals: referralRows.map((row) => ({
      referrerHost: row.referrer_host,
      landingPath: row.landing_path,
      visitors: row.visitors,
    })),
    paidCampaigns: mergePaidCampaigns(campaignVisitorRows, campaignSignupRows, campaignEventRows),
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
