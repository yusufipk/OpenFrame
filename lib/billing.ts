import type { Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { BillingSubscriptionStatus, InvitationStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { getStripe, getStripePriceId } from '@/lib/stripe';
import { isStripeFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { recordSubscriptionTransition } from '@/lib/analytics/billing-events';
import { eventKey, recordEvent } from '@/lib/analytics/record';
import { TRIAL_WORKSPACE_LIMIT } from '@/lib/trial-limits';

const ACTIVE_SUBSCRIPTION_STATUSES = new Set<BillingSubscriptionStatus>([
  BillingSubscriptionStatus.ACTIVE,
  BillingSubscriptionStatus.TRIALING,
]);

// Statuses that mean the customer already has a live Stripe subscription that
// should be recovered (via the billing portal / dunning) rather than duplicated
// with a fresh checkout. Everything else (FREE, CANCELED, INCOMPLETE_EXPIRED)
// has no recoverable subscription, so a new checkout is appropriate.
const RECOVERABLE_SUBSCRIPTION_STATUSES = new Set<BillingSubscriptionStatus>([
  BillingSubscriptionStatus.ACTIVE,
  BillingSubscriptionStatus.TRIALING,
  BillingSubscriptionStatus.PAST_DUE,
  BillingSubscriptionStatus.UNPAID,
  BillingSubscriptionStatus.INCOMPLETE,
]);

// Statuses that mean no payment on this subscription has ever gone through.
// Stripe stamps a current period on an `incomplete` subscription all the same,
// so a checkout whose first charge failed leaves `stripeCurrentPeriodEnd` a
// month into the future with nothing paid behind it. Every other status in the
// enum follows at least one successful charge, or has no period end at all.
const UNPAID_SUBSCRIPTION_STATUSES = new Set<BillingSubscriptionStatus>([
  BillingSubscriptionStatus.INCOMPLETE,
  BillingSubscriptionStatus.INCOMPLETE_EXPIRED,
]);

// The Stripe-side counterpart of RECOVERABLE_SUBSCRIPTION_STATUSES, for the places that
// hold a raw Stripe subscription rather than the mirrored status. Deliberately the same
// membership: a subscription worth cancelling is a subscription worth blocking a second
// checkout over, and two sets that disagreed only produced a Cancel button that always
// failed and a checkout guard weaker than the mirror it was backing up.
const LIVE_STRIPE_STATUSES = new Set<Stripe.Subscription.Status>([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete',
]);

// Cancelling one of these takes effect immediately: the open period was never paid for,
// so there is nothing left to run out.
const UNPAID_STRIPE_STATUSES = new Set<Stripe.Subscription.Status>([
  'past_due',
  'unpaid',
  'incomplete',
]);

// A subscription that was running and then missed a payment. It keeps access while Stripe
// retries the card, so a customer whose card expired is not locked out before they have
// had a chance to fix it. `incomplete` is not here: nothing has ever been paid on it.
const RETRYING_STRIPE_STATUSES = new Set<Stripe.Subscription.Status>(['past_due', 'unpaid']);

// Roughly Stripe's default Smart Retries window. Access follows the retry window rather
// than the period Stripe advanced when it issued the invoice that was never paid.
const UNPAID_ACCESS_GRACE_DAYS = 14;

export const DEFAULT_TRIAL_PERIOD_DAYS = 7;
const STORAGE_CLEANUP_GRACE_DAYS = 15;

type BillingAccessSubject = {
  subscriptionStatus: BillingSubscriptionStatus;
  trialEndsAt: Date | null;
  stripeCurrentPeriodEnd: Date | null;
  stripeCancelAtPeriodEnd?: boolean | null;
  stripeCancelAt?: Date | null;
  billingAccessEndedAt: Date | null;
};

export function getDefaultTrialEndsAt(from: Date = new Date()) {
  return new Date(from.getTime() + DEFAULT_TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000);
}

export function hasActiveTrial(trialEndsAt: Date | null | undefined, now: Date = new Date()) {
  return Boolean(trialEndsAt && trialEndsAt.getTime() > now.getTime());
}

/**
 * The trial end date to keep when a Stripe sync has none of its own.
 *
 * An unexpired trial is an entitlement the account already holds, so billing
 * state may add access but must never take a trial back before it has run out.
 * Without this, a trial user who starts a checkout and abandons the card step
 * lands on an `incomplete` subscription carrying no `trial_end`, and the sync
 * would write `trialEndsAt: null` over their remaining days and lock them out of
 * a product they were still entitled to. Nothing can be farmed this way either:
 * `billingTrialConsumedAt` is what makes the trial once-per-account, and it is
 * never cleared.
 */
export function keepUnexpiredTrial(trialEndsAt: Date | null | undefined, now: Date = new Date()) {
  return hasActiveTrial(trialEndsAt, now) ? (trialEndsAt ?? null) : null;
}

export function hasActiveSubscription(status: BillingSubscriptionStatus | null | undefined) {
  if (!status) return false;
  return ACTIVE_SUBSCRIPTION_STATUSES.has(status);
}

// True when the customer already has a live subscription (active/trialing OR a
// recoverable one like past_due/unpaid/incomplete). Used to route them to the
// billing portal instead of letting a new checkout create a duplicate.
export function hasRecoverableSubscription(status: BillingSubscriptionStatus | null | undefined) {
  if (!status) return false;
  return RECOVERABLE_SUBSCRIPTION_STATUSES.has(status);
}

/**
 * Whether this account is a paying customer, as opposed to one that merely has
 * access right now.
 *
 * The cardless trial makes these two different questions for the first time: a
 * trial account passes `hasBillingAccess` with no card and no Stripe customer
 * behind it. Every ceiling that exists to bound what an unpaid account can cost
 * us (storage, upload size, workspace count) hangs off this, not off access.
 * A legacy Stripe trial counts as paid because a card was handed over for it.
 */
export function isPaidTier(
  subject: Pick<
    BillingAccessSubject,
    'subscriptionStatus' | 'stripeCurrentPeriodEnd' | 'billingAccessEndedAt'
  >,
  now: Date = new Date()
) {
  if (!isStripeFeatureEnabled()) {
    return true;
  }

  if (hasActiveSubscription(subject.subscriptionStatus)) {
    return true;
  }

  // The period end alone is not proof of payment.
  if (UNPAID_SUBSCRIPTION_STATUSES.has(subject.subscriptionStatus)) {
    return false;
  }

  // Same cutoff `hasBillingAccess` applies, so the two cannot disagree about a customer
  // behind on payment. They did once: access stopped at the end of Stripe's retry window
  // while this kept saying "paid" for the rest of the period, which left the account with
  // no banner explaining the lockout and able to create workspaces it could not then see.
  if (subject.billingAccessEndedAt && subject.billingAccessEndedAt.getTime() <= now.getTime()) {
    return false;
  }

  return Boolean(
    subject.stripeCurrentPeriodEnd && subject.stripeCurrentPeriodEnd.getTime() > now.getTime()
  );
}

export function hasBillingAccess(subject: BillingAccessSubject, now: Date = new Date()) {
  if (!isStripeFeatureEnabled()) {
    return true;
  }

  if (hasActiveSubscription(subject.subscriptionStatus)) {
    return true;
  }

  if (hasActiveTrial(subject.trialEndsAt, now)) {
    return true;
  }

  // Everything below decides whether the reported period still stands in for access, and
  // the two guards exist because it very often does not. Both are scoped to this branch
  // rather than applied at the top of the function: `billingAccessEndedAt` is only ever
  // cleared by a Stripe sync, so a stale one from a lapsed subscription would otherwise
  // outrank a freshly started cardless trial and burn the account's one trial for nothing.

  // Stripe stamps a period on a subscription whose first charge never went through, so
  // that period is not evidence of payment. The same rejection `isPaidTier` makes.
  if (UNPAID_SUBSCRIPTION_STATUSES.has(subject.subscriptionStatus)) {
    return false;
  }

  // Stripe advances the period the moment it issues the renewal invoice, paid or not, and
  // the period survives cancellation, so on its own it would hand a full free month to
  // anyone whose renewal fails. This is the bound: a subscription behind on payment is
  // stamped with the end of Stripe's retry window, a cancelled one with `ended_at`.
  if (subject.billingAccessEndedAt && subject.billingAccessEndedAt.getTime() <= now.getTime()) {
    return false;
  }

  return Boolean(
    subject.stripeCurrentPeriodEnd && subject.stripeCurrentPeriodEnd.getTime() > now.getTime()
  );
}

export function getBillingAccessEndDate(subject: BillingAccessSubject) {
  if (subject.billingAccessEndedAt) {
    return subject.billingAccessEndedAt;
  }

  if (subject.stripeCurrentPeriodEnd) {
    return subject.stripeCurrentPeriodEnd;
  }

  return subject.trialEndsAt;
}

export function getStorageCleanupEligibleAt(subject: BillingAccessSubject) {
  const accessEndDate = getBillingAccessEndDate(subject);
  if (!accessEndDate) return null;

  return new Date(accessEndDate.getTime() + STORAGE_CLEANUP_GRACE_DAYS * 24 * 60 * 60 * 1000);
}

export function buildBillingAccessWhereInput(now: Date = new Date()): Prisma.UserWhereInput {
  if (!isStripeFeatureEnabled()) {
    return {};
  }

  // Mirrors `hasBillingAccess` branch for branch, including the two guards scoped to its
  // period-end arm, so the query and the in-memory check cannot disagree about who still
  // has access.
  return {
    OR: [
      {
        subscriptionStatus: {
          in: [BillingSubscriptionStatus.ACTIVE, BillingSubscriptionStatus.TRIALING],
        },
      },
      { trialEndsAt: { gt: now } },
      {
        stripeCurrentPeriodEnd: { gt: now },
        subscriptionStatus: { notIn: [...UNPAID_SUBSCRIPTION_STATUSES] },
        OR: [{ billingAccessEndedAt: null }, { billingAccessEndedAt: { gt: now } }],
      },
    ],
  };
}

export function buildExpiredBillingWhereInput(now: Date = new Date()): Prisma.UserWhereInput {
  const cleanupCutoff = new Date(now.getTime() - STORAGE_CLEANUP_GRACE_DAYS * 24 * 60 * 60 * 1000);

  // Without billing nothing can expire, so nobody is eligible. This used to fall through to
  // `NOT: {}`, which Prisma drops entirely, leaving a filter that matched on the grace period
  // alone: a self-hosted deployment running the cleanup script would delete the workspaces of
  // users it never charged.
  if (!isStripeFeatureEnabled()) {
    return { id: { in: [] } };
  }

  // Spelled out as positive AND branches instead of `NOT: buildBillingAccessWhereInput(now)`.
  // Prisma renders that NOT as `NOT (status IN (...) OR "trialEndsAt" > $1 OR
  // "stripeCurrentPeriodEnd" > $2)`, and SQL comparisons against NULL are unknown rather than
  // false, so for a row with both dates empty the OR evaluates to NULL and NOT NULL is still
  // NULL: the row is never returned. Both columns empty is exactly what a canceled subscriber
  // looks like (markSubscriptionCanceledByCustomerId clears trialEndsAt, and Stripe no longer
  // reports current_period_end on the subscription), so the cleanup silently matched nobody.
  return {
    AND: [
      {
        subscriptionStatus: {
          notIn: [BillingSubscriptionStatus.ACTIVE, BillingSubscriptionStatus.TRIALING],
        },
      },
      { OR: [{ trialEndsAt: null }, { trialEndsAt: { lte: now } }] },
      { OR: [{ stripeCurrentPeriodEnd: null }, { stripeCurrentPeriodEnd: { lte: now } }] },
      {
        OR: [
          { billingAccessEndedAt: { lte: cleanupCutoff } },
          {
            AND: [{ billingAccessEndedAt: null }, { trialEndsAt: { lte: cleanupCutoff } }],
          },
        ],
      },
    ],
  };
}

export function mapStripeSubscriptionStatus(
  status: Stripe.Subscription.Status | null | undefined
): BillingSubscriptionStatus {
  switch (status) {
    case 'trialing':
      return BillingSubscriptionStatus.TRIALING;
    case 'active':
      return BillingSubscriptionStatus.ACTIVE;
    case 'past_due':
      return BillingSubscriptionStatus.PAST_DUE;
    case 'canceled':
      return BillingSubscriptionStatus.CANCELED;
    case 'unpaid':
      return BillingSubscriptionStatus.UNPAID;
    case 'incomplete':
      return BillingSubscriptionStatus.INCOMPLETE;
    case 'incomplete_expired':
      return BillingSubscriptionStatus.INCOMPLETE_EXPIRED;
    default:
      return BillingSubscriptionStatus.FREE;
  }
}

export function getBillingStatusLabel(status: BillingSubscriptionStatus) {
  switch (status) {
    case BillingSubscriptionStatus.TRIALING:
      return 'Trialing';
    case BillingSubscriptionStatus.ACTIVE:
      return 'Active';
    case BillingSubscriptionStatus.PAST_DUE:
      return 'Past due';
    case BillingSubscriptionStatus.CANCELED:
      return 'Canceled';
    case BillingSubscriptionStatus.UNPAID:
      return 'Unpaid';
    case BillingSubscriptionStatus.INCOMPLETE:
      return 'Incomplete';
    case BillingSubscriptionStatus.INCOMPLETE_EXPIRED:
      return 'Expired';
    case BillingSubscriptionStatus.FREE:
    default:
      return 'Free';
  }
}

/**
 * A `where` matching the accounts whose only entitlement is a running cardless
 * trial: no Stripe subscription behind them, so `subscriptionStatus` is FREE.
 */
export function buildCardlessTrialWhereInput(now: Date = new Date()): Prisma.UserWhereInput {
  return {
    subscriptionStatus: BillingSubscriptionStatus.FREE,
    trialEndsAt: { gt: now },
  };
}

/**
 * The status to show for an account, which is not always the one Stripe stored.
 *
 * The cardless trial writes `trialEndsAt` and nothing else, because there is no
 * Stripe subscription behind it to report `trialing`. `subscriptionStatus` stays
 * FREE, so anything reading that column alone showed a running trial as a free
 * account: the admin dashboard counted every trial under "Free Users" and left
 * "On Trial" at zero. Access is already resolved from the date in
 * `hasBillingAccess`, so what is displayed follows the same date.
 *
 * Only FREE is overridden. Every other status means Stripe has an opinion about
 * this account (an abandoned checkout leaves INCOMPLETE while the trial runs on),
 * and that opinion is the more useful of the two to show.
 */
export function getEffectiveBillingStatus(
  subject: Pick<BillingAccessSubject, 'subscriptionStatus' | 'trialEndsAt'>,
  now: Date = new Date()
): BillingSubscriptionStatus {
  if (
    subject.subscriptionStatus === BillingSubscriptionStatus.FREE &&
    hasActiveTrial(subject.trialEndsAt, now)
  ) {
    return BillingSubscriptionStatus.TRIALING;
  }

  return subject.subscriptionStatus;
}

/**
 * A `where` that filters on the displayed status rather than the stored one, so
 * an admin asking for "Trialing" is handed the cardless trials and one asking
 * for "Free" is not.
 */
export function buildEffectiveBillingStatusWhereInput(
  status: BillingSubscriptionStatus,
  now: Date = new Date()
): Prisma.UserWhereInput {
  if (status === BillingSubscriptionStatus.TRIALING) {
    return {
      OR: [
        { subscriptionStatus: BillingSubscriptionStatus.TRIALING },
        buildCardlessTrialWhereInput(now),
      ],
    };
  }

  if (status === BillingSubscriptionStatus.FREE) {
    return {
      subscriptionStatus: BillingSubscriptionStatus.FREE,
      OR: [{ trialEndsAt: null }, { trialEndsAt: { lte: now } }],
    };
  }

  return { subscriptionStatus: status };
}

/**
 * Grants the cardless trial, once per account, and reports whether this call is
 * the one that granted it.
 *
 * Called where the email address is proven rather than where the account is
 * created: an unverifiable address gets no trial, which is the cheapest abuse
 * control available and the reason the two writes below can stay this simple.
 *
 * `billingTrialConsumedAt` is written here rather than only by the Stripe sync.
 * It is the once-per-account marker, so a re-issued verification link, a second
 * device or a replayed request all land on the `WHERE` clause and change nothing.
 *
 * Signup goes through `startCardlessTrialOnSignup` instead, which holds the trial
 * back for an account that only exists because somebody invited it. This is the
 * unconditional grant, reached later only when that account explicitly asks for
 * its deferred trial through the start-trial endpoint. It is never started as a
 * side effect of some other action; the clock costs the account its only trial.
 */
export async function startCardlessTrial(userId: string, now: Date = new Date()) {
  // Without billing nothing is gated, so a trial would be a date nobody reads.
  // Writing one anyway would consume the trial of a self-hosted instance that
  // later switches billing on.
  if (!isStripeFeatureEnabled()) {
    return false;
  }

  const { count } = await db.user.updateMany({
    where: { id: userId, trialEndsAt: null, billingTrialConsumedAt: null },
    data: {
      trialEndsAt: getDefaultTrialEndsAt(now),
      billingTrialConsumedAt: now,
    },
  });

  if (count === 0) {
    return false;
  }

  await recordEvent({
    name: 'TRIAL_STARTED',
    dedupeKey: eventKey('TRIAL_STARTED', userId),
    userId,
  });

  return true;
}

/**
 * Whether this account arrived as somebody else's collaborator.
 *
 * An invited member works inside the inviter's workspace on the inviter's
 * billing, so a trial handed to them at signup buys them nothing and is spent
 * before they have seen the product on an account of their own. Worse, it is
 * spent for good: `billingTrialConsumedAt` is never cleared, so the day they
 * consider becoming a customer themselves the trial is already gone.
 *
 * Two signals, because the invitation lands at different points on the two
 * signup paths. The credentials route accepts the token inside the same request
 * that creates the account, so by the time the trial is considered the
 * membership row exists. An OAuth signup creates the account on the way out to
 * the provider and accepts the invitation only on the way back, so there the
 * pending invitation is the only thing to go on.
 */
async function arrivedAsCollaborator(userId: string, now: Date) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  const [workspaceMemberships, projectMemberships, pendingInvitations] = await Promise.all([
    db.workspaceMember.count({
      where: { userId, workspace: { ownerId: { not: userId } } },
    }),
    db.projectMember.count({
      where: { userId, project: { ownerId: { not: userId } } },
    }),
    user?.email
      ? db.invitation.count({
          where: {
            email: user.email,
            status: InvitationStatus.PENDING,
            expiresAt: { gt: now },
          },
        })
      : Promise.resolve(0),
  ]);

  return workspaceMemberships > 0 || projectMemberships > 0 || pendingInvitations > 0;
}

/**
 * The trial as granted at signup: to everyone except an invited collaborator,
 * whose clock is deferred until they own something of their own.
 *
 * Nothing is lost by waiting. The deferred trial stays claimable forever: the
 * account starts it whenever it chooses through the start-trial endpoint, which
 * the workspace-creation and billing screens point at.
 */
export async function startCardlessTrialOnSignup(userId: string, now: Date = new Date()) {
  if (!isStripeFeatureEnabled()) {
    return false;
  }

  if (await arrivedAsCollaborator(userId, now)) {
    return false;
  }

  return startCardlessTrial(userId, now);
}

export async function getStripeCheckoutState(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      subscriptionStatus: true,
    },
  });

  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  return {
    hasActiveSubscription: hasActiveSubscription(user.subscriptionStatus),
    hasRecoverableSubscription: hasRecoverableSubscription(user.subscriptionStatus),
  };
}

