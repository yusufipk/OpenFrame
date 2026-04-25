import type { Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { BillingSubscriptionStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { getStripe, getStripePriceId } from '@/lib/stripe';
import { isStripeFeatureEnabled } from '@/lib/feature-flags';

const ACTIVE_SUBSCRIPTION_STATUSES = new Set<BillingSubscriptionStatus>([
  BillingSubscriptionStatus.ACTIVE,
  BillingSubscriptionStatus.TRIALING,
]);

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

export function hasActiveSubscription(status: BillingSubscriptionStatus | null | undefined) {
  if (!status) return false;
  return ACTIVE_SUBSCRIPTION_STATUSES.has(status);
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

  return {
    OR: [
      {
        subscriptionStatus: {
          in: [BillingSubscriptionStatus.ACTIVE, BillingSubscriptionStatus.TRIALING],
        },
      },
      { trialEndsAt: { gt: now } },
      { stripeCurrentPeriodEnd: { gt: now } },
    ],
  };
}

export function buildExpiredBillingWhereInput(now: Date = new Date()): Prisma.UserWhereInput {
  const cleanupCutoff = new Date(now.getTime() - STORAGE_CLEANUP_GRACE_DAYS * 24 * 60 * 60 * 1000);

  return {
    AND: [
      {
        NOT: buildBillingAccessWhereInput(now),
      },
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

export async function getStripeCheckoutState(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      subscriptionStatus: true,
      billingTrialConsumedAt: true,
    },
  });

  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  return {
    hasActiveSubscription: hasActiveSubscription(user.subscriptionStatus),
    isTrialEligible: !user.billingTrialConsumedAt,
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
  const collaborationCount = invitedWorkspaceCount + projectOnlyCollaborationCount;
  const canCreateWorkspace =
    !isStripeFeatureEnabled() ||
    billingAccess ||
    (ownedWorkspaceCount === 0 && collaborationCount === 0);

  let reason: string | null = null;
  if (!canCreateWorkspace && isStripeFeatureEnabled()) {
    if (collaborationCount > 0 && ownedWorkspaceCount === 0) {
      reason =
        'You are currently collaborating in someone else’s workspace or project. Start a subscription to create a workspace of your own.';
    } else {
      reason = 'Your trial has ended. Start a subscription to create and keep owning workspaces.';
    }
  }

  return {
    canCreateWorkspace,
    reason,
    ownedWorkspaceCount,
    invitedWorkspaceCount,
    projectOnlyCollaborationCount,
    subscription: {
      status: user.subscriptionStatus,
      label: getBillingStatusLabel(user.subscriptionStatus),
      hasActiveSubscription: hasActiveSubscription(user.subscriptionStatus),
      hasActiveTrial: hasActiveTrial(user.trialEndsAt),
      hasBillingAccess: billingAccess,
      isTrialEligible: !user.billingTrialConsumedAt,
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
      reason: billing.reason,
      ownedWorkspaceCount: billing.ownedWorkspaceCount,
      invitedWorkspaceCount: billing.invitedWorkspaceCount,
    },
    subscription: billing.subscription,
  };
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
  const reference = currentPeriodEnd ?? endedAt ?? canceledAt;

  return reference ? new Date(reference * 1000) : new Date();
}

function getEntitledStripePriceId(subscription: Stripe.Subscription) {
  const configuredPriceId = getStripePriceId();

  return (
    subscription.items.data.find((item) => item.price.id === configuredPriceId)?.price.id ?? null
  );
}

export async function syncStripeSubscriptionToUser(subscription: Stripe.Subscription) {
  const customerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;

  const user = await db.user.findUnique({
    where: { stripeCustomerId: customerId },
    select: {
      id: true,
      billingTrialConsumedAt: true,
    },
  });

  if (!user) {
    return null;
  }

  const currentPeriodEnd =
    'current_period_end' in subscription && typeof subscription.current_period_end === 'number'
      ? subscription.current_period_end
      : null;
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
  const hasAccess =
    hasEntitledPrice &&
    (hasActiveSubscription(mappedStatus) ||
      Boolean(currentPeriodEnd && currentPeriodEnd * 1000 > Date.now()));

  return db.user.update({
    where: { id: user.id },
    data: {
      stripeSubscriptionId: subscription.id,
      stripePriceId: entitledPriceId ?? subscription.items.data[0]?.price.id ?? null,
      stripeCurrentPeriodEnd: effectiveCurrentPeriodEnd,
      stripeCancelAtPeriodEnd: cancelAtPeriodEnd,
      stripeCancelAt: cancelAt ? new Date(cancelAt * 1000) : null,
      subscriptionStatus: mappedStatus,
      trialEndsAt: effectiveTrialEnd,
      billingTrialConsumedAt:
        hasEntitledPrice && trialEnd
          ? (user.billingTrialConsumedAt ?? new Date())
          : user.billingTrialConsumedAt,
      billingAccessEndedAt: hasAccess
        ? null
        : getInactiveBillingAccessEndedAt(subscription, hasEntitledPrice ? currentPeriodEnd : null),
    },
  });
}

export async function markSubscriptionCanceledByCustomerId(
  customerId: string,
  options?: { currentPeriodEnd?: Date | null; endedAt?: Date | null }
) {
  const user = await db.user.findUnique({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  });

  if (!user) {
    return null;
  }

  return db.user.update({
    where: { id: user.id },
    data: {
      subscriptionStatus: BillingSubscriptionStatus.CANCELED,
      trialEndsAt: null,
      stripeSubscriptionId: null,
      stripePriceId: null,
      stripeCurrentPeriodEnd: options?.currentPeriodEnd ?? null,
      stripeCancelAtPeriodEnd: false,
      stripeCancelAt: null,
      billingAccessEndedAt: options?.endedAt ?? options?.currentPeriodEnd ?? new Date(),
    },
  });
}
