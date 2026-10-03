/**
 * The Google Drive side of a Drive import: checking the access token the browser
 * obtained, reading a picked file's metadata, and building the download url.
 *
 * The token comes from Google Identity Services in the browser with the
 * `drive.file` scope, which reaches only the files the user picked in the Google
 * Picker. It is used for this one import and never stored. See
 * docs/google-drive-import.md.
 */

import { getGoogleDriveConfig } from '@/lib/feature-flags';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3/files';
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

// Drive ids are url-safe base64-ish strings, 28 to 44 characters in practice. The
// bound is looser than that on purpose; what matters is that nothing outside this
// alphabet can reach the url the server builds from it.
const DRIVE_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;

// Longer than any access token Google issues today, short enough that a request
// cannot smuggle a body into the Authorization header we build from it.
const MAX_ACCESS_TOKEN_LENGTH = 4096;

// A token about to expire is refused rather than handed to Bunny, which may queue
// the fetch for a while before it starts.
const MIN_TOKEN_LIFETIME_SECONDS = 5 * 60;

export function isValidDriveFileId(value: unknown): value is string {
  return typeof value === 'string' && DRIVE_FILE_ID_PATTERN.test(value);
}

export function isPlausibleAccessToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ACCESS_TOKEN_LENGTH &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

/**
 * Whether Google says this token was issued to our OAuth client, carries the
 * `drive.file` scope, and has enough life left for the import to start.
 *
 * Without the audience check, a token some other application obtained for the
 * same user could be replayed here, and its scope might reach far more than the
 * files the user picked for us.
 */
export async function verifyDriveAccessToken(accessToken: string): Promise<boolean> {
  const config = getGoogleDriveConfig();
  if (!config) return false;

  const response = await fetch(TOKENINFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ access_token: accessToken }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return false;

  const info = (await response.json().catch(() => null)) as {
    aud?: unknown;
    azp?: unknown;
    scope?: unknown;
    expires_in?: unknown;
  } | null;
  if (!info) return false;

  if (info.aud !== config.clientId && info.azp !== config.clientId) return false;

  const scopes = typeof info.scope === 'string' ? info.scope.split(' ') : [];
  if (!scopes.includes(DRIVE_FILE_SCOPE)) return false;

  const expiresIn = Number(info.expires_in);
  return Number.isFinite(expiresIn) && expiresIn >= MIN_TOKEN_LIFETIME_SECONDS;
}

export type DriveFileMetadata = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: bigint;
  thumbnailLink: string | null;
};

export type DriveFileLookup = { ok: true; file: DriveFileMetadata } | { ok: false; error: string };

/** The top-level MIME family a lookup accepts: videos, or an attachment's images or audio. */
export type DriveFileKind = 'video' | 'image' | 'audio';

export async function getDriveFileMetadata(
  fileId: string,
  accessToken: string,
  accepted: DriveFileKind | readonly DriveFileKind[] = 'video'
): Promise<DriveFileLookup> {
  const kinds: readonly DriveFileKind[] = typeof accepted === 'string' ? [accepted] : accepted;
  if (!isValidDriveFileId(fileId)) return { ok: false, error: 'Invalid Google Drive file id' };

  const url = new URL(`${DRIVE_API_BASE}/${fileId}`);
  url.searchParams.set('fields', 'id,name,mimeType,size,thumbnailLink,trashed');
  url.searchParams.set('supportsAllDrives', 'true');

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 404 || response.status === 403) {
    return { ok: false, error: 'Google Drive file was not found or is not shared with this app' };
  }
  if (!response.ok) {
    return { ok: false, error: `Google Drive refused the request (${response.status})` };
  }

  const body = (await response.json().catch(() => null)) as {
    id?: unknown;
    name?: unknown;
    mimeType?: unknown;
    size?: unknown;
    thumbnailLink?: unknown;
    trashed?: unknown;
  } | null;
  if (!body || body.id !== fileId) {
    return { ok: false, error: 'Google Drive returned an unexpected answer' };
  }
  if (body.trashed === true) return { ok: false, error: 'This file is in the Google Drive trash' };

  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.toLowerCase() : '';
  const kind = kinds.find((candidate) => mimeType.startsWith(`${candidate}/`));
  if (!kind) {
    const names =
      kinds.length === 1
        ? kinds[0]
        : `${kinds.slice(0, -1).join(', ')} or ${kinds[kinds.length - 1]}`;
    return { ok: false, error: `Only ${names} files can be imported here` };
  }

  // Drive reports `size` as a decimal string, and leaves it out for files that
  // have no binary content, such as a Google Doc. Every accepted kind has one.
  let sizeBytes: bigint;
  try {
    sizeBytes =
      typeof body.size === 'string' && /^\d+$/.test(body.size) ? BigInt(body.size) : BigInt(0);
  } catch {
    sizeBytes = BigInt(0);
  }
  if (sizeBytes <= BigInt(0)) {
    return { ok: false, error: 'Google Drive did not report a size for this file' };
  }

  return {
    ok: true,
    file: {
      id: fileId,
      name:
        typeof body.name === 'string' && body.name.trim() ? body.name.trim() : `Untitled ${kind}`,
      mimeType,
      sizeBytes,
      thumbnailLink:
        typeof body.thumbnailLink === 'string' && isGoogleThumbnailUrl(body.thumbnailLink)
          ? body.thumbnailLink
          : null,
    },
  };
}

/** The download url, built here from a validated id so no caller-supplied url is ever fetched. */
export function driveDownloadUrl(fileId: string): string {
  if (!isValidDriveFileId(fileId)) throw new Error('Invalid Google Drive file id');
  return `${DRIVE_API_BASE}/${fileId}?alt=media&supportsAllDrives=true`;
}

/**
 * Drive hands back thumbnails on googleusercontent.com. Anything else in that
 * field is not fetched, since the server sends the user's token along with it.
 */
export function isGoogleThumbnailUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.googleusercontent.com');
  } catch {
    return false;
  }
}

export function titleFromDriveFileName(name: string): string {
  // An extension starts with a letter, so a version suffix like "v2.1" stays.
  const withoutExtension = name.replace(/\.[A-Za-z][A-Za-z0-9]{0,4}$/, '').trim();
  const title = withoutExtension || name.trim() || 'Untitled video';
  return title.slice(0, 200);
}