export async function getWorkspaceCreationEligibility(userId: string) {
  const [user, ownedWorkspaceCount, invitedWorkspaceCount, projectOnlyCollaborationCount] =
    await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: {
          subscriptionStatus: true,
          trialEndsAt: true,
          billingTrialConsumedAt: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          stripePriceId: true,
          stripeCurrentPeriodEnd: true,
          stripeCancelAtPeriodEnd: true,
          stripeCancelAt: true,
          billingAccessEndedAt: true,
        },
      }),
      db.workspace.count({
        where: { ownerId: userId },
      }),
      db.workspaceMember.count({
        where: {
          userId,
          workspace: {
            ownerId: {
              not: userId,
            },
          },
        },
      }),
      db.projectMember.count({
        where: {
          userId,
          project: {
            ownerId: {
              not: userId,
            },
            workspace: {
              ownerId: {
                not: userId,
              },
            },
          },
        },
      }),
    ]);

  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  const billingAccess = hasBillingAccess(user);
  const isPaid = isPaidTier(user);
  const collaborationCount = invitedWorkspaceCount + projectOnlyCollaborationCount;
  // An invited collaborator whose trial was deferred at signup. Their trial is
  // still owed, but starting it is their call, not a side effect of clicking
  // "create workspace": the clock costs them their only trial, so it runs only
  // after they ask for it through the explicit start-trial endpoint.
  const canStartTrial =
    isStripeFeatureEnabled() && !billingAccess && !user.trialEndsAt && !user.billingTrialConsumedAt;

  // A paying account creates as many workspaces as it wants. Everyone else gets
  // one, which covers both the cardless trial and the pre-trial state where an
  // account may set a workspace up before it can open it.
  const canCreateWorkspace =
    !isStripeFeatureEnabled() ||
    isPaid ||
    ((billingAccess || collaborationCount === 0) && ownedWorkspaceCount < TRIAL_WORKSPACE_LIMIT);

  let reason: string | null = null;
  if (!canCreateWorkspace && isStripeFeatureEnabled()) {
    if (billingAccess && ownedWorkspaceCount >= TRIAL_WORKSPACE_LIMIT) {
      reason = 'Your free trial includes one workspace. Subscribe to create more.';
    } else if (canStartTrial && collaborationCount > 0 && ownedWorkspaceCount === 0) {
      reason =
        'You are collaborating in someone else’s workspace, so your free trial has not started yet. Start it to create a workspace of your own.';
    } else {
      reason = 'Your trial has ended. Start a subscription to create and keep owning workspaces.';
    }
  }

  return {
    canCreateWorkspace,
    canStartTrial,
    reason,
    ownedWorkspaceCount,
    invitedWorkspaceCount,
    projectOnlyCollaborationCount,
    subscription: {
      status: user.subscriptionStatus,
      label: getBillingStatusLabel(user.subscriptionStatus),
      hasActiveSubscription: hasActiveSubscription(user.subscriptionStatus),
      hasRecoverableSubscription: hasRecoverableSubscription(user.subscriptionStatus),
      hasActiveTrial: hasActiveTrial(user.trialEndsAt),
      hasBillingAccess: billingAccess,
      isPaid,
      stripeCustomerId: user.stripeCustomerId,
      stripeSubscriptionId: user.stripeSubscriptionId,
      stripePriceId: user.stripePriceId,
      currentPeriodEnd: user.stripeCurrentPeriodEnd,
      cancelAtPeriodEnd: user.stripeCancelAtPeriodEnd,
      cancelAt: user.stripeCancelAt,
      trialEndsAt: user.trialEndsAt,
      billingAccessEndedAt: user.billingAccessEndedAt,
      storageCleanupEligibleAt: getStorageCleanupEligibleAt(user),
    },
  };
}

