import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { checkRateLimit, getClientIp, rateLimit, rateLimitHeaders } from '@/lib/rate-limit';
import { MAX_SHARE_PASSWORD_LENGTH, validateShareLinkAccess } from '@/lib/share-links';
import {
  createPendingShareValue,
  createShareSessionValue,
  getPendingShareCookieName,
  getPendingShareTokenFromRequest,
  getShareSessionCookieName,
  pendingShareCookieConfig,
  shareSessionCookieConfig,
} from '@/lib/share-session';

type RouteParams = { params: Promise<{ videoId: string }> };

async function findVideo(videoId: string) {
  return db.video.findUnique({
    where: { id: videoId },
    select: { id: true, projectId: true },
  });
}

function baseCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

function validateSameOriginRequest(request: NextRequest): NextResponse | null {
  const origin = request.headers.get('origin');
  if (!origin) {
    return NextResponse.json({ error: 'Missing Origin header' }, { status: 403 });
  }

  if (origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: 'Cross-origin requests are not allowed' }, { status: 403 });
  }

  return null;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { videoId } = await params;
  const cleanWatchUrl = new URL(`/watch/${videoId}`, request.nextUrl.origin);
  const legacyShareToken = request.nextUrl.searchParams.get('shareToken');

  // Keep GET route for backwards compatibility, but never establish session from GET.
  if (legacyShareToken) {
    cleanWatchUrl.searchParams.set('shareToken', legacyShareToken);
  }
  return NextResponse.redirect(cleanWatchUrl);
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const originError = validateSameOriginRequest(request);
  if (originError) return originError;

  const globalLimit = await rateLimit(request, 'share-unlock');
  if (globalLimit) return globalLimit;

  const { videoId } = await params;
  const video = await findVideo(videoId);
  if (!video) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const password = typeof body?.password === 'string' ? body.password : '';
  const shareTokenFromBody = typeof body?.shareToken === 'string' ? body.shareToken.trim() : '';

  if (password.length > MAX_SHARE_PASSWORD_LENGTH) {
    return NextResponse.json({ error: 'Password is too long' }, { status: 400 });
  }

  const pendingToken = getPendingShareTokenFromRequest(request, video.id);
  const tokenForAttempt = shareTokenFromBody || pendingToken;

  if (!tokenForAttempt) {
    return NextResponse.json({ error: 'Share session expired. Open the share link again.' }, { status: 401 });
  }

  // Additional throttle bound to token+IP to reduce password guessing against one link.
  const ip = getClientIp(request);
  const tokenFingerprint = createHash('sha256').update(tokenForAttempt).digest('hex').slice(0, 24);
  const tokenScopedLimit = await checkRateLimit(
    `${ip}:share-unlock:${tokenFingerprint}`,
    'share-unlock-token',
    { windowMs: 15 * 60 * 1000, maxRequests: 8 }
  );

  if (!tokenScopedLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Please try again later.' },
      {
        status: 429,
        headers: rateLimitHeaders(tokenScopedLimit, 8),
      }
    );
  }

  const access = await validateShareLinkAccess({
    token: tokenForAttempt,
    projectId: video.projectId,
    videoId: video.id,
    requiredPermission: 'VIEW',
    presentedPassword: password,
  });

  if (access.requiresPassword && shareTokenFromBody) {
    const response = NextResponse.json({ requiresPassword: true }, { status: 401 });
    response.cookies.set(
      getPendingShareCookieName(video.id),
      createPendingShareValue(tokenForAttempt, video.id),
      baseCookieOptions(pendingShareCookieConfig.maxAge)
    );
    response.cookies.delete(getShareSessionCookieName(video.id));
    return response;
  }

  if (!access.hasAccess) {
    const response = NextResponse.json(
      { error: access.requiresPassword ? 'Invalid password' : 'Share session is invalid' },
      { status: 401 }
    );
    response.cookies.delete(getShareSessionCookieName(video.id));
    return response;
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set(
    getShareSessionCookieName(video.id),
    createShareSessionValue(tokenForAttempt, video.id, !!access.link?.passwordHash),
    baseCookieOptions(shareSessionCookieConfig.maxAge)
  );
  response.cookies.delete(getPendingShareCookieName(video.id));

  return response;
}
