/**
 * The viewer's Bunny playback quality choice, remembered across videos in this browser.
 *
 * A specific rendition is stored by height rather than by level index, because the index
 * of 1080p differs between videos that were encoded with a different set of renditions.
 */

export type QualityPreference =
  | { mode: 'auto' }
  | { mode: 'original' }
  | { mode: 'height'; height: number };

const PREFERENCE_KEY = 'openframe:playback-quality';
const HINT_SEEN_KEY = 'openframe:playback-quality-hint-seen';

export function readStoredQualityPreference(): QualityPreference | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PREFERENCE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { mode, height } = parsed as { mode?: unknown; height?: unknown };
    if (mode === 'auto' || mode === 'original') return { mode };
    if (
      mode === 'height' &&
      typeof height === 'number' &&
      Number.isInteger(height) &&
      height > 0 &&
      height <= 8640
    ) {
      return { mode, height };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeStoredQualityPreference(preference: QualityPreference): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preference));
    // Picking a quality is the thing the hint points at, so it has done its job.
    window.localStorage.setItem(HINT_SEEN_KEY, '1');
  } catch {
    // A browser with storage disabled still plays, just without a remembered choice.
  }
}

export function hasSeenQualityHint(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(HINT_SEEN_KEY) === '1';
  } catch {
    // Without storage the hint would come back on every page, so never show it.
    return true;
  }
}

export function markQualityHintSeen(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HINT_SEEN_KEY, '1');
  } catch {
    // Nothing to remember it in; hasSeenQualityHint() already hides it in this case.
  }
}

/**
 * Picks the level to play for a remembered height: the exact rendition when the video has
 * it, otherwise the tallest one below it, otherwise the smallest one above it.
 */
export function findLevelForHeight(levels: ReadonlyArray<{ height?: number }>, height: number) {
  let best = -1;
  let bestHeight = 0;
  levels.forEach((level, index) => {
    const levelHeight = level.height ?? 0;
    if (levelHeight > 0 && levelHeight <= height && levelHeight > bestHeight) {
      best = index;
      bestHeight = levelHeight;
    }
  });
  if (best !== -1) return best;

  let smallestAbove = -1;
  let smallestAboveHeight = Infinity;
  levels.forEach((level, index) => {
    const levelHeight = level.height ?? 0;
    if (levelHeight > height && levelHeight < smallestAboveHeight) {
      smallestAbove = index;
      smallestAboveHeight = levelHeight;
    }
  });
  return smallestAbove;
}

/** The level with the highest bitrate, which is where Auto starts playback. */
export function findTopLevel(levels: ReadonlyArray<{ bitrate?: number; height?: number }>) {
  let top = -1;
  levels.forEach((level, index) => {
    if (top === -1) {
      top = index;
      return;
    }
    const current = levels[top];
    const bitrate = level.bitrate ?? 0;
    const currentBitrate = current.bitrate ?? 0;
    if (
      bitrate > currentBitrate ||
      (bitrate === currentBitrate && (level.height ?? 0) > (current.height ?? 0))
    ) {
      top = index;
    }
  });
  return top;
}

/**
 * The renditions a master playlist offers, in playlist order, read without hls.js.
 *
 * Used to fill the Quality menu while the original is playing and hls.js has not loaded
 * anything. Entries are matched to hls.js levels by height later, never by position.
 */
export function parseMasterPlaylistLevels(text: string): { height?: number; bitrate?: number }[] {
  const levels: { height?: number; bitrate?: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const bandwidth = line.match(/[:,]BANDWIDTH=(\d+)/);
    const resolution = line.match(/[:,]RESOLUTION=(\d+)x(\d+)/);
    levels.push({
      bitrate: bandwidth ? Number(bandwidth[1]) : undefined,
      height: resolution ? Number(resolution[2]) : undefined,
    });
  }
  return levels;
}

/**
 * Whether the browser should get hls.js even though it reports native HLS support.
 *
 * Chromium's native HLS player opens on the lowest rendition and exposes no levels, so
 * Chromium always gets hls.js. Safari keeps its own player: hls.js there runs on
 * ManagedMediaSource, which turns off AirPlay for the element.
 */
export function prefersHlsJsOverNative(nav: Navigator | undefined): boolean {
  const brands = (
    nav as (Navigator & { userAgentData?: { brands?: { brand: string }[] } }) | undefined
  )?.userAgentData?.brands;
  if (brands?.some((entry) => /Chromium|Google Chrome|Microsoft Edge/.test(entry.brand))) {
    return true;
  }
  // Older Chromium builds without userAgentData still name themselves in the UA string.
  // Chrome on iOS (CriOS) is WebKit underneath and keeps the native player.
  return /\b(Chrome|Chromium|Edg)\//.test(nav?.userAgent ?? '');
}
