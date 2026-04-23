import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { checkRateLimit, getClientIp, rateLimitHeaders } from '@/lib/rate-limit';

const GUEST_UPLOAD_TOKEN_TYPE = 'guest-upload';
const DEFAULT_GUEST_UPLOAD_TOKEN_TTL_SECONDS = 60 * 3;
const GUEST_UPLOAD_VIDEO_WINDOW_MS = 15 * 60 * 1000;
const GUEST_UPLOAD_VIDEO_MAX_REQUESTS = 12;
const GUEST_BUNNY_UPLOAD_VIDEO_MAX_REQUESTS = 4;
const GUEST_UPLOAD_SESSION_WINDOW_MS = 15 * 60 * 1000;
const GUEST_UPLOAD_SESSION_MAX_REQUESTS = 8;

export type GuestUploadIntent = 'audio' | 'image' | 'bunny';

interface GuestUploadTokenPayload {
  typ: typeof GUEST_UPLOAD_TOKEN_TYPE;
  pid: string;
  vid: string;
  iat: number;
  exp: number;
  intent: GuestUploadIntent;
  ctx: string;
}

interface GuestUploadTokenSubject {
  projectId: string;
  videoId: string;
  intent: GuestUploadIntent;
  context: string;
}

const TRUSTED_IP_PATTERN = /^[\da-fA-F.:]+$/;

function getGuestUploadTokenSecret(): string {
  const secret =
    process.env.GUEST_UPLOAD_TOKEN_SECRET ?? process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('Missing GUEST_UPLOAD_TOKEN_SECRET, AUTH_SECRET, or NEXTAUTH_SECRET.');
  }
  return secret;
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', getGuestUploadTokenSecret())
    .update(encodedPayload)
    .digest('base64url');
}

function getCloudflareClientIp(request: Request): string | null {
  const cfIp = request.headers.get('cf-connecting-ip')?.trim();
  if (!cfIp) return null;
  if (cfIp.length > 45 || !TRUSTED_IP_PATTERN.test(cfIp)) return null;
  return cfIp;
}

function resolveTrustedClientIp(request: Request): string | null {
  const cfIp = getCloudflareClientIp(request);
  if (cfIp) return cfIp;

  // In production, require Cloudflare-provided client IP to avoid spoofable header fallbacks.
  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  return getClientIp(request);
}

function isValidPayload(value: unknown): value is GuestUploadTokenPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<GuestUploadTokenPayload>;
  return (
    payload.typ === GUEST_UPLOAD_TOKEN_TYPE &&
    typeof payload.pid === 'string' &&
    typeof payload.vid === 'string' &&
    typeof payload.iat === 'number' &&
    Number.isFinite(payload.iat) &&
    typeof payload.exp === 'number' &&
    Number.isFinite(payload.exp) &&
    (payload.intent === 'audio' || payload.intent === 'image' || payload.intent === 'bunny') &&
    typeof payload.ctx === 'string'
  );
}

export function deriveGuestUploadContext(
  request: Request,
  shareToken: string | null
): string | null {
  const ip = resolveTrustedClientIp(request);
  if (!ip) return null;

  const shareFingerprint = shareToken
    ? createHash('sha256').update(shareToken).digest('hex').slice(0, 24)
    : 'public';
  return `${ip}:${shareFingerprint}`;
}

export function createGuestUploadToken(
  subject: GuestUploadTokenSubject,
  ttlSeconds = DEFAULT_GUEST_UPLOAD_TOKEN_TTL_SECONDS
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: GuestUploadTokenPayload = {
    typ: GUEST_UPLOAD_TOKEN_TYPE,
    pid: subject.projectId,
    vid: subject.videoId,
    iat: now,
    exp: now + ttlSeconds,
    intent: subject.intent,
    ctx: subject.context,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function verifyGuestUploadToken(token: string, subject: GuestUploadTokenSubject): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return false;

    const [encodedPayload, providedSignature] = parts;
    if (!encodedPayload || !providedSignature) return false;

    const expectedSignature = signPayload(encodedPayload);
    const providedBuffer = Buffer.from(providedSignature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    if (providedBuffer.length !== expectedBuffer.length) return false;
    if (!timingSafeEqual(providedBuffer, expectedBuffer)) return false;

    const payloadRaw = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const payloadUnknown: unknown = JSON.parse(payloadRaw);
    if (!isValidPayload(payloadUnknown)) return false;

    const payload = payloadUnknown;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return false;

    return (
      payload.pid === subject.projectId &&
      payload.vid === subject.videoId &&
      payload.intent === subject.intent &&
      payload.ctx === subject.context
    );
  } catch {
    return false;
  }
}

export async function enforceGuestUploadQuota(
  request: Request,
  videoId: string,
  intent: GuestUploadIntent,
  shareToken: string | null
): Promise<NextResponse | null> {
  const ip = resolveTrustedClientIp(request);
  if (!ip) {
    return NextResponse.json({ error: 'Missing trusted client IP header' }, { status: 403 });
  }

  const videoScopedMaxRequests =
    intent === 'bunny' ? GUEST_BUNNY_UPLOAD_VIDEO_MAX_REQUESTS : GUEST_UPLOAD_VIDEO_MAX_REQUESTS;

  const videoScoped = await checkRateLimit(
    `${ip}:guest-upload:${intent}:video:${videoId}`,
    `guest-upload-${intent}-video`,
    { windowMs: GUEST_UPLOAD_VIDEO_WINDOW_MS, maxRequests: videoScopedMaxRequests }
  );
  if (!videoScoped.allowed) {
    return NextResponse.json(
      { error: 'Too many uploads for this video. Please wait before uploading again.' },
      {
        status: 429,
        headers: rateLimitHeaders(videoScoped, videoScopedMaxRequests),
      }
    );
  }

  if (!shareToken) return null;

  const shareFingerprint = createHash('sha256').update(shareToken).digest('hex').slice(0, 24);
  const sessionScoped = await checkRateLimit(
    `${shareFingerprint}:guest-upload:${intent}`,
    `guest-upload-${intent}-session`,
    { windowMs: GUEST_UPLOAD_SESSION_WINDOW_MS, maxRequests: GUEST_UPLOAD_SESSION_MAX_REQUESTS }
  );
  if (!sessionScoped.allowed) {
    return NextResponse.json(
      { error: 'Too many uploads for this share session. Please wait before uploading again.' },
      {
        status: 429,
        headers: rateLimitHeaders(sessionScoped, GUEST_UPLOAD_SESSION_MAX_REQUESTS),
      }
    );
  }

  return null;
}

export const guestUploadTokenTtlSeconds = DEFAULT_GUEST_UPLOAD_TOKEN_TTL_SECONDS;
