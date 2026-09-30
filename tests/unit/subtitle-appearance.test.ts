import { describe, it, expect } from 'vitest';
import {
  cueFontSizePx,
  parseSubtitleAppearance,
  pickCaptionToggleLanguage,
  youtubeCaptionFontSize,
} from '@/components/video-page/hooks/subtitle-appearance';

describe('parseSubtitleAppearance', () => {
  it('falls back to medium on a translucent box when nothing is stored', () => {
    expect(parseSubtitleAppearance(null)).toEqual({ size: 'medium', background: 'box' });
    expect(parseSubtitleAppearance('')).toEqual({ size: 'medium', background: 'box' });
  });

  it('reads back a stored choice', () => {
    expect(parseSubtitleAppearance('{"size":"xlarge","background":"none"}')).toEqual({
      size: 'xlarge',
      background: 'none',
    });
    expect(parseSubtitleAppearance('{"size":"small","background":"solid"}')).toEqual({
      size: 'small',
      background: 'solid',
    });
  });

  it('keeps the valid field when only the other one is unknown', () => {
    expect(parseSubtitleAppearance('{"size":"huge","background":"solid"}')).toEqual({
      size: 'medium',
      background: 'solid',
    });
    expect(parseSubtitleAppearance('{"size":"large","background":42}')).toEqual({
      size: 'large',
      background: 'box',
    });
  });

  it('survives storage that is not JSON or not an object', () => {
    expect(parseSubtitleAppearance('large')).toEqual({ size: 'medium', background: 'box' });
    expect(parseSubtitleAppearance('null')).toEqual({ size: 'medium', background: 'box' });
    expect(parseSubtitleAppearance('"large"')).toEqual({ size: 'medium', background: 'box' });
  });
});

describe('cueFontSizePx', () => {
  const fullHdIn720p = { boxWidth: 1280, boxHeight: 720, videoWidth: 1920, videoHeight: 1080 };

  it('draws Medium at the browser default of 5% of the picture height', () => {
    expect(cueFontSizePx({ ...fullHdIn720p, size: 'medium' })).toBe(36);
  });

  // Firefox drew all three below Medium when these were percentages, so the order is
  // the thing worth pinning.
  it('puts every other size on its own side of Medium, in order', () => {
    expect(cueFontSizePx({ ...fullHdIn720p, size: 'small' })).toBe(27);
    expect(cueFontSizePx({ ...fullHdIn720p, size: 'large' })).toBe(48.6);
    expect(cueFontSizePx({ ...fullHdIn720p, size: 'xlarge' })).toBe(63);
  });

  it('measures the picture, not the letterboxed box around it', () => {
    // A 16:9 clip in a taller box is 720 px high, not 1000.
    expect(
      cueFontSizePx({
        boxWidth: 1280,
        boxHeight: 1000,
        videoWidth: 1920,
        videoHeight: 1080,
        size: 'medium',
      })
    ).toBe(36);
    // A portrait clip fills the height of a landscape box.
    expect(
      cueFontSizePx({
        boxWidth: 1280,
        boxHeight: 720,
        videoWidth: 1080,
        videoHeight: 1920,
        size: 'medium',
      })
    ).toBe(36);
  });

  it('falls back to the box height before the metadata has loaded', () => {
    expect(
      cueFontSizePx({
        boxWidth: 800,
        boxHeight: 450,
        videoWidth: 0,
        videoHeight: 0,
        size: 'medium',
      })
    ).toBe(22.5);
  });

  it('uses the box height until both picture dimensions are known', () => {
    expect(
      cueFontSizePx({
        boxWidth: 800,
        boxHeight: 450,
        videoWidth: 1920,
        videoHeight: 0,
        size: 'medium',
      })
    ).toBe(22.5);
  });

  it('leaves the browser default alone when either side of the box is empty', () => {
    expect(
      cueFontSizePx({
        boxWidth: 800,
        boxHeight: 0,
        videoWidth: 1920,
        videoHeight: 1080,
        size: 'medium',
      })
    ).toBeNull();
    expect(
      cueFontSizePx({
        boxWidth: 0,
        boxHeight: 450,
        videoWidth: 1920,
        videoHeight: 1080,
        size: 'medium',
      })
    ).toBeNull();
  });

  it('leaves the browser default alone while the player has no layout', () => {
    expect(
      cueFontSizePx({
        boxWidth: 0,
        boxHeight: 0,
        videoWidth: 1920,
        videoHeight: 1080,
        size: 'large',
      })
    ).toBeNull();
  });
});

describe('youtubeCaptionFontSize', () => {
  it('maps each size to the YouTube player step around its default of 0', () => {
    expect(youtubeCaptionFontSize('small')).toBe(-1);
    expect(youtubeCaptionFontSize('medium')).toBe(0);
    expect(youtubeCaptionFontSize('large')).toBe(1);
    expect(youtubeCaptionFontSize('xlarge')).toBe(2);
  });
});

describe('pickCaptionToggleLanguage', () => {
  it('turns subtitles off when a track is showing', () => {
    expect(
      pickCaptionToggleLanguage({
        active: 'tr',
        previous: 'tr',
        stored: 'tr',
        available: ['tr', 'en'],
      })
    ).toBeNull();
  });

  it('brings back the language watched last, over the stored one and the first track', () => {
    expect(
      pickCaptionToggleLanguage({
        active: null,
        previous: 'de',
        stored: 'en',
        available: ['tr', 'en', 'de'],
      })
    ).toBe('de');
  });

  it('uses the stored preference when nothing was watched yet in this visit', () => {
    expect(
      pickCaptionToggleLanguage({
        active: null,
        previous: null,
        stored: 'en',
        available: ['tr', 'en'],
      })
    ).toBe('en');
  });

  it('skips a remembered language this version does not have', () => {
    expect(
      pickCaptionToggleLanguage({
        active: null,
        previous: 'de',
        stored: 'fr',
        available: ['tr', 'en'],
      })
    ).toBe('tr');
  });

  it('stays off when the version has no track', () => {
    expect(
      pickCaptionToggleLanguage({ active: null, previous: 'tr', stored: 'tr', available: [] })
    ).toBeNull();
  });
});