export async function getBillingOverview(userId: string) {
  const billing = await getWorkspaceCreationEligibility(userId);

  return {
    workspaceCreation: {
      canCreateWorkspace: billing.canCreateWorkspace,
      canStartTrial: billing.canStartTrial,
      reason: billing.reason,
      ownedWorkspaceCount: billing.ownedWorkspaceCount,
      invitedWorkspaceCount: billing.invitedWorkspaceCount,
    },
    subscription: billing.subscription,
  };
}

/** How long before the trial runs out the countdown starts being shown. */
export const TRIAL_ENDING_NOTICE_DAYS = 3;

export interface TrialNotice {
  /** `ending` while access is still live, `ended` once it has lapsed. */
  kind: 'ending' | 'ended';
  endsAt: Date;
  /** When the cleanup job becomes eligible to delete this account's media. */
  contentKeptUntil: Date | null;
}

/**
 * The one-line trial status worth interrupting somebody with, or null.
 *
 * Both halves of the deadline are in one place because the useful message is the
 * pair: an account is told when the trial runs out and, separately, that running
 * out is not the moment its work disappears. The gap between those two dates is
 * the fifteen-day cleanup grace period, and until now nothing in the product said
 * it out loud, which made the end of a trial read as a deletion notice.
 */
export async function getTrialNotice(
  userId: string,
  now: Date = new Date()
): Promise<TrialNotice | null> {
  if (!isStripeFeatureEnabled()) {
    return null;
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      subscriptionStatus: true,
      trialEndsAt: true,
      stripeCurrentPeriodEnd: true,
      billingAccessEndedAt: true,
    },
  });

  // A paying account has a billing period, not a trial, and gets told about it
  // in settings rather than in a banner on every page.
  if (!user || isPaidTier(user, now)) {
    return null;
  }

  const contentKeptUntil = getStorageCleanupEligibleAt(user);

  const notice = ((): TrialNotice | null => {
    if (hasActiveTrial(user.trialEndsAt, now) && user.trialEndsAt) {
      const daysLeft = (user.trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
      if (daysLeft > TRIAL_ENDING_NOTICE_DAYS) {
        return null;
      }

      return { kind: 'ending', endsAt: user.trialEndsAt, contentKeptUntil };
    }

    const endsAt = getBillingAccessEndDate(user);
    if (!endsAt || hasBillingAccess(user, now)) {
      return null;
    }

    // Past the cleanup date there is nothing left to reassure anybody about.
    if (contentKeptUntil && contentKeptUntil.getTime() <= now.getTime()) {
      return null;
    }

    return { kind: 'ended', endsAt, contentKeptUntil };
  })();

  // Neither sentence is true for a guest in somebody else's workspace: no
  // deadline is coming for them, and the media the banner promises to keep is
  // not theirs and is not at risk. They were reading "your projects and media
  // are kept until" about a paying customer's work. Checked last so the queries
  // only run for the few accounts a banner was about to be shown to.
  if (notice && (await isCollaboratorWithNothingOfTheirOwn(userId, now))) {
    return null;
  }

  return notice;
}

