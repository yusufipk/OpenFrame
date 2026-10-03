// The two cookies the acquisition system sets, and how to read them back.
//
// Both are first party, both stay on this deployment's own domain, and neither
// is readable from JavaScript. They exist so that a visitor who arrives from a
// YouTube link on Tuesday and signs up on Friday is still counted against
// YouTube; there is no cross-site identifier and nothing is sent anywhere.
//
// Both are also signed. Nothing here trusts a cookie it did not issue: read
// through `readAnonymousIdCookie` and `readFirstTouchCookie`, never through the
// `decode` helpers, which are the unsigned inner layer.
//
// Imported by the proxy, so this file must stay free of Prisma and of anything
// else that cannot run on the edge.

import type { AcquisitionChannel } from '@prisma/client';
import { sanitizeLandingPath, sanitizeTag, normalizeHost } from '@/lib/analytics/channel';
import { signCookieValue, unsignCookieValue } from '@/lib/analytics/signing';

export const ANONYMOUS_ID_COOKIE = 'of_aid';
export const FIRST_TOUCH_COOKIE = 'of_ft';

export const ANONYMOUS_ID_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** cuid-ish length bound. Values outside it are treated as absent, not repaired. */
const ANONYMOUS_ID_PATTERN = /^[a-z0-9]{16,64}$/;

export interface FirstTouch {
  channel: AcquisitionChannel;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  referrerHost: string | null;
  landingPath: string;
}

/** Short keys: this rides on every request, so the wire form stays compact. */
interface EncodedFirstTouch {
  c: string;
  s?: string;
  m?: string;
  k?: string;
  r?: string;
  p: string;
}

const CHANNELS: readonly AcquisitionChannel[] = [
  'DIRECT',
  'GITHUB',
  'YOUTUBE',
  'GOOGLE',
  'PAID',
  'REVIEW_LINK',
  'REFERRAL',
  'OUTBOUND',
  'COMMUNITY',
  'OTHER',
];

export function isAcquisitionChannel(value: unknown): value is AcquisitionChannel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

export function isValidAnonymousId(value: string | null | undefined): value is string {
  return typeof value === 'string' && ANONYMOUS_ID_PATTERN.test(value);
}

/** 128 bits from the Web Crypto API, which the edge has, as 32 base36 characters. */
export function generateAnonymousId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const byte of bytes) {
    id += byte.toString(36).padStart(2, '0');
  }
  return id;
}

// base64url rather than encodeURIComponent, and not for compactness. Cookie
// values are percent-encoded on the way out and decoded on the way back, by
// several layers that do not all agree on how many times; a payload that already
// contains percent escapes comes back subtly different and takes the signature
// down with it. base64url has nothing either layer wants to touch.
function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function encodeFirstTouch(touch: FirstTouch): string {
  const payload: EncodedFirstTouch = { c: touch.channel, p: touch.landingPath };
  if (touch.utmSource) payload.s = touch.utmSource;
  if (touch.utmMedium) payload.m = touch.utmMedium;
  if (touch.utmCampaign) payload.k = touch.utmCampaign;
  if (touch.referrerHost) payload.r = touch.referrerHost;
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Parses the cookie body back, re-sanitizing every field.
 *
 * The second line of defence, not the first: callers go through
 * `readFirstTouchCookie`, which checks the signature before this ever runs. The
 * re-sanitizing stays because a value that survives both checks can still be one
 * this deployment signed a year ago, under an older set of rules. Anything that
 * fails validation makes the whole value null, since a half-trusted first touch
 * is worse than none.
 */
export function decodeFirstTouch(raw: string | null | undefined): FirstTouch | null {
  if (!raw) return null;

  const json = fromBase64Url(raw);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;

  if (!isAcquisitionChannel(value.c)) return null;
  if (typeof value.p !== 'string') return null;

  return {
    channel: value.c,
    utmSource: sanitizeTag(typeof value.s === 'string' ? value.s : null),
    utmMedium: sanitizeTag(typeof value.m === 'string' ? value.m : null),
    utmCampaign: sanitizeTag(typeof value.k === 'string' ? value.k : null),
    referrerHost: normalizeHost(typeof value.r === 'string' ? value.r : null),
    landingPath: sanitizeLandingPath(value.p),
  };
}

// ---------------------------------------------------------------------------
// The signed forms, which are the only ones anything outside this file uses.
// ---------------------------------------------------------------------------

/** The cookie value to set, or null when there is no secret to sign it with. */
export function signAnonymousId(anonymousId: string): Promise<string | null> {
  return signCookieValue(anonymousId);
}

export function signFirstTouch(touch: FirstTouch): Promise<string | null> {
  return signCookieValue(encodeFirstTouch(touch));
}

/**
 * The anonymous id this deployment issued, or null.
 *
 * Null covers every failure the same way: no cookie, a cookie signed with
 * another key, one edited by hand, one whose id no longer matches the shape we
 * mint. A visitor we cannot vouch for is not counted rather than counted wrong.
 */
export async function readAnonymousIdCookie(
  raw: string | null | undefined
): Promise<string | null> {
  const anonymousId = await unsignCookieValue(raw);
  return isValidAnonymousId(anonymousId) ? anonymousId : null;
}

export async function readFirstTouchCookie(
  raw: string | null | undefined
): Promise<FirstTouch | null> {
  return decodeFirstTouch(await unsignCookieValue(raw));
}
