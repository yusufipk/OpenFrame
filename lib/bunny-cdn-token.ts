import { createHmac } from 'node:crypto';
import { resolveServerBunnyCdnHostname } from '@/lib/bunny-cdn';

/**
 * Signs Bunny Stream CDN URLs with the pull zone's token authentication key.
 *
 * Server only: the key must never reach a client bundle. Every caller runs after
 * its own access check, so a signed URL is the proof that the check passed.
 *
 * Format: Bunny's advanced (HMAC-SHA256) token, matching the reference signer in
 * github.com/BunnyWay/BunnyCDN.TokenAuthentication (nodejs/token.js):
 *
 *   token = "HS256-" + base64url(HMAC_SHA256(key, signaturePath + expires + signingData))
 *
 * where signingData is the sorted `key=value` parameters (raw values) joined by `&`,
 * and the URL carries the same parameters URL-encoded.
 *
 * Every token here is signed with `token_ignore_params=true`. The player appends a
 * `retry=` cache buster when it reloads a source, and without this flag Bunny would
 * fold that parameter into the signature check and refuse the retry.
 *
 * With no key configured the helpers return plain, unsigned URLs, which is what a
 * deployment without token authentication needs.
 *
 * The key and the pull zone setting have to change together. While token
 * authentication is off, Bunny answers 404 to the path-form directory URLs the
 * players use (query-form file URLs still work); once it is on, unsigned URLs get
 * 403. Set the key and turn the setting on back to back.
 *
 * The Bunny Stream iframe embed (iframe.mediadelivery.net) is not covered here;
 * it has its own "embed view token authentication" setting in the library.
 */

export const BUNNY_PLAYBACK_TOKEN_TTL_SECONDS = 6 * 60 * 60;
// Long enough for a browser to resume an interrupted download of a large file.
// Bunny checks a token when a request starts, not while the response streams.
export const BUNNY_DOWNLOAD_TOKEN_TTL_SECONDS = 60 * 60;
// Thumbnails get an expiry rounded up to the hour, so a list rendered twice within
// the same hour produces byte-identical URLs and the browser cache keeps working.
// Nothing re-fetches a list that stays open, so the lifetime has to outlast a page
// left open for a working day; a thumbnail reveals far less than the video does.
export const BUNNY_THUMBNAIL_TOKEN_MIN_TTL_SECONDS = 12 * 60 * 60;
const EXPIRY_BUCKET_SECONDS = 60 * 60;

// Bunny's shared thumbnail host from older uploads. It is not our pull zone, so it
// cannot be signed; stored URLs on it are rewritten onto the configured host.
const LEGACY_BUNNY_THUMBNAIL_HOSTNAME = 'vz-thumbnail.b-cdn.net';

// Bunny Stream video ids are GUIDs; the character set matches what the upload
// routes accept. Anything else is refused rather than signed, because the id
// becomes the token's directory scope: an id of "" or one carrying a slash would
// widen the scope well past a single video.
const BUNNY_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isBunnyVideoId(value: string | null | undefined): value is string {
  return typeof value === 'string' && BUNNY_VIDEO_ID_PATTERN.test(value);
}

function readTokenKey(): string | null {
  const key = process.env.BUNNY_CDN_TOKEN_KEY?.trim();
  return key ? key : null;
}

/** True for a URL on the configured pull zone or on Bunny's legacy thumbnail host. */
export function isBunnyCdnUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const hostname = resolveServerBunnyCdnHostname();
  try {
    // URL parsing lowercases the stored host; the configured one may not be.
    const stored = new URL(url).hostname;
    return stored === hostname?.toLowerCase() || stored === LEGACY_BUNNY_THUMBNAIL_HOSTNAME;
  } catch {
    return false;
  }
}

/**
 * The hour bucket of the thumbnail tokens issued right now, or 0 without a key,
 * for cache validators that have to change when the signed URLs do.
 */
export function thumbnailTokenBucket(nowMs: number = Date.now()): number {
  return readTokenKey() ? bucketedExpiry(nowMs, BUNNY_THUMBNAIL_TOKEN_MIN_TTL_SECONDS) : 0;
}

/** Rounds `now + minSeconds` up to the next whole hour (unix seconds). */
export function bucketedExpiry(nowMs: number, minSeconds: number): number {
  const earliest = Math.floor(nowMs / 1000) + minSeconds;
  return Math.ceil(earliest / EXPIRY_BUCKET_SECONDS) * EXPIRY_BUCKET_SECONDS;
}

/**
 * The raw token, exposed for the unit test that pins it to Bunny's published
 * vectors. `parameters` excludes `token` and `expires`, as Bunny's spec says.
 */