/**
 * Somebody who only ever works inside workspaces they do not own.
 *
 * Ownership is what makes billing personal: the storage, the projects and the
 * cleanup deadline all hang off the owning account. An account that owns none of
 * that, and reaches the product entirely through a workspace whose owner is
 * paying, has nothing of its own on the line.
 */
async function isCollaboratorWithNothingOfTheirOwn(userId: string, now: Date) {
  const [ownedWorkspaceCount, collaborationCount] = await Promise.all([
    db.workspace.count({ where: { ownerId: userId } }),
    db.workspace.count({
      where: {
        ownerId: { not: userId },
        owner: buildBillingAccessWhereInput(now),
        OR: [
          { members: { some: { userId } } },
          { projects: { some: { members: { some: { userId } } } } },
        ],
      },
    }),
  ]);

  return ownedWorkspaceCount === 0 && collaborationCount > 0;
}

export async function getOrCreateStripeCustomerId(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      stripeCustomerId: true,
    },
  });

  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  if (user.stripeCustomerId) {
    return user.stripeCustomerId;
  }

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: user.email ?? undefined,
    name: user.name ?? undefined,
    metadata: { userId: user.id },
  });

  await db.user.update({
    where: { id: user.id },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

function getStripeTimestamp(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * The billing period moved off the subscription and onto its items in the Basil API
 * version, so reading `subscription.current_period_end` yields undefined on every current
 * version. Webhook payloads can still be rendered at an older version, so the legacy field
 * is kept as a fallback rather than dropped.
 */
export function getSubscriptionPeriodEnd(subscription: Stripe.Subscription): number | null {
  const itemPeriodEnds = (subscription.items?.data ?? [])
    .map((item) =>
      getStripeTimestamp(
        (item as Stripe.SubscriptionItem & { current_period_end?: unknown }).current_period_end
      )
    )
    .filter((value): value is number => value !== null);

  if (itemPeriodEnds.length > 0) {
    return Math.max(...itemPeriodEnds);
  }

  return getStripeTimestamp(
    (subscription as Stripe.Subscription & { current_period_end?: unknown }).current_period_end
  );
}

/**
 * Same field move as the period end. Stripe opens the new period when it issues the
 * renewal invoice, so for an unpaid subscription this is roughly when the first payment
 * attempt failed, which is what the retry window is measured from.
 */
export function getSubscriptionPeriodStart(subscription: Stripe.Subscription): number | null {
  const itemPeriodStarts = (subscription.items?.data ?? [])
    .map((item) =>
      getStripeTimestamp(
        (item as Stripe.SubscriptionItem & { current_period_start?: unknown }).current_period_start
      )
    )
    .filter((value): value is number => value !== null);

  if (itemPeriodStarts.length > 0) {
    return Math.min(...itemPeriodStarts);
  }

  return getStripeTimestamp(
    (subscription as Stripe.Subscription & { current_period_start?: unknown }).current_period_start
  );
}

/**
 * The invoice link to its subscription moved under `parent.subscription_details` in the
 * Basil API version. Same fallback reasoning as the period above.
 */
export function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const fromParent = invoice.parent?.subscription_details?.subscription;
  if (typeof fromParent === 'string') return fromParent;
  if (fromParent && typeof fromParent === 'object') return fromParent.id;

  const legacy = (invoice as Stripe.Invoice & { subscription?: unknown }).subscription;
  if (typeof legacy === 'string') return legacy;
  if (legacy && typeof legacy === 'object' && 'id' in legacy) {
    const id = (legacy as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }

  return null;
}

function getInactiveBillingAccessEndedAt(
  subscription: Stripe.Subscription,
  currentPeriodEnd: number | null
) {
  const endedAt = getStripeTimestamp(
    (subscription as Stripe.Subscription & { ended_at?: unknown }).ended_at
  );
  const canceledAt = getStripeTimestamp(
    (subscription as Stripe.Subscription & { canceled_at?: unknown }).canceled_at
  );

  // `ended_at` wins over everything: a subscription killed mid-period for non-payment
  // must not keep access until a period the customer never paid for.
  if (endedAt) {
    return new Date(endedAt * 1000);
  }

  // Still running, just behind on payment: access ends when Stripe gives up retrying, not
  // at the period end, which Stripe already advanced to cover the unpaid invoice. The
  // period start is when that invoice was issued, so it is what the window runs from; when
  // it is missing (a paginated item list, an older payload shape) the window runs from now
  // instead. Falling through to "ended" here would lock out the customer this branch
  // exists to keep in, which is the wrong way to fail on missing data.
  if (RETRYING_STRIPE_STATUSES.has(subscription.status)) {
    const grace = UNPAID_ACCESS_GRACE_DAYS * 24 * 60 * 60;
    const periodStart = getSubscriptionPeriodStart(subscription);
    const graceEnd = periodStart ? periodStart + grace : Math.floor(Date.now() / 1000) + grace;

    return new Date(Math.min(graceEnd, currentPeriodEnd ?? graceEnd) * 1000);
  }

  // A pause is not a non-payment: the period behind it was paid for, so it runs out
  // normally. Stripe's portal pauses keep the status `active`, but the API can set this.
  if (subscription.status === 'paused' && currentPeriodEnd) {
    return new Date(currentPeriodEnd * 1000);
  }

  // Anything else that gets here never paid for the period Stripe is reporting, so that
  // period is not a date access can run to. `incomplete` and `incomplete_expired` are the
  // cases that matter: their very first payment never went through.
  return canceledAt ? new Date(canceledAt * 1000) : new Date();
}

function getEntitledStripePriceId(subscription: Stripe.Subscription) {
  return hasEntitledPrice(subscription, getStripePriceId()) ? getStripePriceId() : null;
}

function hasEntitledPrice(subscription: Stripe.Subscription, configuredPriceId: string): boolean {
  return subscription.items.data.some((item) => item.price.id === configuredPriceId);
}

export async function syncStripeSubscriptionToUser(subscription: Stripe.Subscription) {
  const customerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;

  const user = await db.user.findUnique({
    where: { stripeCustomerId: customerId },
    select: {
      id: true,
      billingTrialConsumedAt: true,
      // Read so a cardless trial that has not run out survives this sync.
      trialEndsAt: true,
      // Read for the funnel: the transition is what gets recorded, so the state
      // being overwritten has to be captured before the update below.
      subscriptionStatus: true,
      stripeCancelAtPeriodEnd: true,
    },
  });

  if (!user) {
    return null;
  }

  const currentPeriodEnd = getSubscriptionPeriodEnd(subscription);
  const cancelAt =
    'cancel_at' in subscription && typeof subscription.cancel_at === 'number'
      ? subscription.cancel_at
      : null;
  const cancelAtPeriodEnd =
    'cancel_at_period_end' in subscription && typeof subscription.cancel_at_period_end === 'boolean'
      ? subscription.cancel_at_period_end
      : false;
  const trialEnd =
    'trial_end' in subscription && typeof subscription.trial_end === 'number'
      ? subscription.trial_end
      : null;
  const entitledPriceId = getEntitledStripePriceId(subscription);
  const hasEntitledPrice = Boolean(entitledPriceId);
  const mappedStatus = hasEntitledPrice
    ? mapStripeSubscriptionStatus(subscription.status)
    : BillingSubscriptionStatus.FREE;
  const effectiveCurrentPeriodEnd =
    hasEntitledPrice && currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null;
  const effectiveTrialEnd = hasEntitledPrice && trialEnd ? new Date(trialEnd * 1000) : null;
  // Stripe grants no trials any more, so `effectiveTrialEnd` is null for every
  // subscription created after the cardless trial shipped, and this fallback is
  // what stops an abandoned or failed checkout from erasing the days the account
  // still had. Legacy card-backed trials keep arriving through the branch above.
  const preservedTrialEnd = effectiveTrialEnd ?? keepUnexpiredTrial(user.trialEndsAt);
  // The reported period is not proof of payment: Stripe advances it when it issues the
  // renewal invoice, paid or not, and it survives cancellation. Access therefore follows
  // the status, and every other case gets a cutoff stamped into `billingAccessEndedAt`,
  // which is cleared again as soon as the subscription goes back to active.
  const hasAccess = hasEntitledPrice && hasActiveSubscription(mappedStatus);

  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      stripeSubscriptionId: subscription.id,
      stripePriceId: entitledPriceId ?? subscription.items.data[0]?.price.id ?? null,
      stripeCurrentPeriodEnd: effectiveCurrentPeriodEnd,
      stripeCancelAtPeriodEnd: cancelAtPeriodEnd,
      stripeCancelAt: cancelAt ? new Date(cancelAt * 1000) : null,
      subscriptionStatus: mappedStatus,
      trialEndsAt: preservedTrialEnd,
      billingTrialConsumedAt:
        hasEntitledPrice && trialEnd
          ? (user.billingTrialConsumedAt ?? new Date())
          : user.billingTrialConsumedAt,
      // A live trial means access has not ended, whatever the subscription says.
      // Stamping an end date here while the trial runs would date the storage
      // cleanup from today and tell the user their work dies before their trial
      // does. `hasActiveTrial`, not merely a non-null date: a legacy Stripe trial
      // that has already elapsed is a reason to stamp the end date, not to skip it.
      billingAccessEndedAt:
        hasAccess || hasActiveTrial(preservedTrialEnd)
          ? null
          : getInactiveBillingAccessEndedAt(
              subscription,
              hasEntitledPrice ? currentPeriodEnd : null
            ),
    },
  });

  await recordSubscriptionTransition({
    userId: user.id,
    subscriptionId: subscription.id,
    before: {
      status: user.subscriptionStatus,
      cancelAtPeriodEnd: user.stripeCancelAtPeriodEnd,
      hadTrial: user.billingTrialConsumedAt !== null,
    },
    after: {
      status: mappedStatus,
      cancelAtPeriodEnd,
      trialEndsAt: preservedTrialEnd,
      currentPeriodEnd: effectiveCurrentPeriodEnd,
    },
  });

  return updated;
}

