// The two hosted plans and the storage add-on, in one place.
//
// The plans differ only in how many people may upload (editors), how much they
// store and what they cost. Everything else is the same on both, so nothing in
// here describes features. Reviewers (COMMENTATOR members and share-link guests)
// are free on every plan and are never counted.
//
// This module is pure apart from reading price ids from the environment, so the
// unit tests can exercise every rule without a database or Stripe.

import { BillingInterval, BillingPlan } from '@prisma/client';
import { getStorageLimitBytes } from '@/lib/trial-limits';

const GIB = BigInt(1024) * BigInt(1024) * BigInt(1024);

/** One storage add-on block. */
export const STORAGE_BLOCK_BYTES = BigInt(100) * GIB;

export interface PlanDefinition {
  label: string;
  baseStorageBytes: bigint;
  /** Distinct uploaders the account may have, owner included. `null` is unlimited. */
  maxEditors: number | null;
  maxStorageBlocks: number;
  /** Price in US cents per billing interval. */
  priceCents: Record<BillingInterval, number>;
}

export const PLAN_DEFINITIONS: Record<BillingPlan, PlanDefinition> = {
  [BillingPlan.SOLO]: {
    label: 'Solo',
    baseStorageBytes: BigInt(200) * GIB,
    maxEditors: 1,
    maxStorageBlocks: 3,
    priceCents: { [BillingInterval.MONTH]: 1000, [BillingInterval.YEAR]: 9600 },
  },
  [BillingPlan.STUDIO]: {
    label: 'Studio',
    baseStorageBytes: BigInt(1024) * GIB,
    maxEditors: null,
    maxStorageBlocks: 10,
    priceCents: { [BillingInterval.MONTH]: 2900, [BillingInterval.YEAR]: 29000 },
  },
};

/** Accounts on the original single plan keep Solo pricing with Studio's block ceiling. */
export const FOUNDING_MAX_STORAGE_BLOCKS = 10;

export const STORAGE_BLOCK_PRICE_CENTS: Record<BillingInterval, number> = {
  [BillingInterval.MONTH]: 500,
  [BillingInterval.YEAR]: 5000,
};

const PLAN_RANK: Record<BillingPlan, number> = {
  [BillingPlan.SOLO]: 0,
  [BillingPlan.STUDIO]: 1,
};

export function isPlanUpgrade(from: BillingPlan, to: BillingPlan) {
  return PLAN_RANK[to] > PLAN_RANK[from];
}

// ---------------------------------------------------------------------------
// Stripe price ids
// ---------------------------------------------------------------------------

// STRIPE_PRICE_ID is the original single plan and stays the Solo monthly price,
// so existing subscriptions map onto Solo without being touched. The others are
// optional: a deployment that has not created them simply does not offer them.
const PLAN_PRICE_ENV: Record<BillingPlan, Record<BillingInterval, string>> = {
  [BillingPlan.SOLO]: {
    [BillingInterval.MONTH]: 'STRIPE_PRICE_ID',
    [BillingInterval.YEAR]: 'STRIPE_PRICE_ID_SOLO_YEARLY',
  },
  [BillingPlan.STUDIO]: {
    [BillingInterval.MONTH]: 'STRIPE_PRICE_ID_STUDIO_MONTHLY',
    [BillingInterval.YEAR]: 'STRIPE_PRICE_ID_STUDIO_YEARLY',
  },
};

const STORAGE_PRICE_ENV: Record<BillingInterval, string> = {
  [BillingInterval.MONTH]: 'STRIPE_PRICE_ID_STORAGE_MONTHLY',
  [BillingInterval.YEAR]: 'STRIPE_PRICE_ID_STORAGE_YEARLY',
};

function readPriceEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function getPlanPriceId(plan: BillingPlan, interval: BillingInterval): string | null {
  return readPriceEnv(PLAN_PRICE_ENV[plan][interval]);
}

export function getStoragePriceId(interval: BillingInterval): string | null {
  return readPriceEnv(STORAGE_PRICE_ENV[interval]);
}

/**
 * Every configured price that grants a plan. Throws when STRIPE_PRICE_ID is
 * missing, the same way `getStripePriceId` always has: without it no
 * subscription can be recognised, and failing loudly beats treating every
 * paying customer as free.
 */
export function getPlanPriceIds(): Set<string> {
  if (!readPriceEnv(PLAN_PRICE_ENV.SOLO.MONTH)) {
    throw new Error('STRIPE_PRICE_ID is not configured');
  }

  const ids = new Set<string>();
  for (const plan of Object.values(BillingPlan)) {
    for (const interval of Object.values(BillingInterval)) {
      const id = getPlanPriceId(plan, interval);
      if (id) ids.add(id);
    }
  }
  return ids;
}

export function getStoragePriceIds(): Set<string> {
  const ids = new Set<string>();
  for (const interval of Object.values(BillingInterval)) {
    const id = getStoragePriceId(interval);
    if (id) ids.add(id);
  }
  return ids;
}

export type IdentifiedPrice =
  | { kind: 'plan'; plan: BillingPlan; interval: BillingInterval }
  | { kind: 'storage'; interval: BillingInterval };

export function identifyPrice(priceId: string | null | undefined): IdentifiedPrice | null {
  if (!priceId) return null;
  for (const plan of Object.values(BillingPlan)) {
    for (const interval of Object.values(BillingInterval)) {
      if (getPlanPriceId(plan, interval) === priceId) return { kind: 'plan', plan, interval };
    }
  }
  for (const interval of Object.values(BillingInterval)) {
    if (getStoragePriceId(interval) === priceId) return { kind: 'storage', interval };
  }
  return null;
}

