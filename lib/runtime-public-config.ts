/**
 * Public configuration the browser needs but cannot read from the environment.
 *
 * Next inlines `NEXT_PUBLIC_*` into the client bundle at build time. The published
 * Docker image is built by CI with none of these set, so every browser-side reader
 * gets an empty string no matter what the operator puts in `.env.docker`, and the
 * Bunny player ends up with no CDN host to build a playlist URL from. The server
 * knows the real values on every request, so it serialises them into a JSON script
 * tag in the root layout and the browser reads them back from the DOM. Same reason
 * the CSP is built per request in lib/content-security-policy.ts.
 *
 * Caveat: a prerendered route bakes the values it had at build time into its HTML,
 * and a client-side navigation away from one keeps that copy of the root layout. The
 * prerendered routes are the legal and marketing pages, none of which play video or
 * download media, so nothing reads a stale copy today. A new prerendered route that
 * needs either has to opt into per-request rendering.
 */

import { getDriveImportBackend, getGoogleDriveConfig } from '@/lib/feature-flags';

export const RUNTIME_PUBLIC_CONFIG_ELEMENT_ID = 'openframe-runtime-public-config';

export interface RuntimePublicConfig {
  /** Raw value, not a hostname: lib/bunny-cdn.ts owns the normalisation. */
  bunnyCdnUrl: string;
  /** Comma-separated hostnames, as the environment variable spells them. */
  directDownloadAllowedHosts: string;
  /**
   * What the Google Picker needs in the browser, or null when this host has no
   * Drive import. None of it is secret: the API key is restricted by referrer.
   */
  googleDrive: { clientId: string; apiKey: string; appId: string } | null;
}

/** Server-side: the values as configured for this deployment, read at request time. */
export function buildRuntimePublicConfig(): RuntimePublicConfig {
  return {
    bunnyCdnUrl: process.env.BUNNY_CDN_URL || process.env.NEXT_PUBLIC_BUNNY_CDN_URL || '',
    directDownloadAllowedHosts: process.env.NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS || '',
    googleDrive: getDriveImportBackend() ? getGoogleDriveConfig() : null,
  };
}

/**
 * Browser-side: the injected values, or null when there is no document (the SSR pass
 * of a client component) or no script tag (a page rendered before this existed).
 * Callers fall back to the build-time environment in both cases.
 */
export function readRuntimePublicConfig(): RuntimePublicConfig | null {
  if (typeof document === 'undefined') return null;

  const element = document.getElementById(RUNTIME_PUBLIC_CONFIG_ELEMENT_ID);
  if (!element?.textContent) return null;

  try {
    const parsed: unknown = JSON.parse(element.textContent);
    if (!parsed || typeof parsed !== 'object') return null;
    const { bunnyCdnUrl, directDownloadAllowedHosts, googleDrive } = parsed as Record<
      string,
      unknown
    >;
    return {
      bunnyCdnUrl: typeof bunnyCdnUrl === 'string' ? bunnyCdnUrl : '',
      directDownloadAllowedHosts:
        typeof directDownloadAllowedHosts === 'string' ? directDownloadAllowedHosts : '',
      googleDrive: readGoogleDriveConfig(googleDrive),
    };
  } catch {
    return null;
  }
}

function readGoogleDriveConfig(value: unknown): RuntimePublicConfig['googleDrive'] {
  if (!value || typeof value !== 'object') return null;
  const { clientId, apiKey, appId } = value as Record<string, unknown>;
  if (typeof clientId !== 'string' || typeof apiKey !== 'string' || typeof appId !== 'string') {
    return null;
  }
  if (!clientId || !apiKey || !appId) return null;
  return { clientId, apiKey, appId };
}

export function resolvePublicDirectDownloadAllowedHosts(): string[] {
  // An injected value that is empty means the same as an absent one: nothing was
  // configured here, so keep whatever the bundle was built with rather than
  // narrowing a deployment that already worked.
  const configured =
    readRuntimePublicConfig()?.directDownloadAllowedHosts ||
    process.env.NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS ||
    '';

  return configured
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}
