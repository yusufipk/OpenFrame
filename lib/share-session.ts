import { createHmac, timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';

const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const PENDING_TTL_SECONDS = 60 * 10; // 10 minutes

interface ShareSessionPayload {
  token: string;
  videoId: string;
  exp: number;
  passwordVerified: boolean;
}

interface PendingSharePayload {
  token: string;
  videoId: string;
  exp: number;
}

function getSessionSecret(): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('Missing AUTH_SECRET/NEXTAUTH_SECRET for share session signing');
  }
  return secret;
}

function sign(data: string): string {
  return createHmac('sha256', getSessionSecret()).update(data).digest('base64url');
}

function createSignedValue(payload: object): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function parseSignedValue<T>(value: string): T | null {
  const [encodedPayload, signature] = value.split('.');
  if (!encodedPayload || !signature) return null;

  const expectedSignature = sign(encodedPayload);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expectedSignature);
  if (actualBytes.length !== expectedBytes.length) return null;
  if (!timingSafeEqual(actualBytes, expectedBytes)) return null;

  try {
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function getShareSessionCookieName(videoId: string): string {
  return `openframe_share_session_${videoId}`;
}

export function getPendingShareCookieName(videoId: string): string {
  return `openframe_share_pending_${videoId}`;
}

export function createShareSessionValue(
  token: string,
  videoId: string,
  passwordVerified: boolean,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS
): string {
  return createSignedValue({
    token,
    videoId,
    passwordVerified,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  } satisfies ShareSessionPayload);
}

export function createPendingShareValue(
  token: string,
  videoId: string,
  ttlSeconds = PENDING_TTL_SECONDS
): string {
  return createSignedValue({
    token,
    videoId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  } satisfies PendingSharePayload);
}

export function getShareSessionFromRequest(
  request: NextRequest,
  videoId: string
): { token: string; passwordVerified: boolean } | null {
  const cookieName = getShareSessionCookieName(videoId);
  const cookieValue = request.cookies.get(cookieName)?.value;
  if (!cookieValue) return null;

  const payload = parseSignedValue<ShareSessionPayload>(cookieValue);
  if (!payload || payload.videoId !== videoId) {
    return null;
  }

  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return { token: payload.token, passwordVerified: payload.passwordVerified };
}

export function getPendingShareTokenFromRequest(
  request: NextRequest,
  videoId: string
): string | null {
  const cookieName = getPendingShareCookieName(videoId);
  const cookieValue = request.cookies.get(cookieName)?.value;
  if (!cookieValue) return null;

  const payload = parseSignedValue<PendingSharePayload>(cookieValue);
  if (!payload || payload.videoId !== videoId) {
    return null;
  }

  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload.token;
}

export const shareSessionCookieConfig = {
  maxAge: DEFAULT_SESSION_TTL_SECONDS,
} as const;

export const pendingShareCookieConfig = {
  maxAge: PENDING_TTL_SECONDS,
} as const;