export interface SubscriptionItemLike {
  id?: string;
  price: string | { id: string } | null;
  quantity?: number | null;
}

export interface SubscriptionPlanItems {
  plan: BillingPlan;
  interval: BillingInterval;
  planPriceId: string;
  planItemId: string | null;
  storageBlocks: number;
  storageItemId: string | null;
}

function priceIdOf(item: SubscriptionItemLike): string | null {
  if (!item.price) return null;
  return typeof item.price === 'string' ? item.price : item.price.id;
}

/**
 * Reads the plan and the storage quantity off a subscription's (or a schedule
 * phase's) items. Returns null when no item carries a plan price, which is a
 * subscription that grants nothing.
 */
export function readSubscriptionPlanItems(
  items: readonly SubscriptionItemLike[]
): SubscriptionPlanItems | null {
  let planItem: {
    plan: BillingPlan;
    interval: BillingInterval;
    id: string | null;
    price: string;
  } | null = null;
  let storageBlocks = 0;
  let storageItemId: string | null = null;

  for (const item of items) {
    const priceId = priceIdOf(item);
    const identified = identifyPrice(priceId);
    if (!identified || !priceId) continue;
    if (identified.kind === 'plan') {
      // Two plan items would be a misconfigured subscription. Prefer the larger
      // plan so a customer is never under-served for what they pay.
      if (!planItem || isPlanUpgrade(planItem.plan, identified.plan)) {
        planItem = {
          plan: identified.plan,
          interval: identified.interval,
          id: item.id ?? null,
          price: priceId,
        };
      }
    } else {
      storageBlocks += Math.max(0, item.quantity ?? 0);
      storageItemId ??= item.id ?? null;
    }
  }

  if (!planItem) return null;
  return {
    plan: planItem.plan,
    interval: planItem.interval,
    planPriceId: planItem.price,
    planItemId: planItem.id,
    storageBlocks,
    storageItemId,
  };
}

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

export interface FoundingSubject {
  foundingSubscriptionId: string | null;
  stripeSubscriptionId: string | null;
  billingPlan: BillingPlan;
}

/**
 * Founding terms belong to one subscription. A new subscription after the old one
 * ended, or a move to Studio, ends them; the sync clears the column in both cases,
 * and this check keeps a stale column from granting anything in between.
 */
export function isFoundingAccount(subject: FoundingSubject) {
  return Boolean(
    subject.foundingSubscriptionId &&
    subject.foundingSubscriptionId === subject.stripeSubscriptionId &&
    subject.billingPlan === BillingPlan.SOLO
  );
}

export interface PlanEntitlementSubject {
  isPaid: boolean;
  billingPlan: BillingPlan;
  storageBlocks: number;
  isFounding: boolean;
}

/** Plan base plus add-on blocks for a paying account, the trial ceiling otherwise. */
export function getStorageLimitBytesForPlan(subject: PlanEntitlementSubject): bigint {
  const blocks = BigInt(Math.max(0, subject.storageBlocks));
  const planLimit =
    PLAN_DEFINITIONS[subject.billingPlan].baseStorageBytes + blocks * STORAGE_BLOCK_BYTES;
  return getStorageLimitBytes(subject.isPaid, planLimit);
}

/** How many blocks this account may hold. Zero for anyone not paying. */
export function getMaxStorageBlocks(subject: Omit<PlanEntitlementSubject, 'storageBlocks'>) {
  if (!subject.isPaid) return 0;
  if (subject.isFounding) return FOUNDING_MAX_STORAGE_BLOCKS;
  return PLAN_DEFINITIONS[subject.billingPlan].maxStorageBlocks;
}

/**
 * What to offer someone who wants more storage than their block ceiling allows.
 * Founding accounts are never pointed at Studio.
 */
export function getStorageCeilingOffer(
  subject: Omit<PlanEntitlementSubject, 'storageBlocks'>
): 'studio' | 'contact' {
  if (!subject.isFounding && subject.billingPlan === BillingPlan.SOLO) return 'studio';
  return 'contact';
}

export interface EditorLimitSubject {
  billingEnabled: boolean;
  isPaid: boolean;
  hasActiveTrial: boolean;
  billingPlan: BillingPlan;
  pendingBillingPlan: BillingPlan | null;
  isFounding: boolean;
}

/**
 * The most editors this account may have, owner included, or null for no limit.
 *
 * A running trial is unlimited so a team can try the product together; an account
 * with neither a trial nor a subscription is held to Solo, which is what it can
 * still buy. A scheduled move to Solo is treated as Solo already, so nobody can
 * be added after the owner confirmed who would be demoted.
 */
export function getEditorLimit(subject: EditorLimitSubject): number | null {
  if (!subject.billingEnabled || subject.isFounding) return null;
  if (!subject.isPaid) {
    return subject.hasActiveTrial ? null : PLAN_DEFINITIONS.SOLO.maxEditors;
  }
  const plan =
    subject.pendingBillingPlan && !isPlanUpgrade(subject.billingPlan, subject.pendingBillingPlan)
      ? subject.pendingBillingPlan
      : subject.billingPlan;
  return PLAN_DEFINITIONS[plan].maxEditors;
}

/** The plan to suggest at checkout. More than one editor already means Studio. */
export function recommendPlanForEditorCount(editorCount: number): BillingPlan {
  const soloLimit = PLAN_DEFINITIONS.SOLO.maxEditors ?? Infinity;
  return editorCount > soloLimit ? BillingPlan.STUDIO : BillingPlan.SOLO;
}

export function formatPriceCents(cents: number) {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}
