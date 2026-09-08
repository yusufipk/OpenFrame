const FALLBACK_SITE_URL = 'https://open-frame.net';

function normalizeSiteUrl(rawUrl: string | undefined): string {
  if (!rawUrl) {
    return FALLBACK_SITE_URL;
  }

  const trimmed = rawUrl.trim();

  if (!trimmed) {
    return FALLBACK_SITE_URL;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    return new URL(withProtocol).origin;
  } catch {
    return FALLBACK_SITE_URL;
  }
}

export function getSiteUrl(): string {
  return normalizeSiteUrl(process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL);
}

export const seoConfig = {
  name: 'OpenFrame',
  title: 'Video Review & Approval',
  description:
    'Review videos together with timestamped text and voice comments. Keep feedback organized and your team on the same page.',
  keywords: [
    'fair source video review platform',
    'video review platform',
    'video review tool',
    'timestamped video feedback',
    'video collaboration',
    'video annotation',
    'creative review workflow',
  ],
  url: getSiteUrl(),
  ogImage: '/meta.webp',
  logoPath: '/icon.svg',
  logo: '/icon.svg?v=2',
  githubUrl: 'https://github.com/yusufipk/OpenFrame',
} as const;
