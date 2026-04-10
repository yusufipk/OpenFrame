import type { NextRequest } from 'next/server';

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getConfiguredOrigins(): string[] {
  const configured = [process.env.NEXT_PUBLIC_APP_URL, process.env.NEXTAUTH_URL];
  return configured
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalizeOrigin(/^https?:\/\//i.test(value) ? value : `https://${value}`))
    .filter((value): value is string => value !== null);
}

export function getAllowedRequestOrigins(request: NextRequest): Set<string> {
  const origins = new Set<string>();

  // Only trust server-side computed origin and operator-configured origins.
  // x-forwarded-host / x-forwarded-proto are client-controlled and must never
  // be used to build the allowed-origin set (SSRF / origin-spoof vector).
  origins.add(request.nextUrl.origin);

  for (const configuredOrigin of getConfiguredOrigins()) {
    origins.add(configuredOrigin);
  }

  return origins;
}

export function isTrustedSameOriginRequest(request: NextRequest): boolean {
  const requestOrigin = request.headers.get('origin');
  if (!requestOrigin) return false;

  const normalizedRequestOrigin = normalizeOrigin(requestOrigin);
  if (!normalizedRequestOrigin) return false;

  return getAllowedRequestOrigins(request).has(normalizedRequestOrigin);
}
