import type { NextConfig } from "next";
import type { RemotePattern } from "next/dist/shared/lib/image-config";

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

const bunnyCdnHostname = resolveBunnyCdnHostname();
const isDev = process.env.NODE_ENV === 'development';

// Build Content-Security-Policy from resolved config
const cdnOrigin = bunnyCdnHostname ? `https://${bunnyCdnHostname}` : '';

const connectSrcParts = [
  "'self'",
  'https://video.bunnycdn.com',
  cdnOrigin,
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

const contentSecurityPolicy = [
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

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  // Prevent the app from being embedded in foreign iframes (clickjacking)
  { key: 'X-Frame-Options', value: 'DENY' },
  // Prevent MIME-type sniffing on all responses
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Enforce HTTPS for 2 years
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  // microphone=(self) is required for audio comment recording; camera/geolocation unused
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];

const remotePatterns: RemotePattern[] = [
  { protocol: 'https', hostname: 'img.youtube.com' },
  { protocol: 'https', hostname: 'i.ytimg.com' },
  { protocol: 'https', hostname: 'images.unsplash.com' },
  { protocol: 'https', hostname: 'vz-thumbnail.b-cdn.net' },
  ...(bunnyCdnHostname ? [{ protocol: 'https' as const, hostname: bunnyCdnHostname }] : []),
];

const nextConfig: NextConfig = {
  images: {
    remotePatterns,
    formats: ['image/avif', 'image/webp'],
  },
  experimental: {
    optimizePackageImports: ['lucide-react', 'radix-ui'],
    serverMinification: true,
  },
  poweredByHeader: false,
  compress: true,
  async headers() {
    return [
      // Global security headers applied to every response
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
      {
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        source: '/images/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=2592000',
          },
        ],
      },
      {
        source: '/:path*.ico',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=604800',
          },
        ],
      },
      {
        source: '/:path*.svg',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=2592000',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
