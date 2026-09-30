import type { CSSProperties } from 'react';

export const BRAND_ASSET_KINDS = ['banner', 'logo'] as const;
export type BrandAssetKind = (typeof BRAND_ASSET_KINDS)[number];

/** Banner and logo are shown on every visit, so keep them small enough to load quickly. */
export const BRAND_ASSET_MAX_BYTES = 5 * 1024 * 1024;

const BRAND_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const BRAND_ASSET_FILENAME =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:jpg|png|webp|gif)';
const BRAND_ASSET_KEY_PATTERN = new RegExp(`^branding/(${BRAND_ASSET_FILENAME})$`);
const BRAND_ASSET_PATH_PATTERN = new RegExp(
  `^/api/projects/[A-Za-z0-9_-]+/branding/(${BRAND_ASSET_FILENAME})$`
);

/**
 * Branding files get their own `branding/` prefix rather than sharing `images/` with
 * comment images. Comment routes accept any fresh `/api/upload/image/<file>` URL, so a
 * shared prefix would let another tenant attach a banner's file name to their own comment
 * and then delete the banner by deleting that comment.
 */
export function brandAssetObjectKey(filename: string): string {
  return `branding/${filename}`;
}

export interface ProjectBrandingFields {
  brandColor: string | null;
  brandBannerKey: string | null;
  brandLogoKey: string | null;
}

export interface ProjectBranding {
  color: string | null;
  bannerUrl: string | null;
  logoUrl: string | null;
}

export function isBrandAssetKind(value: unknown): value is BrandAssetKind {
  return typeof value === 'string' && (BRAND_ASSET_KINDS as readonly string[]).includes(value);
}

/**
 * Normalize a user-supplied brand color. Only `#rrggbb` is accepted: the value ends up
 * inside an inline style, so nothing that could carry other CSS gets through.
 * Returns null for anything else.
 */
export function normalizeBrandColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return BRAND_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

function channelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` color. */
export function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever reads better on top of the brand color. */
export function brandForeground(hex: string): '#000000' | '#ffffff' {
  return contrastRatio(hex, '#000000') >= contrastRatio(hex, '#ffffff') ? '#000000' : '#ffffff';
}

/**
 * CSS variables that re-tint the app's accent with the brand color. Background and text
 * colors are left alone so light and dark mode keep working.
 *
 * They are set inline on a page wrapper, so anything Radix portals into <body> (dialogs,
 * dropdown menus, toasts) keeps OpenFrame's default accent.
 */
export function brandStyle(color: string | null | undefined): CSSProperties | undefined {
  const normalized = normalizeBrandColor(color);
  if (!normalized) return undefined;
  const foreground = brandForeground(normalized);
  return {
    '--primary': normalized,
    '--primary-foreground': foreground,
    '--accent': normalized,
    '--accent-foreground': foreground,
    '--ring': normalized,
  } as CSSProperties;
}

/** The stored file name of a branding asset, or null when the key is not one we wrote. */
export function brandAssetFilename(key: string | null | undefined): string | null {
  if (!key) return null;
  return BRAND_ASSET_KEY_PATTERN.exec(key)?.[1] ?? null;
}

/**
 * Viewers who reach a project through a single video or folder have no project access of
 * their own, so the asset route needs that context to authorize them.
 */
export type BrandAssetContext = { videoId?: string; folderId?: string | null };

export function brandAssetUrl(
  projectId: string,
  key: string | null | undefined,
  context: BrandAssetContext = {}
): string | null {
  const filename = brandAssetFilename(key);
  if (!filename) return null;
  const params = new URLSearchParams();
  if (context.videoId) params.set('videoId', context.videoId);
  else if (context.folderId) params.set('folderId', context.folderId);
  const query = params.toString();
  return `/api/projects/${encodeURIComponent(projectId)}/branding/${filename}${query ? `?${query}` : ''}`;
}

/**
 * The R2 key behind a branding URL without a query string, for the media cleanup helpers,
 * which address every stored file by the path it is served from.
 */
export function brandAssetPathToObjectKey(url: string): string | null {
  const filename = BRAND_ASSET_PATH_PATTERN.exec(url)?.[1];
  return filename ? brandAssetObjectKey(filename) : null;
}

/**
 * A project row without its branding storage keys, for API responses. Clients get the
 * branding as served URLs from `toProjectBranding` instead.
 */
export function withoutBrandKeys<T extends { brandBannerKey?: unknown; brandLogoKey?: unknown }>(
  row: T
): Omit<T, 'brandBannerKey' | 'brandLogoKey'> {
  const rest = { ...row };
  delete rest.brandBannerKey;
  delete rest.brandLogoKey;
  return rest;
}

export function toProjectBranding(
  projectId: string,
  fields: ProjectBrandingFields,
  context: BrandAssetContext = {}
): ProjectBranding | null {
  const color = normalizeBrandColor(fields.brandColor);
  const bannerUrl = brandAssetUrl(projectId, fields.brandBannerKey, context);
  const logoUrl = brandAssetUrl(projectId, fields.brandLogoKey, context);
  if (!color && !bannerUrl && !logoUrl) return null;
  return { color, bannerUrl, logoUrl };
}
