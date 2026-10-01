import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  findLevelForHeight,
  findTopLevel,
  hasSeenQualityHint,
  parseMasterPlaylistLevels,
  prefersHlsJsOverNative,
  markQualityHintSeen,
  readStoredQualityPreference,
  shouldUseHlsJs,
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

describe('parseMasterPlaylistLevels', () => {
  it('reads height and bandwidth from each stream, in playlist order', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '',
      '#EXT-X-STREAM-INF:BANDWIDTH=190804,AVERAGE-BANDWIDTH=190804,CODECS="avc1.64001e",RESOLUTION=640x360',
      '360p/video.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=1295817,RESOLUTION=1920x1080,CLOSED-CAPTIONS=NONE',
      '1080p/video.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=64000',
      'audio/video.m3u8',
    ].join('\r\n');
    expect(parseMasterPlaylistLevels(playlist)).toEqual([
      { bitrate: 190_804, height: 360 },
      { bitrate: 1_295_817, height: 1080 },
      { bitrate: 64_000, height: undefined },
    ]);
  });

  it('does not mistake AVERAGE-BANDWIDTH for BANDWIDTH', () => {
    expect(
      parseMasterPlaylistLevels('#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1,BANDWIDTH=2,RESOLUTION=1x2')
    ).toEqual([{ bitrate: 2, height: 2 }]);
  });

  it('is empty for anything that is not a master playlist', () => {
    expect(parseMasterPlaylistLevels('')).toEqual([]);
    expect(parseMasterPlaylistLevels('<html>Not found</html>')).toEqual([]);
  });
});

describe('prefersHlsJsOverNative', () => {
  const nav = (userAgent: string, brands?: string[]) =>
    ({
      userAgent,
      ...(brands ? { userAgentData: { brands: brands.map((brand) => ({ brand })) } } : {}),
    }) as unknown as Navigator;

  it('sends Chromium browsers to hls.js', () => {
    expect(prefersHlsJsOverNative(nav('', ['Chromium', 'Google Chrome']))).toBe(true);
    expect(
      prefersHlsJsOverNative(
        nav(
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
        )
      )
    ).toBe(true);
    expect(
      prefersHlsJsOverNative(nav('Mozilla/5.0 ... Chrome/149.0 Safari/537.36 Edg/149.0'))
    ).toBe(true);
  });

  it('leaves Safari and WebKit-based iOS browsers on the native player', () => {
    expect(
      prefersHlsJsOverNative(
        nav(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
        )
      )
    ).toBe(false);
    expect(
      prefersHlsJsOverNative(
        nav(
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/149.0 Mobile/15E148 Safari/604.1'
        )
      )
    ).toBe(false);
    expect(prefersHlsJsOverNative(undefined)).toBe(false);
  });
});

describe('shouldUseHlsJs', () => {
  const chrome = { userAgent: 'Mozilla/5.0 Chrome/149.0 Safari/537.36' } as Navigator;
  const safari = { userAgent: 'Mozilla/5.0 Version/18.0 Safari/605.1.15' } as Navigator;
  const native = { canPlayType: () => 'maybe' as const };
  const noNative = { canPlayType: () => '' as const };

  it('uses hls.js on Chromium even with native HLS available', () => {
    expect(shouldUseHlsJs(true, native, chrome)).toBe(true);
  });

  it('keeps native HLS on Safari', () => {
    expect(shouldUseHlsJs(true, native, safari)).toBe(false);
  });

  it('uses hls.js wherever there is no native player', () => {
    expect(shouldUseHlsJs(true, noNative, safari)).toBe(true);
  });

  it('never picks hls.js where it cannot run', () => {
    expect(shouldUseHlsJs(false, noNative, chrome)).toBe(false);
  });
});
