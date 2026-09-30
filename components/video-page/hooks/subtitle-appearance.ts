'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';

/**
 * How subtitles look, chosen by the viewer and remembered across every video, the way a
 * TV or a streaming app keeps its caption settings. Unlike the language, which belongs to
 * one video, size and background are about the viewer's eyes and screen.
 */

export type SubtitleSize = 'small' | 'medium' | 'large' | 'xlarge';
export type SubtitleBackground = 'box' | 'solid' | 'none';

export interface SubtitleAppearance {
  size: SubtitleSize;
  background: SubtitleBackground;
}

export const DEFAULT_SUBTITLE_APPEARANCE: SubtitleAppearance = {
  size: 'medium',
  background: 'box',
};

export const SUBTITLE_SIZE_OPTIONS: readonly { value: SubtitleSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'Extra large' },
];

export const SUBTITLE_BACKGROUND_OPTIONS: readonly {
  value: SubtitleBackground;
  label: string;
}[] = [
  { value: 'box', label: 'Translucent' },
  { value: 'solid', label: 'Solid' },
  { value: 'none', label: 'None' },
];

const STORAGE_KEY = 'openframe:subtitle-appearance';
const CHANGE_EVENT = 'openframe:subtitle-appearance-change';

const SIZES: readonly string[] = ['small', 'medium', 'large', 'xlarge'];
const BACKGROUNDS: readonly string[] = ['box', 'solid', 'none'];

/**
 * Reads a stored value field by field, so a corrupt or outdated entry falls back to the
 * default for that field instead of throwing away the other one.
 */
export function parseSubtitleAppearance(raw: string | null): SubtitleAppearance {
  if (!raw) return DEFAULT_SUBTITLE_APPEARANCE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SUBTITLE_APPEARANCE;
  }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_SUBTITLE_APPEARANCE;
  const { size, background } = parsed as Record<string, unknown>;
  return {
    size:
      typeof size === 'string' && SIZES.includes(size)
        ? (size as SubtitleSize)
        : DEFAULT_SUBTITLE_APPEARANCE.size,
    background:
      typeof background === 'string' && BACKGROUNDS.includes(background)
        ? (background as SubtitleBackground)
        : DEFAULT_SUBTITLE_APPEARANCE.background,
  };
}

/**
 * The value for YouTube's `setOption('captions', 'fontSize', n)`, where 0 is the player's
 * default and each step is one size up or down. YouTube exposes no background option, so
 * only the size carries over to an embedded version.
 */
export function youtubeCaptionFontSize(size: SubtitleSize): number {
  switch (size) {
    case 'small':
      return -1;
    case 'large':
      return 1;
    case 'xlarge':
      return 2;
    default:
      return 0;
  }
}

/** Each size as a multiple of the browser's own default cue size. */
const CUE_SIZE_FACTORS: Record<SubtitleSize, number> = {
  small: 0.75,
  medium: 1,
  large: 1.35,
  xlarge: 1.75,
};

/**
 * Browsers draw a cue at 5% of the height of the picture, not of the element: a portrait
 * clip or a letterboxed one fills only part of its box.
 */
const DEFAULT_CUE_HEIGHT_SHARE = 0.05;

/**
 * The cue font size in pixels for a player box and the video it shows.
 *
 * A pixel value is the only one both engines agree on. A percentage in `::cue` resolves
 * against the page's font size in Firefox but against the picture in Chromium, so in a
 * large player Firefox drew Small, Large and Extra large all below the untouched Medium.
 * Returns null while the element has no layout yet, so nothing is forced on the browser.
 */
export function cueFontSizePx({
  boxWidth,
  boxHeight,
  videoWidth,
  videoHeight,
  size,
}: {
  boxWidth: number;
  boxHeight: number;
  videoWidth: number;
  videoHeight: number;
  size: SubtitleSize;
}): number | null {
  if (boxWidth <= 0 || boxHeight <= 0) return null;
  // Before metadata the picture's shape is unknown, so the box stands in for it.
  const pictureHeight =
    videoWidth > 0 && videoHeight > 0
      ? videoHeight * Math.min(boxWidth / videoWidth, boxHeight / videoHeight)
      : boxHeight;
  return Math.round(pictureHeight * DEFAULT_CUE_HEIGHT_SHARE * CUE_SIZE_FACTORS[size] * 10) / 10;
}

/**
 * What the subtitle shortcut switches to. With subtitles on it turns them off. With them
 * off it brings back the language the viewer last watched in, then the one remembered for
 * this video, then the first track, and stays off when the version has no track at all.
 */
export function pickCaptionToggleLanguage({
  active,
  previous,
  stored,
  available,
}: {
  active: string | null;
  previous: string | null;
  stored: string | null;
  available: readonly string[];
}): string | null {
  if (active) return null;
  if (previous && available.includes(previous)) return previous;
  if (stored && available.includes(stored)) return stored;
  return available[0] ?? null;
}

// Holds the choice for this page load when storage is disabled, so the menu still works
// even though nothing survives a reload.
let unstoredRaw: string | null = null;

function readRaw(): string | null {
  // Only ever set after a write failed, so it is newer than anything storage still holds.
  if (unstoredRaw !== null) return unstoredRaw;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  // `storage` keeps other open tabs in step; the custom event covers this tab, which the
  // browser does not notify about its own writes.
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/**
 * Keeps `cueFontSizePx` in step with the player: resizing the window, entering fullscreen
 * and loading a clip of another shape all change the picture height the size is based on.
 * `versionId` is here because the <video> is remounted for every version.
 */
export function useCueFontSize(
  videoRef: RefObject<HTMLVideoElement | null>,
  versionId: string | null,
  size: SubtitleSize
): number | null {
  const [fontSize, setFontSize] = useState<number | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof ResizeObserver === 'undefined') return;

    const measure = () => {
      setFontSize(
        cueFontSizePx({
          boxWidth: video.clientWidth,
          boxHeight: video.clientHeight,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          size,
        })
      );
    };

    // The observer reports the current size as soon as it starts observing, so this also
    // covers the first measurement. It only sees the element's box, though: a change in
    // the picture's own shape (metadata arriving, or a stream switching aspect ratio) comes
    // as a media event instead.
    const observer = new ResizeObserver(measure);
    observer.observe(video);
    video.addEventListener('loadedmetadata', measure);
    video.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      video.removeEventListener('loadedmetadata', measure);
      video.removeEventListener('resize', measure);
    };
  }, [size, versionId, videoRef]);

  return fontSize;
}

export function useSubtitleAppearance() {
  // The server snapshot is null, so the first client render matches the server and the
  // stored choice is applied right after hydration.
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  const appearance = useMemo(() => parseSubtitleAppearance(raw), [raw]);

  const setAppearance = useCallback((next: Partial<SubtitleAppearance>) => {
    const serialized = JSON.stringify({ ...parseSubtitleAppearance(readRaw()), ...next });
    try {
      window.localStorage.setItem(STORAGE_KEY, serialized);
    } catch {
      // Storage disabled: the choice applies until the page is reloaded.
      unstoredRaw = serialized;
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { subtitleAppearance: appearance, setSubtitleAppearance: setAppearance };
}
