import { NextRequest, NextResponse } from 'next/server';
import { buildContentSecurityPolicy } from '@/lib/content-security-policy';
import {
  classifyChannel,
  extractReferrerHost,
  hasAdClickId,
  sanitizeLandingPath,
  sanitizeTag,
} from '@/lib/analytics/channel';
import {
  ANONYMOUS_ID_COOKIE,
  ANONYMOUS_ID_MAX_AGE_SECONDS,
  FIRST_TOUCH_COOKIE,
  generateAnonymousId,
  readAnonymousIdCookie,
  signAnonymousId,
  signFirstTouch,
} from '@/lib/analytics/cookies';
import { isCountableDocumentRequest, isLikelyBot } from '@/lib/analytics/bots';
import { isProductAnalyticsEnabled } from '@/lib/feature-flags';
import { getPublicOrigin } from '@/lib/request-origin';

// Runs on the edge, so nothing here touches the database. It only decides who a
// visitor is and what brought them, then hands both downstream as signed
// cookies. The rows are written by the pages, which run in Node.
async function applyAcquisitionCookies(
  request: NextRequest,
  response: NextResponse
): Promise<void> {
  if (!isProductAnalyticsEnabled()) return;
  if (!isCountableDocumentRequest(request.headers)) return;
  if (isLikelyBot(request.headers.get('user-agent'))) return;

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    // Not `request.nextUrl.protocol`. Behind a TLS-terminating reverse proxy,
    // which is the deployment shape the README documents, that is the
    // container-internal `http://localhost:3000` and the flag would silently
    // come off in exactly the setup that needs it.
    secure: getPublicOrigin(request).startsWith('https:'),
    path: '/',
    maxAge: ANONYMOUS_ID_MAX_AGE_SECONDS,
  };

  const existingId = await readAnonymousIdCookie(request.cookies.get(ANONYMOUS_ID_COOKIE)?.value);
  if (!existingId) {
    const signedId = await signAnonymousId(generateAnonymousId());
    if (!signedId) return;
    // Set on the request as well as the response: without this the page rendering
    // *this* request cannot see the id, and the first landing view of every new
    // visitor, the one carrying the campaign tags, goes unrecorded.
    request.cookies.set(ANONYMOUS_ID_COOKIE, signedId);
    response.cookies.set(ANONYMOUS_ID_COOKIE, signedId, cookieOptions);
  }

  if (request.cookies.get(FIRST_TOUCH_COOKIE)) return;

  const params = request.nextUrl.searchParams;
  const referrerHost = extractReferrerHost(
    request.headers.get('referer'),
    request.nextUrl.hostname
  );
  const utmSource = sanitizeTag(params.get('utm_source'));
  const utmMedium = sanitizeTag(params.get('utm_medium'));

  const firstTouch = await signFirstTouch({
    channel: classifyChannel({
      utmSource,
      utmMedium,
      referrerHost,
      adClickId: hasAdClickId(params),
    }),
    utmSource,
    utmMedium,
    utmCampaign: sanitizeTag(params.get('utm_campaign')),
    referrerHost,
    landingPath: sanitizeLandingPath(request.nextUrl.pathname),
  });
  if (!firstTouch) return;

  request.cookies.set(FIRST_TOUCH_COOKIE, firstTouch);
  response.cookies.set(FIRST_TOUCH_COOKIE, firstTouch, cookieOptions);
}

export async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request });
  response.headers.set('Content-Security-Policy', buildContentSecurityPolicy());
  await applyAcquisitionCookies(request, response);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