// A single Stripe customer can own several subscriptions at once (e.g. after
// going past_due and re-subscribing). Higher priority = more authoritative for
// deciding the user's entitlement.
const SUBSCRIPTION_STATUS_PRIORITY: Record<Stripe.Subscription.Status, number> = {
  active: 100,
  trialing: 90,
  past_due: 80,
  unpaid: 70,
  paused: 60,
  incomplete: 50,
  incomplete_expired: 20,
  canceled: 10,
};

// Picks the subscription that should drive the user's billing state when a
// customer has more than one. Prefers subscriptions that carry the entitled
// price, then the most "alive" status, then the most recently created.
export function selectAuthoritativeSubscription(
  subscriptions: Stripe.Subscription[]
): Stripe.Subscription | null {
  if (subscriptions.length === 0) {
    return null;
  }

  // Read once, up front. Reading it inside the comparator meant a deployment with no
  // STRIPE_PRICE_ID configured worked for every customer holding one subscription and
  // threw only for those holding two, because a comparator never runs for a one-element
  // array. That is a miserable failure mode to diagnose in production.
  const configuredPriceId = getStripePriceId();

  return [...subscriptions].sort((a, b) => {
    const aEntitled = hasEntitledPrice(a, configuredPriceId);
    const bEntitled = hasEntitledPrice(b, configuredPriceId);
    if (aEntitled !== bEntitled) {
      return aEntitled ? -1 : 1;
    }

    const aStatus = SUBSCRIPTION_STATUS_PRIORITY[a.status] ?? 0;
    const bStatus = SUBSCRIPTION_STATUS_PRIORITY[b.status] ?? 0;
    if (aStatus !== bStatus) {
      return bStatus - aStatus;
    }

    return (getStripeTimestamp(b.created) ?? 0) - (getStripeTimestamp(a.created) ?? 0);
  })[0];
}

