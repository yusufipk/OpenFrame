// Pure helpers for the Premiere panel. No Premiere or network calls here, so the
// unit tests can load this file directly.

// Premiere measures time in ticks: 254,016,000,000 per second.
const TICKS_PER_SECOND = 254016000000;

// The frame rates the OpenFrame export API accepts, as exact ratios.
const SUPPORTED_RATES = [
  '24',
  '25',
  '30',
  '48',
  '50',
  '60',
  '24000/1001',
  '30000/1001',
  '60000/1001',
];

function ticksPerFrame(rate) {
  const [numerator, denominator = 1] = rate.split('/').map(Number);
  return (TICKS_PER_SECOND * denominator) / numerator;
}

// A sequence reports its timebase as ticks per frame. Every supported rate has a
// whole number of ticks per frame, so the match is exact.
function rateFromTimebase(timebase) {
  const ticks = Number(timebase);
  return SUPPORTED_RATES.find((rate) => ticksPerFrame(rate) === ticks) ?? null;
}

// Ticks as the decimal string Premiere uses. A day at 60 fps passes 2^53 ticks, so
// the product is taken in BigInt.
function framesToTicks(frames, rate) {
  return (BigInt(frames) * BigInt(ticksPerFrame(rate))).toString();
}

// Plain http only reaches a server on this machine or the local network; anywhere
// else the token would cross the internet unencrypted.
function isLocalHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

// Accepts the address of a video page, e.g.
// https://open-frame.net/projects/<projectId>/videos/<videoId>?version=...
function parseVideoLink(value) {
  try {
    const url = new URL(value.trim());
    const secure = url.protocol === 'https:';
    if (!secure && !(url.protocol === 'http:' && isLocalHost(url.hostname))) return null;
    const match = /^\/projects\/([^/]+)\/videos\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) return null;
    return {
      origin: url.origin,
      projectId: decodeURIComponent(match[1]),
      videoId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

// A token is saved for the server it was pasted for and only filled in for that
// server again, so a link to some other host never receives it.
function tokenKey(origin) {
  return `openframe.token:${origin}`;
}

function normalizeLines(value) {
  return String(value).replace(/\r\n?/g, '\n');
}

// The last line of every marker this panel writes. It is how a later sync finds
// the markers it owns for this version, and leaves the editor's own markers alone.
function markerTag(versionId) {
  return `[OpenFrame ${versionId}]`;
}

function ownsMarker(comments, versionId) {
  if (typeof comments !== 'string') return false;
  const lines = normalizeLines(comments).split('\n');
  return lines.length > 1 && lines[lines.length - 1] === markerTag(versionId);
}

function markerComments(marker, versionId) {
  return `${marker.comments}\n${markerTag(versionId)}`;
}

// Identifies a marker by where it starts and what it says, the same whether the
// values come from the API or are read back from Premiere.
function markerKey(startTicks, comments) {
  return `${String(startTicks).trim()}|${normalizeLines(comments)}`;
}

function versionName(version) {
  return version.versionLabel
    ? `v${version.versionNumber}: ${version.versionLabel}`
    : `v${version.versionNumber}`;
}

function errorMessage(status, body) {
  const error = body && body.error;
  if (error && typeof error.message === 'string') return error.message;
  if (typeof error === 'string') return error;
  return `HTTP ${status}`;
}

// Premiere has been reported to hang on very large transactions.
function chunks(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

module.exports = {
  TICKS_PER_SECOND,
  rateFromTimebase,
  ticksPerFrame,
  framesToTicks,
  isLocalHost,
  parseVideoLink,
  tokenKey,
  markerTag,
  ownsMarker,
  markerComments,
  markerKey,
  versionName,
  errorMessage,
  chunks,
};
