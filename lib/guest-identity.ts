import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { NextRequest, NextResponse } from 'next/server';

const GUEST_IDENTITY_COOKIE_NAME = 'openframe_guest_identity';
const GUEST_IDENTITY_TTL_SECONDS = 60 * 60 * 24 * 180; // 180 days

interface GuestIdentityPayload {
  gid: string;
  exp: number;
}

function getGuestIdentitySecret(): string {
  const secret =
    process.env.GUEST_IDENTITY_SECRET ?? process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('Missing GUEST_IDENTITY_SECRET, AUTH_SECRET, or NEXTAUTH_SECRET.');
  }
  return secret;
}

function sign(value: string): string {
  return createHmac('sha256', getGuestIdentitySecret()).update(value).digest('base64url');
}

function createSignedValue(payload: GuestIdentityPayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function parseSignedValue(value: string): GuestIdentityPayload | null {
  const [encodedPayload, signature] = value.split('.');
  if (!encodedPayload || !signature) return null;

  const expectedSignature = sign(encodedPayload);
  const actualBytes = Buffer.from(signature, 'utf8');
  const expectedBytes = Buffer.from(expectedSignature, 'utf8');
  if (actualBytes.length !== expectedBytes.length) return null;
  if (!timingSafeEqual(actualBytes, expectedBytes)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8')
    ) as Partial<GuestIdentityPayload>;
    if (!payload.gid || typeof payload.gid !== 'string') return null;
    if (!payload.exp || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp))
      return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return { gid: payload.gid, exp: payload.exp };
  } catch {
    return null;
  }
}

function createGuestIdentityValue(identityId: string): string {
  return createSignedValue({
    gid: identityId,
    exp: Math.floor(Date.now() / 1000) + GUEST_IDENTITY_TTL_SECONDS,
  });
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

export function getGuestIdentityFromRequest(request: NextRequest): string | null {
  const raw = request.cookies.get(GUEST_IDENTITY_COOKIE_NAME)?.value;
  if (!raw) return null;
  const payload = parseSignedValue(raw);
  return payload?.gid ?? null;
}

export function ensureGuestIdentityFromRequest(request: NextRequest): {
  identityId: string;
  shouldSetCookie: boolean;
} {
  const existingIdentity = getGuestIdentityFromRequest(request);
  if (existingIdentity) {
    return { identityId: existingIdentity, shouldSetCookie: false };
  }

  return { identityId: randomUUID(), shouldSetCookie: true };
}

export function setGuestIdentityCookie(response: NextResponse, identityId: string): void {
  response.cookies.set(
    GUEST_IDENTITY_COOKIE_NAME,
    createGuestIdentityValue(identityId),
    cookieOptions(GUEST_IDENTITY_TTL_SECONDS)
  );
}
