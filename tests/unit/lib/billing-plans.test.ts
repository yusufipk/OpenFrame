import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getEditorLimit,
  getMaxStorageBlocks,
  getStorageCeilingOffer,
  getStorageLimitBytesForPlan,
  identifyPrice,
  isFoundingAccount,
  readSubscriptionPlanItems,
  recommendPlanForEditorCount,
} from '@/lib/billing-plans';

// Byte counts are written out as literals on purpose, so a change to a plan
// constant cannot silently move its own expected value.
const GIB_200 = BigInt('214748364800');
const GIB_300 = BigInt('322122547200');
const GIB_400 = BigInt('429496729600');
const TIB_1 = BigInt('1099511627776');
const TIB_1_PLUS_300_GIB = BigInt('1421634174976');
const GIB_3 = BigInt('3221225472');

describe('getStorageLimitBytesForPlan', () => {
  it('gives Solo 200 GB with no blocks', () => {
    expect(
      getStorageLimitBytesForPlan({
        isPaid: true,
        billingPlan: 'SOLO',
        storageBlocks: 0,
        isFounding: false,
      })
    ).toBe(GIB_200);
  });

  it('adds 100 GB per block on Solo: two blocks make 400 GB', () => {
    expect(
      getStorageLimitBytesForPlan({
        isPaid: true,
        billingPlan: 'SOLO',
        storageBlocks: 2,
        isFounding: false,
      })
    ).toBe(GIB_400);
  });

  it('gives Studio 1 TB plus its blocks', () => {
    expect(
      getStorageLimitBytesForPlan({
        isPaid: true,
        billingPlan: 'STUDIO',
        storageBlocks: 0,
        isFounding: false,
      })
    ).toBe(TIB_1);
    expect(
      getStorageLimitBytesForPlan({
        isPaid: true,
        billingPlan: 'STUDIO',
        storageBlocks: 3,
        isFounding: false,
      })
    ).toBe(TIB_1_PLUS_300_GIB);
  });

  it('holds an unpaid account to the 3 GB trial ceiling whatever blocks are recorded', () => {
    expect(
      getStorageLimitBytesForPlan({
        isPaid: false,
        billingPlan: 'STUDIO',
        storageBlocks: 5,
        isFounding: false,
      })
    ).toBe(GIB_3);
  });

  it('never subtracts for a negative block count', () => {
    expect(
      getStorageLimitBytesForPlan({
        isPaid: true,
        billingPlan: 'SOLO',
        storageBlocks: -1,
        isFounding: false,
      })
    ).toBe(GIB_200);
  });

  it('treats one block as exactly 100 GB', () => {
    expect(
      getStorageLimitBytesForPlan({
        isPaid: true,
        billingPlan: 'SOLO',
        storageBlocks: 1,
        isFounding: false,
      })
    ).toBe(GIB_300);
  });
});

describe('getMaxStorageBlocks', () => {
  it('allows 3 on Solo, 10 on Studio, 10 for founding and none unpaid', () => {
    expect(getMaxStorageBlocks({ isPaid: true, billingPlan: 'SOLO', isFounding: false })).toBe(3);
    expect(getMaxStorageBlocks({ isPaid: true, billingPlan: 'STUDIO', isFounding: false })).toBe(
      10
    );
    expect(getMaxStorageBlocks({ isPaid: true, billingPlan: 'SOLO', isFounding: true })).toBe(10);
    expect(getMaxStorageBlocks({ isPaid: false, billingPlan: 'SOLO', isFounding: false })).toBe(0);
    expect(getMaxStorageBlocks({ isPaid: false, billingPlan: 'SOLO', isFounding: true })).toBe(0);
  });
});

describe('getStorageCeilingOffer', () => {
  it('points Solo at Studio and everyone else, founding included, at a conversation', () => {
    expect(getStorageCeilingOffer({ isPaid: true, billingPlan: 'SOLO', isFounding: false })).toBe(
      'studio'
    );
    expect(getStorageCeilingOffer({ isPaid: true, billingPlan: 'STUDIO', isFounding: false })).toBe(
      'contact'
    );
    expect(getStorageCeilingOffer({ isPaid: true, billingPlan: 'SOLO', isFounding: true })).toBe(
      'contact'
    );
  });
});