// Source-of-truth sync: instead of trusting a single subscription from a webhook
// event body (which may be an OLD subscription being deleted while a NEWER one is
// active), re-list ALL of the customer's subscriptions from Stripe and sync the
// authoritative one. This is order-independent and self-healing.
export async function syncStripeCustomerSubscriptions(customerId: string) {
  const stripe = getStripe();
  const { data: subscriptions } = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  });

  const authoritative = selectAuthoritativeSubscription(subscriptions);
  if (!authoritative) {
    return markSubscriptionCanceledByCustomerId(customerId);
  }

  return syncStripeSubscriptionToUser(authoritative);
}

export async function markSubscriptionCanceledByCustomerId(
  customerId: string,
  options?: { currentPeriodEnd?: Date | null; endedAt?: Date | null }
) {
  const user = await db.user.findUnique({
    where: { stripeCustomerId: customerId },
    select: {
      id: true,
      subscriptionStatus: true,
      stripeSubscriptionId: true,
      stripeCancelAtPeriodEnd: true,
      stripeCurrentPeriodEnd: true,
      billingTrialConsumedAt: true,
      trialEndsAt: true,
    },
  });

  if (!user) {
    return null;
  }

  // Losing the subscription does not retract a trial that has not run out. The
  // account keeps the days it was given and lands back on the trial's own end
  // date, which is also what the cancellation copy in settings promises.
  const preservedTrialEnd = keepUnexpiredTrial(user.trialEndsAt);

  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      subscriptionStatus: BillingSubscriptionStatus.CANCELED,
      trialEndsAt: preservedTrialEnd,
      stripeSubscriptionId: null,
      stripePriceId: null,
      stripeCurrentPeriodEnd: options?.currentPeriodEnd ?? null,
      stripeCancelAtPeriodEnd: false,
      stripeCancelAt: null,
      billingAccessEndedAt: preservedTrialEnd
        ? null
        : (options?.endedAt ?? options?.currentPeriodEnd ?? new Date()),
    },
  });

  // Reached when the customer has no subscriptions left at all. The cycle marker
  // uses the period end being cleared here, which is the same one the earlier
  // "cancel at period end" write carried, so a customer who cancelled through the
  // portal and then reached the end of their term produces one cancellation, not two.
  await recordSubscriptionTransition({
    userId: user.id,
    subscriptionId: user.stripeSubscriptionId ?? user.id,
    before: {
      status: user.subscriptionStatus,
      cancelAtPeriodEnd: user.stripeCancelAtPeriodEnd,
      hadTrial: user.billingTrialConsumedAt !== null,
    },
    after: {
      status: BillingSubscriptionStatus.CANCELED,
      cancelAtPeriodEnd: false,
      trialEndsAt: preservedTrialEnd,
      currentPeriodEnd: options?.currentPeriodEnd ?? user.stripeCurrentPeriodEnd ?? null,
    },
  });

  return updated;
}

