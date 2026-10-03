/**
 * Google Drive imports: a picked Drive file becomes a video, a new version of
 * one, or a video attachment (asset), without the user downloading and
 * re-uploading it. Image and audio attachments are small enough to copy in one
 * request and live in lib/drive-asset-import.ts instead.
 *
 * Two backends, following the host's direct upload backend:
 *
 * - BUNNY: Bunny Stream fetches the file straight from the Drive API with the
 *   user's short-lived `drive.file` token in an Authorization header. No bytes
 *   pass through this server. Bunny reports nothing when a fetch fails, so the
 *   outcome is read back from the video's status (see `reconcileDriveImports`).
 * - S3: this server streams the file from Drive into a multipart upload. That
 *   is the only way onto a self-hosted bucket, and it runs in the background of
 *   the Node process, bounded by `S3_COPY_CONCURRENCY`.
 *
 * Either way the video, version or asset row is written only once the bytes have
 * landed, by `finalizeDriveImport`, so an import that fails leaves nothing in
 * the project. The quota is reserved against the size Drive reports before any
 * byte moves. See docs/google-drive-import.md.
 */

import { randomUUID } from 'crypto';
import type { DriveImport, DriveImportBackend, DriveImportStatus } from '@prisma/client';
import type { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { runWithConcurrency } from '@/lib/async-pool';
import { canonicalBunnyThumbnailUrl } from '@/lib/bunny-cdn-token';
import { cleanupBunnyStreamVideosBestEffort } from '@/lib/bunny-stream-cleanup';
import { checkFolderAccess, checkVideoAccess } from '@/lib/content-access';
import { ContentError, contentTransaction } from '@/lib/content-mutations';
import { eventKey, recordAccountActivity, recordEvent } from '@/lib/analytics/record';
import { getR2MultipartPartSizeBytes } from '@/lib/feature-flags';
import { driveDownloadUrl, isGoogleThumbnailUrl, type DriveFileMetadata } from '@/lib/google-drive';
import { logError } from '@/lib/logger';
import { notifyProjectOwner } from '@/lib/notifications';
import {
  abortMultipartVideoUpload,
  completeMultipartVideoUpload,
  createMultipartVideoUpload,
  deleteR2Object,
  deleteVideoObject,
  putImageObject,
  uploadVideoPart,
} from '@/lib/r2';
import { hasKnownVideoMagicBytes } from '@/lib/r2-video-finalize';
import {
  getMaxVideoUploadBytesForUser,
  releaseStorageReservation,
  reserveStorageQuota,
  UPLOAD_RESERVATION_PURPOSES,
} from '@/lib/storage-quota';
import { parseDeclaredUploadSize } from '@/lib/upload-size';
import { sanitizeAssetDisplayName } from '@/lib/video-assets';
import {
  buildVideoObjectKey,
  getVideoExtensionFromFileName,
  getVideoExtensionFromMime,
  getVideoMimeFromExtension,
  normalizeVideoMime,
  objectKeyToVideoProxyPath,
} from '@/lib/video-upload-validation';

export const DRIVE_IMPORT_MAX_FILES = 10;

// An import that has not become a video this long after it started never will:
// it is failed and its media deleted instead of finalized. Finalizing happens
// when the uploader polls, and without a limit an import nobody polled could
// be attached days later, long after its quota hold ran out.
export const DRIVE_IMPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Outlives DRIVE_IMPORT_MAX_AGE_MS, so the bytes count against the account for
// as long as the import can still turn into a video that counts them itself.
const DRIVE_IMPORT_RESERVATION_TTL_MS = DRIVE_IMPORT_MAX_AGE_MS + 60 * 60 * 1000;

// The Google token Bunny holds lives for an hour. A fetch that has not produced
// a video well after that is not going to: either Drive refused it, or Bunny's
// queue held it past the token's life. The margin covers a large file that did
// start in time and is still downloading.
export const BUNNY_FETCH_DEADLINE_MS = 2 * 60 * 60 * 1000;

// A Bunny fetch that never produced a video id, e.g. the process died between
// creating the row and hearing back from Bunny.
const BUNNY_START_DEADLINE_MS = 5 * 60 * 1000;

// The S3 copier refreshes its heartbeat every HEARTBEAT_INTERVAL_MS. Missing
// several in a row means the process that ran it is gone.
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
export const S3_COPY_STALE_MS = 3 * 60 * 1000;

// Drive stopped sending bytes. The heartbeat would otherwise keep a hung
// download looking alive forever.
const S3_COPY_STALL_MS = 2 * 60 * 1000;

// A finalize that crashed mid-way rolled its transaction back, so the row can
// safely go back to TRANSFERRING and be finalized again.
const FINALIZING_STALE_MS = 5 * 60 * 1000;

// Bunny's management API is shared by every user of the host; one status
// lookup per import per this interval is enough, however many tabs poll.
const BUNNY_STATUS_CHECK_INTERVAL_MS = 10 * 1000;

// A single storage request that takes longer than this is treated as hung.
const S3_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

const S3_COPY_CONCURRENCY = 2;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const BUNNY_API_BASE = 'https://video.bunnycdn.com';
const BUNNY_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

// Bunny Stream video status codes, as the management API reports them.
const BUNNY_STATUS_CREATED = 0;
const BUNNY_STATUS_ERROR = 5;
const BUNNY_STATUS_UPLOAD_FAILED = 6;

const ACTIVE_STATUSES: DriveImportStatus[] = ['TRANSFERRING', 'FINALIZING'];
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type DriveImportView = {
  id: string;
  driveFileId: string;
  fileName: string;
  title: string;
  status: DriveImportStatus;
  error: string | null;
  folderId: string | null;
  targetVideoId: string | null;
  assetVideoId: string | null;
  createdVideoId: string | null;
  createdAt: string;
};

export function toDriveImportView(row: DriveImport): DriveImportView {
  return {
    id: row.id,
    driveFileId: row.driveFileId,
    fileName: row.fileName,
    title: row.title,
    status: row.status,
    error: row.error,
    folderId: row.folderId,
    targetVideoId: row.targetVideoId,
    assetVideoId: row.assetVideoId,
    createdVideoId: row.createdVideoId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A failure the user can act on. Anything else is logged and shown generically. */
class DriveImportError extends Error {}

function getBunnyConfig(): { apiKey: string; libraryId: string } | null {
  const apiKey = process.env.BUNNY_STREAM_API_KEY;
  const libraryId =
    process.env.BUNNY_STREAM_LIBRARY_ID || process.env.NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID;
  return apiKey && libraryId ? { apiKey, libraryId } : null;
}

/**
 * The content type an S3 import is stored under, or null when the format is not
 * one this host serves. Drive's MIME type decides, since Drive names need not
 * carry an extension; the name is the fallback.
 */
export function s3ImportContentType(
  mimeType: string,
  fileName: string
): { contentType: string; extension: string } | null {
  const normalized = normalizeVideoMime(mimeType);
  const fromMime = normalized ? getVideoExtensionFromMime(normalized) : null;
  if (normalized && fromMime) return { contentType: normalized, extension: fromMime };

  const fromName = getVideoExtensionFromFileName(fileName);
  const contentType = fromName ? getVideoMimeFromExtension(fromName) : null;
  return fromName && contentType ? { contentType, extension: fromName } : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export type StartDriveImportInput = {
  userId: string;
  projectId: string;
  folderId: string | null;
  targetVideoId: string | null;
  /** Set to attach the file to this video as an asset; folderId and targetVideoId are then null. */
  assetVideoId: string | null;
  billedUserId: string;
  backend: DriveImportBackend;
  accessToken: string;
  file: DriveFileMetadata;
  title: string;
};

export type StartDriveImportResult =
  | { ok: true; view: DriveImportView }
  | { ok: false; error: string; response?: NextResponse };

export async function startDriveImport(
  input: StartDriveImportInput
): Promise<StartDriveImportResult> {
  const { file, backend, billedUserId } = input;

  const declared = parseDeclaredUploadSize(
    file.sizeBytes.toString(),
    await getMaxVideoUploadBytesForUser(billedUserId)
  );
  if ('error' in declared) return { ok: false, error: declared.error };

  if (backend === 'S3' && !s3ImportContentType(file.mimeType, file.name)) {
    return { ok: false, error: 'This video format cannot be stored on this server' };
  }
  if (backend === 'BUNNY' && !getBunnyConfig()) {
    return { ok: false, error: 'Video storage is not configured on this server' };
  }

  const reserved = await reserveStorageQuota(
    billedUserId,
    declared.sizeBytes,
    UPLOAD_RESERVATION_PURPOSES.DRIVE_IMPORT,
    DRIVE_IMPORT_RESERVATION_TTL_MS
  );
  if ('error' in reserved) {
    return { ok: false, error: 'Not enough storage left for this file', response: reserved.error };
  }

  let row: DriveImport;
  try {
    row = await db.driveImport.create({
      data: {
        userId: input.userId,
        projectId: input.projectId,
        folderId: input.folderId,
        targetVideoId: input.targetVideoId,
        assetVideoId: input.assetVideoId,
        driveFileId: file.id,
        fileName: file.name,
        title: input.title,
        mimeType: file.mimeType,
        sizeBytes: declared.sizeBytes,
        billedUserId,
        reservationId: reserved.reservationId,
        backend,
      },
    });
  } catch (error) {
    await releaseStorageReservation(
      reserved.reservationId,
      billedUserId,
      UPLOAD_RESERVATION_PURPOSES.DRIVE_IMPORT
    );
    throw error;
  }

  if (backend === 'S3') {
    scheduleS3DriveCopy(row.id, input.accessToken, file.thumbnailLink);
    return { ok: true, view: toDriveImportView(row) };
  }

  try {
    const bunnyVideoId = await requestBunnyFetch(row, input.accessToken);
    const updated = await db.driveImport.update({
      where: { id: row.id },
      data: { bunnyVideoId },
    });
    return { ok: true, view: toDriveImportView(updated) };
  } catch (error) {
    logError('Failed to start Bunny fetch for Drive import:', error);
    // Bunny may have taken the fetch even though we never heard back (a
    // timeout, a lost response). Its video then has to be found and recorded
    // here, or failing the row could not delete it and Bunny would download
    // the file into a video nobody tracks.
    const config = getBunnyConfig();
    let orphan: string | null = null;
    // Bunny's search can lag a moment behind a video it just created.
    for (let attempt = 0; config && !orphan && attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(2000);
      orphan = await findBunnyVideoByMarker(config, bunnyMarker(row.id)).catch(() => null);
    }
    if (orphan) {
      await db.driveImport
        .update({ where: { id: row.id }, data: { bunnyVideoId: orphan } })
        .catch(() => undefined);
    }
    const message = 'Video storage could not start the import. Try again in a few minutes.';
    await failDriveImport(row.id, message);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Bunny
// ---------------------------------------------------------------------------

function bunnyMarker(importId: string): string {
  return `openframe-drive-import:${importId}`;
}

function readBunnyGuid(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  for (const key of ['id', 'guid', 'videoId']) {
    const value = record[key];
    if (typeof value === 'string' && BUNNY_VIDEO_ID_PATTERN.test(value)) return value;
  }
  return null;
}

/**
 * Asks Bunny to pull the file from Drive and returns the Bunny video id.
 *
 * Bunny's published schema for this endpoint answers only success and a status
 * code, while the live API has been seen to include the new video's `id`. Both
 * are handled: the id is read when present, and otherwise the video is found by
 * the marker this call puts in its title.
 */
async function requestBunnyFetch(row: DriveImport, accessToken: string): Promise<string> {
  const config = getBunnyConfig();
  if (!config) throw new Error('Bunny Stream is not configured');

  const marker = bunnyMarker(row.id);
  const body = JSON.stringify({
    url: driveDownloadUrl(row.driveFileId),
    title: `${row.title} [${marker}]`,
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${BUNNY_API_BASE}/library/${config.libraryId}/videos/fetch`, {
      method: 'POST',
      headers: {
        AccessKey: config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });

    // Bunny caps queued fetches per account and says so with a 429.
    if (response.status === 429 && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!response.ok) {
      throw new Error(`Bunny fetch failed (${response.status}): ${await response.text()}`);
    }

    const guid = readBunnyGuid(await response.json().catch(() => null));
    if (guid) return guid;
    break;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const found = await findBunnyVideoByMarker(config, marker);
    if (found) return found;
    await sleep(1500);
  }
  throw new Error('Bunny accepted the fetch but the new video could not be found');
}

async function findBunnyVideoByMarker(
  config: { apiKey: string; libraryId: string },
  marker: string
): Promise<string | null> {
  const url = new URL(`${BUNNY_API_BASE}/library/${config.libraryId}/videos`);
  url.searchParams.set('search', marker);
  url.searchParams.set('itemsPerPage', '10');
  const response = await fetch(url, {
    headers: { AccessKey: config.apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as {
    items?: Array<{ guid?: unknown; title?: unknown }>;
  } | null;
  const match = body?.items?.find(
    (item) => typeof item.title === 'string' && item.title.includes(marker)
  );
  return typeof match?.guid === 'string' && BUNNY_VIDEO_ID_PATTERN.test(match.guid)
    ? match.guid
    : null;
}

async function getBunnyVideoStatus(bunnyVideoId: string): Promise<number | 'missing'> {
  const config = getBunnyConfig();
  if (!config) throw new Error('Bunny Stream is not configured');
  const response = await fetch(
    `${BUNNY_API_BASE}/library/${config.libraryId}/videos/${encodeURIComponent(bunnyVideoId)}`,
    {
      headers: { AccessKey: config.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (response.status === 404) return 'missing';
  if (!response.ok) throw new Error(`Bunny video lookup failed (${response.status})`);
  const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
  const status = Number(body?.status);
  if (!Number.isInteger(status)) throw new Error('Bunny video lookup returned no status');
  return status;
}

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

let activeS3Copies = 0;
const s3CopyWaiters: Array<() => void> = [];

async function acquireS3CopySlot(): Promise<void> {
  if (activeS3Copies < S3_COPY_CONCURRENCY) {
    activeS3Copies += 1;
    return;
  }
  await new Promise<void>((resolve) => s3CopyWaiters.push(resolve));
}

function releaseS3CopySlot(): void {
  const next = s3CopyWaiters.shift();
  if (next) next();
  else activeS3Copies -= 1;
}

export function scheduleS3DriveCopy(
  importId: string,
  accessToken: string,
  thumbnailLink: string | null
): void {
  void copyDriveFileToS3(importId, accessToken, thumbnailLink).catch((error) =>
    logError('Drive import copy crashed:', error)
  );
}

/**
 * Takes the first `size` bytes out of a list of chunks, leaving the rest.
 * R2 requires every part but the last to be exactly the same size, so parts are
 * cut at the part size rather than wherever a network read happened to end.
 */
function takeBytes(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const head = chunks[0];
    if (!head) break;
    const needed = size - offset;
    if (head.byteLength <= needed) {
      out.set(head, offset);
      offset += head.byteLength;
      chunks.shift();
    } else {
      out.set(head.subarray(0, needed), offset);
      offset += needed;
      chunks[0] = head.subarray(needed);
    }
  }
  return offset === size ? out : out.subarray(0, offset);
}

/**
 * Streams one Drive file into a multipart upload on our own storage, then hands
 * the row to `finalizeDriveImport`. Exported for tests; the route schedules it
 * without waiting.
 */
export async function copyDriveFileToS3(
  importId: string,
  accessToken: string,
  thumbnailLink: string | null
): Promise<void> {
  const controller = new AbortController();
  // Only time spent waiting on Drive counts as a stall. A slow part upload to
  // our own storage is not Drive's fault and has its own timeout.
  let waitingOnDriveSince: number | null = null;

  // Runs while the copy waits for a slot too, so a queued copy is not mistaken
  // for a dead one. It also notices when the row was failed from elsewhere (the
  // reconciler decided this copy was lost) and stops the download.
  const heartbeat = setInterval(() => {
    void (async () => {
      if (waitingOnDriveSince !== null && Date.now() - waitingOnDriveSince > S3_COPY_STALL_MS) {
        controller.abort(new DriveImportError('Google Drive stopped sending the file'));
        return;
      }
      const alive = await db.driveImport.updateMany({
        where: { id: importId, status: 'TRANSFERRING' },
        data: { heartbeatAt: new Date() },
      });
      if (alive.count === 0) controller.abort(new DriveImportError('The import was cancelled'));
    })().catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  await acquireS3CopySlot();

  const storageSignal = () =>
    AbortSignal.any([controller.signal, AbortSignal.timeout(S3_REQUEST_TIMEOUT_MS)]);

  let objectKey: string | null = null;
  let uploadId: string | null = null;
  let completed = false;
  let thumbnailObjectKey: string | null = null;
  // Once the row records the finished object, the object belongs to the row:
  // a later failure must leave it for finalize to retry rather than delete it.
  let handedOver = false;

  try {
    const row = await db.driveImport.findUnique({ where: { id: importId } });
    if (!row || row.status !== 'TRANSFERRING' || row.backend !== 'S3') return;

    const format = s3ImportContentType(row.mimeType, row.fileName);
    if (!format) throw new DriveImportError('This video format cannot be stored on this server');

    // Before the video, while the token is certainly still valid: a queued or
    // long copy can outlive it.
    thumbnailObjectKey = await copyDriveThumbnail(thumbnailLink, accessToken, storageSignal());

    waitingOnDriveSince = Date.now();
    const response = await fetch(driveDownloadUrl(row.driveFileId), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    waitingOnDriveSince = null;
    if (response.status === 401) {
      throw new DriveImportError(
        'Google Drive access expired before the copy could start. Pick the file again.'
      );
    }
    if (!response.ok || !response.body) {
      throw new DriveImportError(`Google Drive refused the download (${response.status})`);
    }

    objectKey = buildVideoObjectKey(`${randomUUID()}.${format.extension}`);
    uploadId = await createMultipartVideoUpload(objectKey, format.contentType, storageSignal());
    await db.driveImport.update({
      where: { id: importId },
      data: { objectKey, multipartUploadId: uploadId, thumbnailObjectKey },
    });

    const partSize = Number(getR2MultipartPartSizeBytes());
    const reader = response.body.getReader();
    const pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let received = BigInt(0);
    let partNumber = 1;
    const parts: Array<{ partNumber: number; etag: string }> = [];

    const uploadPart = async (bytes: Uint8Array) => {
      if (partNumber === 1 && !hasKnownVideoMagicBytes(bytes.subarray(0, 64))) {
        throw new DriveImportError('The file on Google Drive is not a video this server can play');
      }
      const etag = await uploadVideoPart(objectKey!, uploadId!, partNumber, bytes, storageSignal());
      parts.push({ partNumber, etag });
      partNumber += 1;
    };

    while (true) {
      waitingOnDriveSince = Date.now();
      const { done, value } = await reader.read();
      waitingOnDriveSince = null;
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      received += BigInt(value.byteLength);
      // The reservation was taken against Drive's figure. A file that grows
      // under us would otherwise land bytes nobody paid for.
      if (received > row.sizeBytes) {
        throw new DriveImportError('The file on Google Drive is larger than Drive reported');
      }
      pending.push(value);
      pendingBytes += value.byteLength;
      while (pendingBytes >= partSize) {
        await uploadPart(takeBytes(pending, partSize));
        pendingBytes -= partSize;
      }
    }

    if (received !== row.sizeBytes) {
      throw new DriveImportError('The download from Google Drive ended early');
    }
    if (pendingBytes > 0) await uploadPart(takeBytes(pending, pendingBytes));

    await completeMultipartVideoUpload(objectKey, uploadId, parts, storageSignal());
    completed = true;

    const marked = await db.driveImport.updateMany({
      where: { id: importId, status: 'TRANSFERRING' },
      data: { transferredAt: new Date(), multipartUploadId: null, sizeBytes: received },
    });
    if (marked.count !== 1) {
      // Failed from elsewhere while the last bytes were landing. That path
      // cleaned up what it knew about, which did not include the finished object.
      await deleteVideoObject(objectKey).catch(() => undefined);
      if (thumbnailObjectKey) await deleteR2Object(thumbnailObjectKey).catch(() => undefined);
      return;
    }
    handedOver = true;

    await finalizeDriveImport(importId);
  } catch (error) {
    if (handedOver) {
      // The object is complete and recorded; the next reconcile finalizes it.
      logError('Drive import finalize failed after the copy:', error);
      return;
    }
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    const message =
      reason instanceof DriveImportError
        ? reason.message
        : 'The copy from Google Drive failed. Pick the file again.';
    if (!(reason instanceof DriveImportError)) logError('Drive import copy failed:', error);

    if (objectKey && uploadId && !completed) {
      await abortMultipartVideoUpload(objectKey, uploadId).catch(() => undefined);
    }
    if (objectKey && completed) await deleteVideoObject(objectKey).catch(() => undefined);
    if (thumbnailObjectKey) await deleteR2Object(thumbnailObjectKey).catch(() => undefined);
    await failDriveImport(importId, message);
  } finally {
    clearInterval(heartbeat);
    releaseS3CopySlot();
  }
}

const THUMBNAIL_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Best effort: a video without a thumbnail still plays, it just shows the placeholder. */
async function copyDriveThumbnail(
  thumbnailLink: string | null,
  accessToken: string,
  abortSignal: AbortSignal
): Promise<string | null> {
  if (!thumbnailLink || !isGoogleThumbnailUrl(thumbnailLink)) return null;
  try {
    const response = await fetch(thumbnailLink, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    const extension = THUMBNAIL_EXTENSIONS[contentType];
    if (!extension) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_BYTES) return null;
    const key = `images/${randomUUID()}.${extension}`;
    await putImageObject(key, contentType, bytes, abortSignal);
    return key;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Finalize and fail
// ---------------------------------------------------------------------------

type FinalizedImport = {
  videoId: string;
  versionId: string | null;
  versionNumber?: number;
  assetId: string | null;
};

const PLACEHOLDER_THUMBNAIL = '/placeholder-video-thumbnail.png';

function mediaForImport(row: DriveImport): {
  providerId: string;
  videoId: string;
  originalUrl: string;
  thumbnailUrl: string | null;
} {
  if (row.backend === 'BUNNY') {
    const config = getBunnyConfig();
    if (!config || !row.bunnyVideoId) throw new Error('Bunny import has no video to attach');
    return {
      providerId: 'bunny',
      videoId: row.bunnyVideoId,
      originalUrl: `https://iframe.mediadelivery.net/embed/${config.libraryId}/${row.bunnyVideoId}`,
      thumbnailUrl: canonicalBunnyThumbnailUrl(row.bunnyVideoId),
    };
  }

  const proxyPath = row.objectKey ? objectKeyToVideoProxyPath(row.objectKey) : null;
  if (!row.objectKey || !proxyPath) throw new Error('S3 import has no object to attach');
  return {
    providerId: 'r2',
    videoId: row.objectKey,
    originalUrl: proxyPath,
    thumbnailUrl: row.thumbnailObjectKey
      ? `/api/upload/image/${row.thumbnailObjectKey.slice('images/'.length)}`
      : PLACEHOLDER_THUMBNAIL,
  };
}

/**
 * Writes the video (or version) for an import whose bytes have landed, and
 * hands the quota reservation over to it in the same transaction, so the bytes
 * are never counted twice or not at all.
 *
 * Exactly one caller wins the TRANSFERRING to FINALIZING claim, so two pollers
 * reconciling the same row cannot create two videos.
 */
export async function finalizeDriveImport(importId: string): Promise<void> {
  const claimed = await db.driveImport.updateMany({
    where: { id: importId, status: 'TRANSFERRING' },
    data: { status: 'FINALIZING' },
  });
  if (claimed.count !== 1) return;

  let row: DriveImport | null = null;
  let created: FinalizedImport;
  try {
    row = await db.driveImport.findUniqueOrThrow({ where: { id: importId } });
    const current = row;
    if (Date.now() - current.createdAt.getTime() > DRIVE_IMPORT_MAX_AGE_MS) {
      throw new ContentError(410, 'This import took too long to finish. Pick the file again.');
    }
    const media = mediaForImport(current);
    created = await contentTransaction([current.projectId], async (tx) => {
      let result: FinalizedImport;

      if (current.assetVideoId) {
        // Anyone who may open the video may attach to it, as with a browser upload.
        const access = await checkVideoAccess(current.assetVideoId, current.userId, tx);
        if (!access.hasAccess || access.video?.projectId !== current.projectId) {
          throw new ContentError(403, 'You no longer have access to the video this was going to');
        }
        const asset = await tx.videoAsset.create({
          data: {
            videoId: current.assetVideoId,
            kind: 'VIDEO',
            provider: current.backend === 'BUNNY' ? 'BUNNY' : 'R2_VIDEO',
            displayName: sanitizeAssetDisplayName(current.fileName, 'Video'),
            sourceUrl: media.originalUrl,
            providerVideoId: current.backend === 'BUNNY' ? media.videoId : null,
            // An attachment without a thumbnail shows the pane's own icon, which
            // reads better than the video placeholder image.
            thumbnailUrl: media.thumbnailUrl === PLACEHOLDER_THUMBNAIL ? null : media.thumbnailUrl,
            sizeBytes: current.sizeBytes,
            uploadedByUserId: current.userId,
            billedUserId: current.billedUserId,
          },
          select: { id: true },
        });
        result = { videoId: current.assetVideoId, versionId: null, assetId: asset.id };
      } else if (current.targetVideoId) {
        const access = await checkVideoAccess(current.targetVideoId, current.userId, tx);
        if (!access.canEdit || access.video?.projectId !== current.projectId) {
          throw new ContentError(403, 'You no longer have access to the video this was going to');
        }
        if (access.video.mediaType !== 'VIDEO') {
          throw new ContentError(403, 'A video cannot become a version of an image review');
        }
        const latest = await tx.videoVersion.findFirst({
          where: { videoParentId: current.targetVideoId },
          orderBy: { versionNumber: 'desc' },
          select: { versionNumber: true },
        });
        const versionNumber = (latest?.versionNumber ?? 0) + 1;
        await tx.videoVersion.updateMany({
          where: { videoParentId: current.targetVideoId },
          data: { isActive: false },
        });
        const version = await tx.videoVersion.create({
          data: {
            versionNumber,
            providerId: media.providerId,
            videoId: media.videoId,
            originalUrl: media.originalUrl,
            title: `Version ${versionNumber}`,
            thumbnailUrl: media.thumbnailUrl,
            sizeBytes: current.sizeBytes,
            isActive: true,
            videoParentId: current.targetVideoId,
            uploadedById: current.userId,
          },
          select: { id: true },
        });
        result = {
          videoId: current.targetVideoId,
          versionId: version.id,
          versionNumber,
          assetId: null,
        };
      } else {
        const access = await checkFolderAccess(
          current.projectId,
          current.folderId,
          current.userId,
          tx
        );
        if (!access?.canEdit) {
          throw new ContentError(403, 'You no longer have access to the folder this was going to');
        }
        const last = await tx.video.findFirst({
          where: { projectId: current.projectId },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        const video = await tx.video.create({
          data: {
            title: current.title,
            position: (last?.position ?? -1) + 1,
            folderId: current.folderId,
            projectId: current.projectId,
            versions: {
              create: {
                versionNumber: 1,
                providerId: media.providerId,
                videoId: media.videoId,
                originalUrl: media.originalUrl,
                title: current.title,
                thumbnailUrl: media.thumbnailUrl,
                sizeBytes: current.sizeBytes,
                isActive: true,
                uploadedById: current.userId,
              },
            },
          },
          select: { id: true, versions: { select: { id: true } } },
        });
        result = {
          videoId: video.id,
          versionId: video.versions[0]!.id,
          versionNumber: 1,
          assetId: null,
        };
      }

      if (current.reservationId) {
        await tx.uploadReservation.deleteMany({
          where: {
            id: current.reservationId,
            billedUserId: current.billedUserId,
            purpose: UPLOAD_RESERVATION_PURPOSES.DRIVE_IMPORT,
          },
        });
      }

      await tx.driveImport.update({
        where: { id: current.id },
        data: {
          status: 'DONE',
          error: null,
          createdVideoId: result.videoId,
          createdVersionId: result.versionId,
          createdAssetId: result.assetId,
        },
      });

      return result;
    });
  } catch (error) {
    if (error instanceof ContentError && (error.status === 403 || error.status === 410)) {
      await failDriveImport(importId, error.message, ['FINALIZING']);
      return;
    }
    // Anything else is transient as far as we know (a serialization conflict, a
    // dropped connection). Hand the row back so the next reconcile retries.
    await db.driveImport
      .updateMany({
        where: { id: importId, status: 'FINALIZING' },
        data: { status: 'TRANSFERRING' },
      })
      .catch(() => undefined);
    logError('Failed to finalize Drive import:', error);
    return;
  }
  if (!row) return;

  // Not awaited, like the upload routes: a slow mail server must not hold up the
  // poll or the copy slot that finalized this import.
  void announceImport(row, created).catch((error) =>
    logError('Drive import notification failed:', error)
  );
}

async function announceImport(row: DriveImport, created: FinalizedImport): Promise<void> {
  // A browser upload of an attachment announces nothing either.
  if (!created.versionId) return;
  const [project, actor, video] = await Promise.all([
    db.project.findUnique({ where: { id: row.projectId }, select: { ownerId: true, name: true } }),
    db.user.findUnique({ where: { id: row.userId }, select: { name: true } }),
    db.video.findUnique({ where: { id: created.videoId }, select: { title: true } }),
  ]);
  if (!project || !video) return;

  if (!row.targetVideoId) {
    await recordEvent({
      name: 'VIDEO_ADDED',
      dedupeKey: eventKey('VIDEO_ADDED', created.videoId),
      userId: project.ownerId,
      actorId: row.userId,
    });
  } else {
    await recordAccountActivity({
      name: 'VERSION_ADDED',
      accountId: row.billedUserId,
      actorId: row.userId,
    });
  }

  if (project.ownerId === row.userId) return;
  const url = `${process.env.NEXTAUTH_URL || ''}/watch/${created.videoId}`;
  const addedBy = actor?.name || 'A team member';
  await notifyProjectOwner(
    project.ownerId,
    row.targetVideoId
      ? {
          type: 'new_version',
          projectName: project.name,
          videoTitle: video.title,
          versionLabel: `Version ${created.versionNumber ?? 1}`,
          addedBy,
          url,
        }
      : { type: 'new_video', projectName: project.name, videoTitle: video.title, addedBy, url }
  );
}

/**
 * Marks an import failed and gives back what it held: the quota reservation,
 * and whatever media it had already put in storage. Only the caller that moves
 * the row out of `from` does the cleanup, so a row is never cleaned twice.
 */
export async function failDriveImport(
  importId: string,
  message: string,
  from: DriveImportStatus[] = ['TRANSFERRING']
): Promise<void> {
  // The state change and the quota release commit together, so a failed row
  // never keeps holding quota nothing will release.
  const row = await db.$transaction(async (tx) => {
    const failed = await tx.driveImport.updateMany({
      where: { id: importId, status: { in: from } },
      data: { status: 'FAILED', error: message },
    });
    if (failed.count !== 1) return null;
    const current = await tx.driveImport.findUnique({ where: { id: importId } });
    if (current?.reservationId) {
      await tx.uploadReservation.deleteMany({
        where: {
          id: current.reservationId,
          billedUserId: current.billedUserId,
          purpose: UPLOAD_RESERVATION_PURPOSES.DRIVE_IMPORT,
        },
      });
    }
    return current;
  });
  if (!row) return;

  if (row.backend === 'BUNNY' && row.bunnyVideoId) {
    await cleanupBunnyStreamVideosBestEffort(
      [{ providerId: 'bunny', videoId: row.bunnyVideoId }],
      AbortSignal.timeout(10_000)
    ).catch(() => undefined);
  }
  if (row.backend === 'S3' && row.objectKey) {
    if (row.multipartUploadId) {
      await abortMultipartVideoUpload(row.objectKey, row.multipartUploadId).catch(() => undefined);
    }
    if (row.transferredAt) await deleteVideoObject(row.objectKey).catch(() => undefined);
  }
  if (row.thumbnailObjectKey) await deleteR2Object(row.thumbnailObjectKey).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * The uploader's imports for one project: everything still in flight, plus
 * whatever finished or failed in the last day so the outcome can be shown.
 */
export async function listDriveImports(projectId: string, userId: string): Promise<DriveImport[]> {
  // Two queries, so a burst of finished imports can never push an active one
  // out of the window and leave it unreconciled.
  const [active, recent] = await Promise.all([
    db.driveImport.findMany({
      where: { projectId, userId, status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    db.driveImport.findMany({
      where: {
        projectId,
        userId,
        status: { notIn: ACTIVE_STATUSES },
        updatedAt: { gte: new Date(Date.now() - RECENT_WINDOW_MS) },
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    }),
  ]);
  return [...active, ...recent];
}

const lastBunnyCheck = new Map<string, number>();

/** Whether this process looked at the import's Bunny status too recently to look again. */
function bunnyCheckedRecently(importId: string, now: number): boolean {
  const last = lastBunnyCheck.get(importId);
  if (last !== undefined && now - last < BUNNY_STATUS_CHECK_INTERVAL_MS) return true;
  lastBunnyCheck.set(importId, now);
  if (lastBunnyCheck.size > 10_000) {
    for (const [id, at] of lastBunnyCheck) {
      if (now - at >= BUNNY_STATUS_CHECK_INTERVAL_MS) lastBunnyCheck.delete(id);
    }
  }
  return false;
}

/**
 * Moves in-flight imports forward. There is no job queue in this app, so this
 * runs whenever the uploader's browser polls for its imports.
 */
export async function reconcileDriveImports(rows: DriveImport[], now = Date.now()): Promise<void> {
  const active = rows.filter((row) => ACTIVE_STATUSES.includes(row.status));
  await runWithConcurrency(active, 4, async (row) => {
    try {
      await reconcileDriveImport(row, now);
    } catch (error) {
      logError('Failed to reconcile Drive import:', error);
    }
  });
}

async function reconcileDriveImport(row: DriveImport, now: number): Promise<void> {
  if (row.status === 'FINALIZING') {
    if (now - row.updatedAt.getTime() > FINALIZING_STALE_MS) {
      await db.driveImport.updateMany({
        where: { id: row.id, status: 'FINALIZING', updatedAt: row.updatedAt },
        data: { status: 'TRANSFERRING' },
      });
    }
    return;
  }

  if (now - row.createdAt.getTime() > DRIVE_IMPORT_MAX_AGE_MS) {
    await failDriveImport(row.id, 'This import took too long to finish. Pick the file again.');
    return;
  }

  if (row.backend === 'S3') {
    if (row.transferredAt) {
      await finalizeDriveImport(row.id);
    } else if (now - row.heartbeatAt.getTime() > S3_COPY_STALE_MS) {
      await failDriveImport(
        row.id,
        'The copy from Google Drive stopped before it finished. Pick the file again.'
      );
    }
    return;
  }

  if (!row.bunnyVideoId) {
    if (now - row.createdAt.getTime() > BUNNY_START_DEADLINE_MS) {
      await failDriveImport(row.id, 'Video storage never started the import. Pick the file again.');
    }
    return;
  }

  if (bunnyCheckedRecently(row.id, now)) return;
  const status = await getBunnyVideoStatus(row.bunnyVideoId);
  if (status === 'missing') {
    await failDriveImport(row.id, 'The imported video is no longer in video storage.');
  } else if (status === BUNNY_STATUS_ERROR || status === BUNNY_STATUS_UPLOAD_FAILED) {
    await failDriveImport(row.id, 'Video storage could not process this file.');
  } else if (status !== BUNNY_STATUS_CREATED) {
    await finalizeDriveImport(row.id);
  } else if (now - row.createdAt.getTime() > BUNNY_FETCH_DEADLINE_MS) {
    await failDriveImport(
      row.id,
      'Google Drive did not hand the file over in time. Pick it again.'
    );
  }
}
