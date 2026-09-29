import { describe, expect, it } from 'vitest';
import {
  WHATS_NEW_ENTRIES,
  formatWhatsNewDate,
  getLatestWhatsNewDate,
  hasUnseenWhatsNew,
} from '@/lib/whats-new';

describe('getLatestWhatsNewDate', () => {
  it('returns null for an empty list', () => {
    expect(getLatestWhatsNewDate([])).toBeNull();
  });

  it('picks the latest date even when the list is out of order', () => {
    expect(
      getLatestWhatsNewDate([
        { date: '2026-08-20', title: 'a', description: '' },
        { date: '2026-09-28', title: 'b', description: '' },
        { date: '2026-09-15', title: 'c', description: '' },
      ])
    ).toBe('2026-09-28');
  });
});

describe('hasUnseenWhatsNew', () => {
  it.each([
    [null, '2026-09-28', true],
    ['', '2026-09-28', true],
    ['garbage', '2026-09-28', true],
    ['x2026-10-01', '2026-09-28', true],
    ['2026-10-01x', '2026-09-28', true],
    ['2026-09-26', '2026-09-28', true],
    ['2026-09-28', '2026-09-28', false],
    ['2026-10-01', '2026-09-28', false],
    [null, null, false],
  ])('lastSeen %s, latest %s is %s', (lastSeen, latest, expected) => {
    expect(hasUnseenWhatsNew(lastSeen, latest)).toBe(expected);
  });
});

describe('formatWhatsNewDate', () => {
  it('formats the calendar date as written', () => {
    expect(formatWhatsNewDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatWhatsNewDate('2026-09-28')).toBe('Sep 28, 2026');
    expect(formatWhatsNewDate('2026-12-31')).toBe('Dec 31, 2026');
  });
});

describe('WHATS_NEW_ENTRIES', () => {
  it('uses real YYYY-MM-DD calendar dates', () => {
    for (const entry of WHATS_NEW_ENTRIES) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${entry.date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(entry.date);
    }
  });

  it('is ordered newest first, which the panel relies on to group by date', () => {
    for (let i = 1; i < WHATS_NEW_ENTRIES.length; i++) {
      expect(WHATS_NEW_ENTRIES[i - 1].date >= WHATS_NEW_ENTRIES[i].date).toBe(true);
    }
  });

  it('has unique titles, since the panel keys list items by title', () => {
    const titles = WHATS_NEW_ENTRIES.map((entry) => entry.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});