/**
 * Returns a subscription of this customer that still grants access, if any. A customer can
 * hold several at once, so the state of one says nothing about the others.
 */
export async function findLiveStripeSubscription(customerId: string) {
  const stripe = getStripe();
  const { data: subscriptions } = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  });

  return (
    selectAuthoritativeSubscription(
      subscriptions.filter((subscription) => LIVE_STRIPE_STATUSES.has(subscription.status))
    ) ?? null
  );
}

/**
 * Asked before opening checkout. Answered by Stripe rather than by the local mirror: the
 * mirror can be stale or cleared, and a customer who slips past this ends up paying for two
 * subscriptions at once.
 */
export async function findBlockingStripeSubscription(customerId: string) {
  const stripe = getStripe();
  const { data: subscriptions } = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  });

  return (
    subscriptions.find((subscription) => LIVE_STRIPE_STATUSES.has(subscription.status)) ?? null
  );
}

export function isUnpaidStripeSubscription(subscription: Stripe.Subscription) {
  return UNPAID_STRIPE_STATUSES.has(subscription.status);
}

/**
 * Cancelling a subscription in Stripe does not stop collection on invoices that were
 * already issued; they keep retrying on their own until they are paid or voided. Voiding
 * them is what actually stops the card being charged after someone has cancelled.
 *
 * Note this writes off a real receivable, not only an unserved one: a `past_due` customer
 * has had access for up to `UNPAID_ACCESS_GRACE_DAYS` before they get here. That is a
 * deliberate trade, on the grounds that chasing a single month of a small subscription
 * costs more than it recovers and that the customer is leaving anyway. `markUncollectible`
 * is the one-line change if the receivable should be kept on the books instead.
 */