describe('getEditorLimit', () => {
  const base = {
    billingEnabled: true,
    isPaid: true,
    hasActiveTrial: false,
    billingPlan: 'SOLO' as const,
    pendingBillingPlan: null,
    isFounding: false,
  };

  it('limits paid Solo to one editor', () => {
    expect(getEditorLimit(base)).toBe(1);
  });

  it('does not limit Studio', () => {
    expect(getEditorLimit({ ...base, billingPlan: 'STUDIO' })).toBeNull();
  });

  it('treats Studio with a scheduled move to Solo as Solo already', () => {
    expect(getEditorLimit({ ...base, billingPlan: 'STUDIO', pendingBillingPlan: 'SOLO' })).toBe(1);
  });

  it('does not limit a founding account', () => {
    expect(getEditorLimit({ ...base, isFounding: true })).toBeNull();
  });

  it('does not limit a running trial', () => {
    expect(getEditorLimit({ ...base, isPaid: false, hasActiveTrial: true })).toBeNull();
  });

  it('holds an account with neither trial nor subscription to Solo', () => {
    expect(getEditorLimit({ ...base, isPaid: false, hasActiveTrial: false })).toBe(1);
  });

  it('does not limit anything when billing is off', () => {
    expect(getEditorLimit({ ...base, billingEnabled: false })).toBeNull();
  });
});

describe('isFoundingAccount', () => {
  it('holds while the founding subscription is the current one and stays on Solo', () => {
    expect(
      isFoundingAccount({
        foundingSubscriptionId: 'sub_1',
        stripeSubscriptionId: 'sub_1',
        billingPlan: 'SOLO',
      })
    ).toBe(true);
  });

  it('ends on a different subscription, on Studio, and when never granted', () => {
    expect(
      isFoundingAccount({
        foundingSubscriptionId: 'sub_1',
        stripeSubscriptionId: 'sub_2',
        billingPlan: 'SOLO',
      })
    ).toBe(false);
    expect(
      isFoundingAccount({
        foundingSubscriptionId: 'sub_1',
        stripeSubscriptionId: 'sub_1',
        billingPlan: 'STUDIO',
      })
    ).toBe(false);
    expect(
      isFoundingAccount({
        foundingSubscriptionId: null,
        stripeSubscriptionId: null,
        billingPlan: 'SOLO',
      })
    ).toBe(false);
  });
});

describe('recommendPlanForEditorCount', () => {
  it('recommends Solo for one editor and Studio for two or more', () => {
    expect(recommendPlanForEditorCount(1)).toBe('SOLO');
    expect(recommendPlanForEditorCount(2)).toBe('STUDIO');
  });
});

describe('price mapping', () => {
  beforeEach(() => {
    vi.stubEnv('STRIPE_PRICE_ID', 'price_solo_month');
    vi.stubEnv('STRIPE_PRICE_ID_SOLO_YEARLY', 'price_solo_year');
    vi.stubEnv('STRIPE_PRICE_ID_STUDIO_MONTHLY', 'price_studio_month');
    vi.stubEnv('STRIPE_PRICE_ID_STUDIO_YEARLY', 'price_studio_year');
    vi.stubEnv('STRIPE_PRICE_ID_STORAGE_MONTHLY', 'price_storage_month');
    vi.stubEnv('STRIPE_PRICE_ID_STORAGE_YEARLY', 'price_storage_year');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the original single price as Solo monthly', () => {
    expect(identifyPrice('price_solo_month')).toEqual({
      kind: 'plan',
      plan: 'SOLO',
      interval: 'MONTH',
    });
  });

  it('identifies each plan price and each storage price', () => {
    expect(identifyPrice('price_studio_year')).toEqual({
      kind: 'plan',
      plan: 'STUDIO',
      interval: 'YEAR',
    });
    expect(identifyPrice('price_storage_month')).toEqual({ kind: 'storage', interval: 'MONTH' });
    expect(identifyPrice('price_unknown')).toBeNull();
  });

  it('reads plan, interval and block quantity off subscription items', () => {
    expect(
      readSubscriptionPlanItems([
        { id: 'si_plan', price: { id: 'price_studio_year' }, quantity: 1 },
        { id: 'si_storage', price: { id: 'price_storage_year' }, quantity: 4 },
      ])
    ).toEqual({
      plan: 'STUDIO',
      interval: 'YEAR',
      planPriceId: 'price_studio_year',
      planItemId: 'si_plan',
      storageBlocks: 4,
      storageItemId: 'si_storage',
    });
  });

  it('grants nothing when no item carries a plan price, even with storage on it', () => {
    expect(readSubscriptionPlanItems([{ price: 'price_storage_month', quantity: 2 }])).toBeNull();
  });

  it('does not count an unknown price as storage', () => {
    expect(
      readSubscriptionPlanItems([
        { price: 'price_solo_month', quantity: 1 },
        { price: 'price_unknown', quantity: 7 },
      ])?.storageBlocks
    ).toBe(0);
  });

  it('treats an unset optional price as not on offer', () => {
    vi.stubEnv('STRIPE_PRICE_ID_STUDIO_YEARLY', '');
    expect(identifyPrice('price_studio_year')).toBeNull();
  });
});
