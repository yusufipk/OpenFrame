function normalizeBunnyCdnHostname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || null;
  } catch {
    return trimmed.replace(/^https?:\/\//, '').replace(/\/+$/, '') || null;
  }
}

export function resolveServerBunnyCdnHostname(): string | null {
  return normalizeBunnyCdnHostname(
    process.env.BUNNY_CDN_URL || process.env.NEXT_PUBLIC_BUNNY_CDN_URL
  );
}

export function resolvePublicBunnyCdnHostname(): string | null {
  return normalizeBunnyCdnHostname(process.env.NEXT_PUBLIC_BUNNY_CDN_URL);
}