export async function voidOpenSubscriptionInvoices(customerId: string, subscriptionId: string) {
  const stripe = getStripe();
  const { data: invoices } = await stripe.invoices.list({
    customer: customerId,
    status: 'open',
    limit: 100,
  });

  const voided: string[] = [];

  for (const invoice of invoices) {
    if (!invoice.id) continue;
    if (getInvoiceSubscriptionId(invoice) !== subscriptionId) continue;

    try {
      await stripe.invoices.voidInvoice(invoice.id);
      voided.push(invoice.id);
    } catch (error) {
      logError(`Failed to void Stripe invoice ${invoice.id}:`, error);
    }
  }

  return voided;
}

/**
 * Scoped to a subscription when one is known, the same way `voidOpenSubscriptionInvoices`
 * is: a customer can carry an open invoice left behind by a subscription they no longer
 * hold, and pointing them at that one does nothing about the retries they are seeing.
 */
export async function getOpenInvoiceForCustomer(
  customerId: string,
  subscriptionId?: string | null
) {
  const stripe = getStripe();
  const { data: invoices } = await stripe.invoices.list({
    customer: customerId,
    status: 'open',
    limit: 100,
  });

  const candidates = subscriptionId
    ? invoices.filter((invoice) => getInvoiceSubscriptionId(invoice) === subscriptionId)
    : invoices;

  const newest = candidates
    .slice()
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .at(0);

  if (!newest) {
    return null;
  }

  return {
    id: newest.id ?? null,
    hostedInvoiceUrl: newest.hosted_invoice_url ?? null,
    amountDue: newest.amount_due ?? newest.total ?? 0,
    currency: newest.currency ?? 'usd',
    attemptCount: newest.attempt_count ?? 0,
    nextPaymentAttempt: newest.next_payment_attempt
      ? new Date(newest.next_payment_attempt * 1000)
      : null,
  };
}
