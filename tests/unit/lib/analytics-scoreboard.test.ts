import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  COHORT_OBSERVATION_DAYS,
  cohortWindows,
  conversionRates,
  getCardlessTrialCutover,
} from '@/lib/analytics/scoreboard';

const WEEK = {
  visitors: 200,
  signups: 20,
  firstVideo: 10,
  shareLinks: 5,
  externalFeedback: 1,
  trials: 4,
  newPaid: 1,
};

describe('conversionRates', () => {
  it('divides each step by the one above it', () => {
    const rates = conversionRates(WEEK);
    expect(rates.visitorToSignup).toBeCloseTo(0.1);
    expect(rates.signupToFirstVideo).toBeCloseTo(0.5);
    expect(rates.firstVideoToShare).toBeCloseTo(0.5);
    expect(rates.shareToFeedback).toBeCloseTo(0.2);
    expect(rates.trialToPaid).toBeCloseTo(0.25);
  });

  it('returns null rather than zero when the denominator is zero', () => {
    const rates = conversionRates({ ...WEEK, visitors: 0, trials: 0 });
    expect(rates.visitorToSignup).toBeNull();
    expect(rates.trialToPaid).toBeNull();
    // "nobody arrived" and "nobody converted" are different facts, and the rest
    // of the funnel still has to report normally.
    expect(rates.signupToFirstVideo).toBeCloseTo(0.5);
  });

  it('reports a step where nobody converted as zero, not as missing', () => {
    expect(conversionRates({ ...WEEK, newPaid: 0 }).trialToPaid).toBe(0);
  });
});

describe('getCardlessTrialCutover', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is null when the deployment has not named a switchover date', () => {
    vi.stubEnv('OPENFRAME_CARDLESS_TRIAL_LAUNCHED_AT', '');

    expect(getCardlessTrialCutover()).toBeNull();
  });

  it('is null rather than an Invalid Date when the value is not a date', () => {
    vi.stubEnv('OPENFRAME_CARDLESS_TRIAL_LAUNCHED_AT', 'last tuesday');

    expect(getCardlessTrialCutover()).toBeNull();
  });

  it('reads an ISO date', () => {
    vi.stubEnv('OPENFRAME_CARDLESS_TRIAL_LAUNCHED_AT', '2026-03-01');

    expect(getCardlessTrialCutover()?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('cohortWindows', () => {
  const CUTOVER = new Date('2026-03-01T00:00:00.000Z');

  // The new cohort's window stops short of now, because an account that signed
  // up yesterday has not had its 30 days to convert. Counting it would hold the
  // new cohort to a shorter life than the old one and make it look worse.
  it('ends the new window a full observation period before now', () => {
    const windows = cohortWindows(CUTOVER, new Date('2026-05-01T00:00:00.000Z'));

    expect(windows.afterStart.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(windows.afterEnd.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(COHORT_OBSERVATION_DAYS).toBe(30);
  });

  it('gives the old cohort a window of exactly the same length', () => {
    const windows = cohortWindows(CUTOVER, new Date('2026-05-01T00:00:00.000Z'));

    expect(windows.beforeEnd.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(windows.beforeStart.toISOString()).toBe('2026-01-29T00:00:00.000Z');
    expect(windows.windowDays).toBe(31);
    expect(windows.afterEnd.getTime() - windows.afterStart.getTime()).toBe(
      windows.beforeEnd.getTime() - windows.beforeStart.getTime()
    );
  });

  it('collapses both windows to nothing before the first cohort is observable', () => {
    const windows = cohortWindows(CUTOVER, new Date('2026-03-10T00:00:00.000Z'));

    expect(windows.windowDays).toBe(0);
    expect(windows.afterEnd.toISOString()).toBe(windows.afterStart.toISOString());
    expect(windows.beforeStart.toISOString()).toBe(windows.beforeEnd.toISOString());
  });
});
