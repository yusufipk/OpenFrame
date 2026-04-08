function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  return defaultValue;
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

export function isBunnyUploadsEnabled() {
  return isBunnyUploadsFeatureEnabled() && hasBunnyUploadsConfig();
}

export function isInviteCodeRequired() {
  return readBooleanEnv('OPENFRAME_REQUIRE_INVITE_CODE', true);
}
