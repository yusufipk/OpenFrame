import { describe, expect, it } from 'vitest';
import {
  TRIAL_PROJECT_LIMIT,
  TRIAL_STORAGE_LIMIT_BYTES,
  TRIAL_WORKSPACE_LIMIT,
  getStorageLimitBytes,
} from '@/lib/trial-limits';

const GIB = BigInt(1024) * BigInt(1024) * BigInt(1024);

describe('trial ceilings', () => {
  it('holds a trial to one workspace and one project', () => {
    expect(TRIAL_WORKSPACE_LIMIT).toBe(1);
    expect(TRIAL_PROJECT_LIMIT).toBe(1);
  });

  it('caps trial storage at 3 GiB', () => {
    expect(TRIAL_STORAGE_LIMIT_BYTES).toBe(BigInt(3) * GIB);
  });
});

describe('getStorageLimitBytes', () => {
  const PLAN_LIMIT = BigInt(200) * GIB;

  it('gives a paying account the whole plan allowance', () => {
    expect(getStorageLimitBytes(true, PLAN_LIMIT)).toBe(BigInt(214748364800));
  });

  it('holds an unpaid account to the trial ceiling', () => {
    expect(getStorageLimitBytes(false, PLAN_LIMIT)).toBe(BigInt(3221225472));
  });

  // A self-hosted instance can configure a plan allowance below the trial one.
  // Handing a trial account more storage than the plan itself grants would be a
  // strange way to run out of disk.
  it('never raises an account above a plan allowance smaller than the trial ceiling', () => {
    const tinyPlan = BigInt(512) * BigInt(1024) * BigInt(1024);

    expect(getStorageLimitBytes(false, tinyPlan)).toBe(BigInt(536870912));
  });
});
