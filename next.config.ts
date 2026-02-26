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
