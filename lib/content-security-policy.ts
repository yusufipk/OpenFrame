import { liveReviewEnabled, liveReviewPublicUrl } from '@/lib/live-review/config';

function resolveBunnyCdnHostname(): string | null {
  const raw = process.env.BUNNY_CDN_URL || process.env.NEXT_PUBLIC_BUNNY_CDN_URL;
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.hostname || null;
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/\/+$/, '') || null;
  }
}

function resolveR2ConnectOrigins(): string[] {
  const origins = new Set<string>();

  for (const raw of [
    process.env.R2_ENDPOINT?.trim(),
    process.env.R2_PRESIGN_ENDPOINT?.trim(),
    process.env.R2_PUBLIC_BASE_URL?.trim(),
  ]) {
    if (!raw) continue;
    try {
      origins.add(new URL(raw).origin);
    } catch {
      // Ignore invalid custom endpoints in CSP generation.
    }
  }

  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const bucket = process.env.R2_BUCKET_NAME?.trim();
  if (accountId) {
    origins.add(`https://${accountId}.r2.cloudflarestorage.com`);
    if (bucket) {
      origins.add(`https://${bucket}.${accountId}.r2.cloudflarestorage.com`);
    }
    origins.add('https://*.r2.cloudflarestorage.com');
  }

  // Docker/MinIO defaults, for local development only. A production build has no reason
  // to allow plaintext loopback object storage, and adding it there weakened the policy of
  // every deployment to accommodate a developer's machine. A self-hosted install whose
  // storage really is on loopback still works: it sets R2_ENDPOINT, which is picked up
  // above.
  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:9000');
    origins.add('http://127.0.0.1:9000');
  }

  return [...origins];
}

/**
 * Build Content-Security-Policy from runtime environment variables.
 * Called per request so Docker/self-hosted storage endpoints are available
 * without rebuilding the image.
 */
export function buildContentSecurityPolicy(): string {
  const isDev = process.env.NODE_ENV === 'development';
  const bunnyCdnHostname = resolveBunnyCdnHostname();
  const cdnOrigin = bunnyCdnHostname ? `https://${bunnyCdnHostname}` : '';

  const connectSrcParts = [
    "'self'",
    'https://video.bunnycdn.com',
    'https://www.youtube.com',
    cdnOrigin,
    ...resolveR2ConnectOrigins(),
    ...(liveReviewEnabled() && liveReviewPublicUrl()
      ? [new URL(liveReviewPublicUrl()!).origin]
      : []),
    // Allow Next.js HMR websocket in development
    ...(isDev ? ['ws://localhost:* wss://localhost:*'] : []),
  ].filter(Boolean);

  const imgSrcParts = [
    "'self'",
    'data:',
    'blob:',
    'https://img.youtube.com',
    'https://i.ytimg.com',
    'https://images.unsplash.com',
    'https://vz-thumbnail.b-cdn.net',
    cdnOrigin,
  ].filter(Boolean);

  const mediaSrcParts = ["'self'", 'blob:', cdnOrigin].filter(Boolean);

  return [
    "default-src 'self'",
    // 'unsafe-inline' is required by Next.js App Router (hydration scripts, inline styles)
    // https://www.youtube.com is required for the dynamically-injected YouTube IFrame API script
    "script-src 'self' 'unsafe-inline' https://www.youtube.com",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSrcParts.join(' ')}`,
    `media-src ${mediaSrcParts.join(' ')}`,
    "frame-src 'self' https://www.youtube.com https://iframe.mediadelivery.net",
    `connect-src ${connectSrcParts.join(' ')}`,
    // next/font self-hosts Google Fonts at build time — no external font origin needed
    "font-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