export function computeBunnyToken(
  key: string,
  signaturePath: string,
  expires: number,
  parameters: Record<string, string>
): string {
  const signingData = Object.keys(parameters)
    .sort()
    .map((name) => `${name}=${parameters[name]}`)
    .join('&');
  const digest = createHmac('sha256', key)
    .update(signaturePath)
    .update(String(expires))
    .update(signingData)
    .digest('base64');
  return `HS256-${digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

function encodeParameters(parameters: Record<string, string>): string {
  return Object.keys(parameters)
    .sort()
    .map((name) => `${name}=${encodeURIComponent(parameters[name])}`)
    .join('&');
}

export type SignedBunnyDirectory = {
  /** Ends in `/<videoId>/`; append `playlist.m3u8`, `original` or `thumbnail.jpg`. */
  baseUrl: string;
  /** Unix seconds, or null when no token key is configured and the URL never expires. */
  expiresAt: number | null;
};

/**
 * A directory token covering `/<videoId>/` and everything under it, in Bunny's
 * path form so HLS rendition playlists and segments, which the manifest lists as
 * relative URLs, inherit the token from the path they are resolved against.
 */
export function signBunnyVideoDirectory(
  videoId: string,
  options: { ttlSeconds?: number; nowMs?: number } = {}
): SignedBunnyDirectory | null {
  const hostname = resolveServerBunnyCdnHostname();
  if (!hostname || !isBunnyVideoId(videoId)) return null;

  const key = readTokenKey();
  const directory = `/${videoId}/`;
  if (!key) {
    return { baseUrl: `https://${hostname}${directory}`, expiresAt: null };
  }

  const expires = bucketedExpiry(
    options.nowMs ?? Date.now(),
    options.ttlSeconds ?? BUNNY_PLAYBACK_TOKEN_TTL_SECONDS
  );
  const parameters = { token_ignore_params: 'true', token_path: directory };
  const token = computeBunnyToken(key, directory, expires, parameters);
  return {
    baseUrl: `https://${hostname}/bcdn_token=${token}&${encodeParameters(parameters)}&expires=${expires}${directory}`,
    expiresAt: expires,
  };
}

/** A token valid for exactly one file, in query string form. */
function signExactPath(hostname: string, path: string, key: string, expires: number): string {
  const parameters = { token_ignore_params: 'true' };
  const token = computeBunnyToken(key, path, expires, parameters);
  return `https://${hostname}${path}?token=${token}&${encodeParameters(parameters)}&expires=${expires}`;
}

/**
 * One file under a video's directory, for server-side fetches and download
 * redirects. `file` is a fixed name the caller chooses (`original`,
 * `play_720p.mp4`, `playlist.m3u8`), never user input.
 */
export function signBunnyVideoFileUrl(
  videoId: string,
  file: string,
  options: { ttlSeconds?: number; nowMs?: number } = {}
): string | null {
  const hostname = resolveServerBunnyCdnHostname();
  if (!hostname || !isBunnyVideoId(videoId) || !/^[A-Za-z0-9._-]+$/.test(file)) return null;

  const path = `/${videoId}/${file}`;
  const key = readTokenKey();
  if (!key) return `https://${hostname}${path}`;

  const nowMs = options.nowMs ?? Date.now();
  const expires =
    Math.floor(nowMs / 1000) + (options.ttlSeconds ?? BUNNY_DOWNLOAD_TOKEN_TTL_SECONDS);
  return signExactPath(hostname, path, key, expires);
}

/** The unsigned thumbnail URL that gets stored in the database. */
export function canonicalBunnyThumbnailUrl(videoId: string): string | null {
  const hostname = resolveServerBunnyCdnHostname();
  if (!hostname || !isBunnyVideoId(videoId)) return null;
  return `https://${hostname}/${videoId}/thumbnail.jpg`;
}

/**
 * Turns a stored thumbnail URL into one the browser can load.
 *
 * The signed path never comes from the stored string. Clients could write a
 * thumbnail URL on the pull zone for some providers (and for every provider before
 * signing existed), so signing whatever path it names would hand anyone with upload
 * rights somewhere a token for another account's `/<guid>/original`. The caller
 * passes the row's own Bunny id instead, the one its upload grant bound to it, and
 * only `/<thatId>/thumbnail.jpg` is ever signed.
 *
 * - A URL off the pull zone (YouTube, R2 proxy paths) is returned unchanged.
 * - A URL on the pull zone or Bunny's legacy thumbnail host becomes the signed
 *   thumbnail of `ownBunnyVideoId`, with an hour-rounded expiry.
 * - A URL on the pull zone without an own Bunny id (a non-Bunny row) is dropped.
 */
export function signBunnyThumbnail(
  url: string | null | undefined,
  ownBunnyVideoId: string | null | undefined,
  nowMs: number = Date.now()
): string | null {
  if (!url) return null;
  if (!isBunnyCdnUrl(url)) return url;

  const hostname = resolveServerBunnyCdnHostname();
  if (!hostname || !isBunnyVideoId(ownBunnyVideoId)) return null;

  const path = `/${ownBunnyVideoId}/thumbnail.jpg`;
  const key = readTokenKey();
  if (!key) return `https://${hostname}${path}`;

  return signExactPath(
    hostname,
    path,
    key,
    bucketedExpiry(nowMs, BUNNY_THUMBNAIL_TOKEN_MIN_TTL_SECONDS)
  );
}

/** A version row with its `thumbnailUrl` signed, for rows serialized to a viewer. */
export function withSignedThumbnail<
  T extends { thumbnailUrl: string | null; providerId: string; videoId: string },
>(row: T, nowMs: number = Date.now()): T {
  if (!row.thumbnailUrl) return row;
  const ownBunnyVideoId = row.providerId === 'bunny' ? row.videoId : null;
  return { ...row, thumbnailUrl: signBunnyThumbnail(row.thumbnailUrl, ownBunnyVideoId, nowMs) };
}
