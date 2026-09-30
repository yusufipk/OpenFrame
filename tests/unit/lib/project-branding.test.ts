import { describe, expect, it } from 'vitest';
import {
  brandAssetFilename,
  brandAssetPathToObjectKey,
  brandAssetUrl,
  brandForeground,
  brandStyle,
  normalizeBrandColor,
  toProjectBranding,
} from '@/lib/project-branding';

const FILE = '11111111-2222-3333-4444-555555555555.png';
const KEY = `branding/${FILE}`;

describe('normalizeBrandColor', () => {
  it('accepts #rrggbb and lowercases it', () => {
    expect(normalizeBrandColor('#E4572E')).toBe('#e4572e');
    expect(normalizeBrandColor('  #00ff7f ')).toBe('#00ff7f');
  });

  it('rejects anything that could carry more than a color into an inline style', () => {
    expect(normalizeBrandColor('#e4572e; background: url(x)')).toBeNull();
    expect(normalizeBrandColor('red;#e4572e')).toBeNull();
    expect(normalizeBrandColor('red')).toBeNull();
    expect(normalizeBrandColor('#fff')).toBeNull();
    expect(normalizeBrandColor('e4572e')).toBeNull();
    expect(normalizeBrandColor('#gggggg')).toBeNull();
    expect(normalizeBrandColor('#e4572e00')).toBeNull();
    expect(normalizeBrandColor(null)).toBeNull();
    expect(normalizeBrandColor(123456)).toBeNull();
  });
});

describe('brandForeground', () => {
  it('puts white text on dark colors and black text on light ones', () => {
    expect(brandForeground('#000000')).toBe('#ffffff');
    expect(brandForeground('#1e3a8a')).toBe('#ffffff');
    expect(brandForeground('#ffffff')).toBe('#000000');
    expect(brandForeground('#facc15')).toBe('#000000');
  });

  it('picks the higher-contrast side for a mid-tone', () => {
    // #e4572e: about 3.7:1 against white and 5.7:1 against black.
    expect(brandForeground('#e4572e')).toBe('#000000');
    // #2563eb: about 5.2:1 against white and 4.1:1 against black.
    expect(brandForeground('#2563eb')).toBe('#ffffff');
  });
});

describe('brandStyle', () => {
  it('overrides only the accent variables', () => {
    expect(brandStyle('#1E3A8A')).toEqual({
      '--primary': '#1e3a8a',
      '--primary-foreground': '#ffffff',
      '--accent': '#1e3a8a',
      '--accent-foreground': '#ffffff',
      '--ring': '#1e3a8a',
    });
  });

  it('returns nothing for a missing or invalid color', () => {
    expect(brandStyle(null)).toBeUndefined();
    expect(brandStyle('javascript:alert(1)')).toBeUndefined();
  });
});

describe('brandAssetFilename', () => {
  it('reads the file name out of a key we wrote', () => {
    expect(brandAssetFilename(KEY)).toBe(FILE);
  });

  it('refuses keys outside branding/ or with an unexpected shape', () => {
    // images/ is shared with comment images, which other tenants can reference.
    expect(brandAssetFilename(`images/${FILE}`)).toBeNull();
    expect(brandAssetFilename(`videos/${FILE}`)).toBeNull();
    expect(brandAssetFilename(`branding/../${FILE}`)).toBeNull();
    expect(brandAssetFilename('branding/11111111-2222-3333-4444-555555555555.svg')).toBeNull();
    expect(brandAssetFilename(`${KEY}/extra`)).toBeNull();
    expect(brandAssetFilename(null)).toBeNull();
  });
});

describe('brandAssetPathToObjectKey', () => {
  it('maps a served branding path back to its branding/ key', () => {
    expect(brandAssetPathToObjectKey(`/api/projects/proj1/branding/${FILE}`)).toBe(KEY);
  });

  it('ignores paths it did not produce', () => {
    expect(brandAssetPathToObjectKey(`/api/upload/image/${FILE}`)).toBeNull();
    expect(brandAssetPathToObjectKey(`/api/projects/proj1/branding/${FILE}?videoId=v`)).toBeNull();
    expect(brandAssetPathToObjectKey(`/api/projects/../branding/${FILE}`)).toBeNull();
    expect(brandAssetPathToObjectKey(`/api/projects/p/branding/../${FILE}`)).toBeNull();
  });
});

describe('brandAssetUrl', () => {
  it('builds the project branding route, with the viewer context when given', () => {
    expect(brandAssetUrl('proj1', KEY)).toBe(`/api/projects/proj1/branding/${FILE}`);
    expect(brandAssetUrl('proj1', KEY, { videoId: 'vid1' })).toBe(
      `/api/projects/proj1/branding/${FILE}?videoId=vid1`
    );
    expect(brandAssetUrl('proj1', KEY, { folderId: 'fold1' })).toBe(
      `/api/projects/proj1/branding/${FILE}?folderId=fold1`
    );
    // The video is the narrower grant, so it wins when both are known.
    expect(brandAssetUrl('proj1', KEY, { videoId: 'vid1', folderId: 'fold1' })).toBe(
      `/api/projects/proj1/branding/${FILE}?videoId=vid1`
    );
  });
});

describe('toProjectBranding', () => {
  it('is null when nothing is set, so unbranded projects render as before', () => {
    expect(
      toProjectBranding('p', { brandColor: null, brandBannerKey: null, brandLogoKey: null })
    ).toBeNull();
  });

  it('keeps a banner-only project branded', () => {
    expect(
      toProjectBranding('p', { brandColor: null, brandBannerKey: KEY, brandLogoKey: null })
    ).toEqual({ color: null, bannerUrl: `/api/projects/p/branding/${FILE}`, logoUrl: null });
  });

  it('carries whatever is set', () => {
    expect(
      toProjectBranding('p', { brandColor: '#E4572E', brandBannerKey: null, brandLogoKey: KEY })
    ).toEqual({
      color: '#e4572e',
      bannerUrl: null,
      logoUrl: `/api/projects/p/branding/${FILE}`,
    });
  });
});
