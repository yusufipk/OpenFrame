import { logError } from '@/lib/logger';

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  return defaultValue;
}

let warnedAboutConflictingUploadFlags = false;

function warnIfConflictingDirectUploadFlags(): void {
  if (warnedAboutConflictingUploadFlags) return;
  if (!isS3VideoUploadsFeatureEnabled() || !isBunnyUploadsFeatureEnabled()) return;
  if (!hasR2Config() || !hasBunnyUploadsConfig()) return;

  warnedAboutConflictingUploadFlags = true;
  logError(
    'OPENFRAME_ENABLE_S3_VIDEO_UPLOADS and OPENFRAME_ENABLE_BUNNY_UPLOADS are both enabled with valid config. S3 video uploads take precedence; disable Bunny uploads for self-hosted deployments.',
    new Error('Conflicting direct upload feature flags')
  );
}

export function isStripeFeatureEnabled() {
  return readBooleanEnv('OPENFRAME_ENABLE_STRIPE', true);
}

export function hasStripeConfig() {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}

export function isStripeBillingEnabled() {
  return isStripeFeatureEnabled() && hasStripeConfig();
}

export function isBunnyUploadsFeatureEnabled() {
  return readBooleanEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', true);
}

export function hasBunnyUploadsConfig() {
  return Boolean(
    process.env.BUNNY_STREAM_API_KEY &&
    (process.env.BUNNY_STREAM_LIBRARY_ID || process.env.NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID)
  );
}

export function isS3VideoUploadsFeatureEnabled() {
  return readBooleanEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', false);
}

export function hasR2Config() {
  return Boolean(
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME &&
    (process.env.R2_ENDPOINT || process.env.R2_ACCOUNT_ID)
  );
}

export function isS3VideoUploadsEnabled() {
  warnIfConflictingDirectUploadFlags();
  return isS3VideoUploadsFeatureEnabled() && hasR2Config();
}

export function isBunnyUploadsEnabled() {
  if (isS3VideoUploadsEnabled()) {
    return false;
  }
  return isBunnyUploadsFeatureEnabled() && hasBunnyUploadsConfig();
}

/**
 * Google Drive import needs a Picker API key and the Cloud project number on top
 * of an OAuth client. The client id defaults to the sign-in one, since one OAuth
 * client can serve both; a host that keeps them apart sets GOOGLE_DRIVE_CLIENT_ID.
 */
export function getGoogleDriveConfig(): {
  clientId: string;
  apiKey: string;
  appId: string;
} | null {
  const clientId = (
    process.env.GOOGLE_DRIVE_CLIENT_ID ||
    process.env.GOOGLE_CLIENT_ID ||
    ''
  ).trim();
  const apiKey = (process.env.GOOGLE_PICKER_API_KEY || '').trim();
  const appId = (process.env.GOOGLE_CLOUD_PROJECT_NUMBER || '').trim();
  if (!clientId || !apiKey || !appId) return null;
  return { clientId, apiKey, appId };
}

/**
 * Where a Drive import lands, or null when this host cannot import at all. It
 * follows the direct upload backend, so a host never stores an imported video
 * somewhere its own uploads would not go.
 */
export function getDriveImportBackend(): 'BUNNY' | 'S3' | null {
  if (!readBooleanEnv('OPENFRAME_ENABLE_DRIVE_IMPORT', true)) return null;
  if (!getGoogleDriveConfig()) return null;
  if (isS3VideoUploadsEnabled()) return 'S3';
  if (isBunnyUploadsEnabled()) return 'BUNNY';
  return null;
}

export function isDirectFileUploadEnabled() {
  return isS3VideoUploadsEnabled() || isBunnyUploadsEnabled();
}

/**
 * The per-file ceiling for a host that has no billing, and therefore no per
 * account quota to derive one from.
 */
export const DEFAULT_MAX_VIDEO_UPLOAD_BYTES =
  BigInt(5) * BigInt(1024) * BigInt(1024) * BigInt(1024);

/**
 * A flat per-file ceiling this host has pinned, or null when it has not.
 *
 * Null is the ordinary case. The ceiling that applies to a paying account is a
 * share of that account's own storage quota, which one number in the
 * environment cannot express (see `getMaxVideoUploadBytesForUser`). A host that
 * wants an absolute cap on top of that still sets this, and the lower of the
 * two wins.
 */
export function getConfiguredMaxVideoUploadBytes(): bigint | null {
  const raw = process.env.OPENFRAME_MAX_VIDEO_UPLOAD_BYTES?.trim();
  if (!raw) return null;

  try {
    const parsed = BigInt(raw);
    return parsed > BigInt(0) ? parsed : null;
  } catch {
    return null;
  }
}

export function isInviteCodeRequired() {
  return readBooleanEnv('OPENFRAME_REQUIRE_INVITE_CODE', true);
}

// Acquisition attribution and funnel events. Defaults to OFF, unlike the other
// product flags here, because the cost of the two mistakes is not symmetric: a
// hosted instance that forgets to switch it on shows an empty growth page and is
// noticed the same day, while a self-hosted instance that gets it silently
// switched on accumulates rows nobody asked for. Nothing is ever sent off the
// instance either way, so this is about cost, not disclosure.
export function isProductAnalyticsEnabled() {
  return readBooleanEnv('OPENFRAME_ENABLE_ANALYTICS', false);
}

function parseBigIntEnv(name: string, defaultValue: bigint, minValue?: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;

  try {
    const parsed = BigInt(raw);
    if (parsed <= BigInt(0)) return defaultValue;
    if (minValue !== undefined && parsed < minValue) return minValue;
    return parsed;
  } catch {
    return defaultValue;
  }
}

// Files larger than this use S3 multipart upload (chunked) instead of a single PUT.
// Default 90 MiB keeps each request under the common 100 MB Cloudflare proxy/tunnel cap.
export function getR2MultipartThresholdBytes(): bigint {
  return parseBigIntEnv(
    'OPENFRAME_R2_MULTIPART_THRESHOLD_BYTES',
    BigInt(90) * BigInt(1024) * BigInt(1024)
  );
}

// Size of each multipart chunk. Clamped to the S3 minimum of 5 MiB for non-final parts.
export function getR2MultipartPartSizeBytes(): bigint {
  const minPartSize = BigInt(5) * BigInt(1024) * BigInt(1024);
  return parseBigIntEnv(
    'OPENFRAME_R2_MULTIPART_PART_SIZE_BYTES',
    BigInt(32) * BigInt(1024) * BigInt(1024),
    minPartSize
  );
}
