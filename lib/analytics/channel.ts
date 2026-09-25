// Turns whatever the browser told us about a visit into one of nine buckets.
//
// Pure and dependency-free on purpose: this runs in the proxy (edge runtime), so
// the only Prisma reference here is a type-only import, which the compiler erases.
//
// Everything that reaches this file is already reduced to a host and a couple of
// UTM tags. Nothing here ever sees a full URL, so a query string carrying a share
// token or an email address cannot be classified into a stored column by mistake.

import type { AcquisitionChannel } from '@prisma/client';

export interface ChannelInput {
  utmSource?: string | null;
  utmMedium?: string | null;
  referrerHost?: string | null;
}

const MAX_TAG_LENGTH = 64;
const MAX_PATH_LENGTH = 128;

/** Lowercases, trims and caps a UTM tag. Returns null for anything empty. */
export function sanitizeTag(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
  if (!cleaned) return null;
  // Campaign names are ours, so anything outside this set is either a typo or
  // somebody probing what the column accepts. Drop it rather than store it.
  if (!/^[a-z0-9._%+\- ]+$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Strips the `www.` prefix and the port, lowercases, and caps the length.
 *
 * A whole URL is not a host and comes back null. Splitting on the first colon
 * would otherwise turn `https://github.com` into the host `https`, and every
 * caller that passed one by mistake would file its traffic under a channel that
 * does not exist.
 */
export function normalizeHost(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  const withoutPort = trimmed.replace(/:\d+$/, '');
  const host = withoutPort.replace(/^www\./, '');
  if (!host || !/^[a-z0-9.\-]+$/.test(host)) return null;
  return host.slice(0, MAX_TAG_LENGTH);
}

/**
 * The referring host, or null when there is no usable one.
 *
 * A referrer pointing at our own deployment is not a referrer: it is the visitor
 * clicking through the site. Treating it as one would file most of the funnel
 * under whatever page they happened to start on.
 */
export function extractReferrerHost(
  referrer: string | null | undefined,
  selfHost?: string | null
): string | null {
  if (!referrer) return null;
  let host: string | null;
  try {
    const url = new URL(referrer);
    // Browsers only ever send an http(s) referrer. Anything else is a scheme we
    // have no host for, such as `android-app://com.example`, and reading its
    // opaque body as a domain would invent a referring site.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    host = normalizeHost(url.hostname);
  } catch {
    return null;
  }
  if (!host) return null;
  const self = normalizeHost(selfHost);
  if (self && host === self) return null;
  return host;
}

// What a URL path is allowed to be made of, per RFC 3986: unreserved characters,
// percent escapes, sub-delims and the separators. Everything a real route can
// carry, and nothing that survives being pasted into a page or a log line.
const LANDING_PATH_PATTERN = /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/;

/**
 * Path only, no query string and no fragment, capped and character-checked.
 *
 * The proxy feeds this `request.nextUrl.pathname`, which is already a path. The
 * cookie reader feeds it whatever the cookie said, which is why the allowlist is
 * here rather than left to the caller: an unchecked value would put newlines and
 * markup into a column that some later admin table renders.
 */
export function sanitizeLandingPath(pathname: string | null | undefined): string {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return '/';
  // Share tokens can arrive with percent-encoded path characters. Keep them out
  // of first-touch cookies and analytics rows even when the route is encoded.
  let decodedPath = pathname;
  for (let pass = 0; pass < 2; pass += 1) {
    if (decodedPath.startsWith('/s/')) return '/s';
    decodedPath = decodedPath.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
  }
  if (decodedPath.startsWith('/s/')) return '/s';
  const path = (pathname.split('?')[0]?.split('#')[0] ?? '/').slice(0, MAX_PATH_LENGTH);
  if (!path || !LANDING_PATH_PATTERN.test(path)) return '/';
  return path;
}

function suffixMatch(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

const GITHUB_HOSTS = ['github.com', 'github.blog'];
const YOUTUBE_HOSTS = ['youtube.com', 'youtu.be'];

// The bucket the plan calls "google" is really organic search. Google is the
// overwhelming majority of it, and splitting Bing and DuckDuckGo into their own
// slivers would make every row in the scoreboard smaller without changing a
// single decision.
const SEARCH_HOSTS = ['google.com', 'bing.com', 'duckduckgo.com', 'ecosia.org', 'yandex.com'];

const REVIEW_HOSTS = [
  'producthunt.com',
  'g2.com',
  'capterra.com',
  'getapp.com',
  'alternativeto.net',
  'saashub.com',
  'slant.co',
  'trustpilot.com',
  'sourceforge.net',
];

const COMMUNITY_HOSTS = [
  'reddit.com',
  'news.ycombinator.com',
  'lobste.rs',
  'discord.com',
  'discord.gg',
  'x.com',
  'twitter.com',
  't.co',
  'linkedin.com',
  'lnkd.in',
  'bsky.app',
  'mastodon.social',
  'dev.to',
  'indiehackers.com',
  'facebook.com',
  'instagram.com',
  't.me',
];

// utm_source values we set ourselves, plus the ones other people tend to use
// when they link us. Matched exactly after sanitizing.
const SOURCE_NAMES: ReadonlyMap<string, AcquisitionChannel> = new Map([
  ['github', 'GITHUB'],
  ['youtube', 'YOUTUBE'],
  ['yt', 'YOUTUBE'],
  ['google', 'GOOGLE'],
  ['bing', 'GOOGLE'],
  ['duckduckgo', 'GOOGLE'],
  ['producthunt', 'REVIEW_LINK'],
  ['product-hunt', 'REVIEW_LINK'],
  ['g2', 'REVIEW_LINK'],
  ['capterra', 'REVIEW_LINK'],
  ['alternativeto', 'REVIEW_LINK'],
  ['reddit', 'COMMUNITY'],
  ['hackernews', 'COMMUNITY'],
  ['hn', 'COMMUNITY'],
  ['discord', 'COMMUNITY'],
  ['twitter', 'COMMUNITY'],
  ['x', 'COMMUNITY'],
  ['linkedin', 'COMMUNITY'],
  ['newsletter', 'OUTBOUND'],
  ['coldmail', 'OUTBOUND'],
  ['outreach', 'OUTBOUND'],
]);

// A medium that names the motion beats the source that names the place: an
// outbound campaign sent from a LinkedIn account is outbound, not community.
const MEDIUM_NAMES: ReadonlyMap<string, AcquisitionChannel> = new Map([
  ['outbound', 'OUTBOUND'],
  ['email', 'OUTBOUND'],
  ['cold-email', 'OUTBOUND'],
  ['coldemail', 'OUTBOUND'],
  ['dm', 'OUTBOUND'],
  ['referral', 'REFERRAL'],
  ['affiliate', 'REFERRAL'],
]);

function classifyHost(host: string): AcquisitionChannel | null {
  if (GITHUB_HOSTS.some((domain) => suffixMatch(host, domain))) return 'GITHUB';
  if (YOUTUBE_HOSTS.some((domain) => suffixMatch(host, domain))) return 'YOUTUBE';
  // google.co.uk, google.de and the rest: the country domains all sit under a
  // `google.<tld>` label, so match the label rather than listing 190 domains.
  if (/(^|\.)google\.[a-z.]{2,6}$/.test(host)) return 'GOOGLE';
  if (SEARCH_HOSTS.some((domain) => suffixMatch(host, domain))) return 'GOOGLE';
  if (REVIEW_HOSTS.some((domain) => suffixMatch(host, domain))) return 'REVIEW_LINK';
  if (COMMUNITY_HOSTS.some((domain) => suffixMatch(host, domain))) return 'COMMUNITY';
  return null;
}

/**
 * The bucket a visit belongs to.
 *
 * Precedence: an explicit medium that names the motion, then an explicit source,
 * then the referring host, then direct. A tagged campaign we do not recognise is
 * OTHER rather than DIRECT, because somebody deliberately tagged it.
 *
 * An unrecognised site that links to us counts as REFERRAL. The raw host is
 * stored alongside, so a host that turns out to matter can be promoted into one
 * of the lists above and re-read from history.
 */
export function classifyChannel(input: ChannelInput): AcquisitionChannel {
  const source = sanitizeTag(input.utmSource);
  const medium = sanitizeTag(input.utmMedium);
  const host = normalizeHost(input.referrerHost);

  const byMedium = medium ? MEDIUM_NAMES.get(medium) : undefined;
  if (byMedium) return byMedium;

  if (source) {
    const bySource = SOURCE_NAMES.get(source);
    if (bySource) return bySource;
    // A source that looks like a domain (utm_source=github.com) is worth reading
    // as one before giving up on it.
    return classifyHost(source) ?? 'OTHER';
  }

  if (host) {
    return classifyHost(host) ?? 'REFERRAL';
  }

  return 'DIRECT';
}
