import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/google', () => ({
  JetBrains_Mono: () => ({ variable: '' }),
  Geist_Mono: () => ({ variable: '' }),
}));

const { metadata } = await import('@/app/layout');

describe('root layout metadata', () => {
  it('sends other sites our origin, which the Google Picker checks its API key against', () => {
    // 'no-referrer' here overrides the header on every page, and Google then
    // rejects the Picker key as invalid.
    expect(metadata.referrer).toBe('strict-origin-when-cross-origin');
  });
});
