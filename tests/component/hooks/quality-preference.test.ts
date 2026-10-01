import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  findLevelForHeight,
  findTopLevel,
  hasSeenQualityHint,
  markQualityHintSeen,
  readStoredQualityPreference,
  writeStoredQualityPreference,
} from '@/components/video-page/hooks/quality-preference';

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('stored quality preference', () => {
  it('is absent until the viewer picks something', () => {
    expect(readStoredQualityPreference()).toBeNull();
  });

  it('reads back each kind of choice', () => {
    writeStoredQualityPreference({ mode: 'original' });
    expect(readStoredQualityPreference()).toEqual({ mode: 'original' });
    writeStoredQualityPreference({ mode: 'height', height: 720 });
    expect(readStoredQualityPreference()).toEqual({ mode: 'height', height: 720 });
    writeStoredQualityPreference({ mode: 'auto' });
    expect(readStoredQualityPreference()).toEqual({ mode: 'auto' });
  });

  it('ignores anything it did not write', () => {
    const key = 'openframe:playback-quality';
    for (const raw of [
      'not json',
      '"auto"',
      '{"mode":"best"}',
      '{"mode":"height"}',
      '{"mode":"height","height":-1}',
      '{"mode":"height","height":720.5}',
      '{"mode":"height","height":"720"}',
    ]) {
      window.localStorage.setItem(key, raw);
      expect(readStoredQualityPreference()).toBeNull();
    }
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => writeStoredQualityPreference({ mode: 'original' })).not.toThrow();
    expect(readStoredQualityPreference()).toBeNull();
    // With nowhere to remember the dismissal, the hint would come back on every page.
    expect(hasSeenQualityHint()).toBe(true);
  });
});

describe('quality hint', () => {
  it('shows until it is dismissed', () => {
    expect(hasSeenQualityHint()).toBe(false);
    markQualityHintSeen();
    expect(hasSeenQualityHint()).toBe(true);
  });

  it('is retired by picking a quality', () => {
    writeStoredQualityPreference({ mode: 'auto' });
    expect(hasSeenQualityHint()).toBe(true);
  });
});

// Bunny's master playlist, in the order Bunny lists it: not sorted by height.
const BUNNY_LEVELS = [
  { height: 360, bitrate: 190_804 },
  { height: 480, bitrate: 300_479 },
  { height: 720, bitrate: 553_633 },
  { height: 240, bitrate: 110_426 },
  { height: 1080, bitrate: 1_295_817 },
];

describe('findLevelForHeight', () => {
  it('finds the exact rendition', () => {
    expect(findLevelForHeight(BUNNY_LEVELS, 720)).toBe(2);
  });

  it('steps down to the tallest rendition below a height the video lacks', () => {
    expect(findLevelForHeight(BUNNY_LEVELS, 1440)).toBe(4);
    expect(findLevelForHeight(BUNNY_LEVELS, 600)).toBe(1);
  });

  it('steps up when every rendition is taller', () => {
    expect(findLevelForHeight(BUNNY_LEVELS, 144)).toBe(3);
  });

  it('gives up on levels without a height', () => {
    expect(findLevelForHeight([{}, {}], 720)).toBe(-1);
  });
});

describe('findTopLevel', () => {
  it('picks the highest bitrate wherever it sits in the playlist', () => {
    expect(findTopLevel(BUNNY_LEVELS)).toBe(4);
  });

  it('breaks a bitrate tie on height', () => {
    expect(
      findTopLevel([
        { bitrate: 1000, height: 720 },
        { bitrate: 1000, height: 1080 },
      ])
    ).toBe(1);
  });

  it('is -1 for an empty playlist', () => {
    expect(findTopLevel([])).toBe(-1);
  });
});
