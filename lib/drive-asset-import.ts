/**
 * Google Drive imports of image and audio attachments. They are small enough
 * (MAX_DRIVE_ATTACHMENT_BYTES) for the server to copy within the request and
 * create the asset straight away, with no import row to poll. The bytes are
 * streamed from Drive to storage, never held in memory whole. Video
 * attachments go through lib/drive-import.ts like any other video.
 */

import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import type { NextResponse } from 'next/server';
import {
  ALLOWED_AUDIO_TYPES,
  AUDIO_MIME_ALIASES,
  AUDIO_MIME_TO_EXT,
  hasValidAudioMagicBytes,
  isHtmlContent,
  SAFE_AUDIO_EXTENSIONS,
} from '@/lib/audio-upload-validation';
import { checkVideoAccess } from '@/lib/content-access';
import { ContentError, contentTransaction } from '@/lib/content-mutations';
import { driveDownloadUrl, type DriveFileMetadata } from '@/lib/google-drive';
import {
  detectImageMime,
  getImageExtension,
  isAllowedImageType,
  normalizeImageMime,
} from '@/lib/image-upload-validation';
import { deleteR2Object, putAttachmentObjectStream } from '@/lib/r2';
import {
  releaseStorageReservation,
  reserveStorageQuota,
  UPLOAD_RESERVATION_PURPOSES,
} from '@/lib/storage-quota';
import { sanitizeAssetDisplayName } from '@/lib/video-assets';

/**
 * Larger than a browser image or audio upload (10 MB), which is buffered in
 * memory by the upload route; this copy is streamed, so it can afford more.
 */
export const MAX_DRIVE_ATTACHMENT_BYTES = 50 * 1024 * 1024;

// Enough to cover a slow 50 MB download.
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;

// What the type checks look at: magic bytes need 16, the HTML sniff 512.
const HEAD_BYTES = 512;

// Drive names an m4a file audio/x-m4a, which the browser upload never sees.
const DRIVE_AUDIO_ALIASES: Record<string, string> = { 'audio/x-m4a': 'audio/mp4' };

export type DriveAttachmentKind = 'IMAGE' | 'AUDIO';

export type ImportDriveAttachmentInput = {
  kind: DriveAttachmentKind;
  videoId: string;
  projectId: string;
  userId: string;
  billedUserId: string;
  accessToken: string;
  file: DriveFileMetadata;
};

export type ImportDriveAttachmentResult =
  | { ok: true; assetId: string }
  | { ok: false; error: string; response?: NextResponse };

function audioContentType(mimeType: string): string | null {
  const stripped = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const canonical = DRIVE_AUDIO_ALIASES[stripped] ?? AUDIO_MIME_ALIASES[stripped] ?? stripped;
  return ALLOWED_AUDIO_TYPES.has(canonical) ? canonical : null;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Splits a download into its first bytes, for the type checks, and a stream of
 * the whole body that refuses to run past `limit` and counts what it passed on.
 */
async function openDownload(body: ReadableStream<Uint8Array>, limit: number) {
  const reader = body.getReader();
  const headChunks: Uint8Array[] = [];
  let headLength = 0;
  let ended = false;
  while (headLength < HEAD_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    headChunks.push(value);
    headLength += value.byteLength;
  }

  const state = { received: 0, sizeMismatch: false, cancelled: false };
  // A failing body stream does not by itself end the storage request in every
  // runtime; aborting it does.
  const abort = new AbortController();
  const mismatch = (message: string) => {
    state.sizeMismatch = true;
    abort.abort();
    return new Error(message);
  };
  async function* chunks() {
    const pass = function* (chunk: Uint8Array) {
      state.received += chunk.byteLength;
      if (state.received > limit) throw mismatch('Download is larger than Drive reported');
      yield chunk;
    };
    try {
      for (const chunk of headChunks) yield* pass(chunk);
      while (!ended) {
        const { done, value } = await reader.read();
        if (done) break;
        yield* pass(value);
      }
      // Ending short would leave storage waiting for the promised length until
      // it times out; fail the stream now instead.
      // A cancel ends the read early on purpose; that is not Drive's doing.
      if (state.received < limit && !state.cancelled) {
        throw mismatch('Download is smaller than Drive reported');
      }
    } catch (error) {
      // Drive timing out or dropping the connection has to end the upload too.
      abort.abort();
      throw error;
    }
  }

  return {
    head: concat(headChunks).slice(0, HEAD_BYTES),
    stream: Readable.from(chunks()),
    state,
    signal: abort.signal,
    cancel: () => {
      state.cancelled = true;
      return reader.cancel().catch(() => undefined);
    },
  };
}

/**
 * Several files of one pick land in the same project at once, and the content
 * transaction is Serializable, so one of two concurrent inserts can be refused
 * with a 409. Nothing was written by the refused attempt; it is safe to rerun.
 */
async function withConflictRetry<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ContentError) || error.status !== 409 || attempt >= attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt + Math.random() * 100));
    }
  }
}

/**
 * Copies one Drive image or audio file into storage and attaches it to the
 * video. The quota is reserved against the size Drive reports before anything
 * is downloaded, and handed over to the asset in the transaction that creates it.
 */
export async function importDriveAttachment(
  input: ImportDriveAttachmentInput
): Promise<ImportDriveAttachmentResult> {
  const { kind, file, billedUserId } = input;
  const label = kind === 'IMAGE' ? 'image' : 'audio file';

  if (file.sizeBytes > BigInt(MAX_DRIVE_ATTACHMENT_BYTES)) {
    return { ok: false, error: `This ${label} is larger than 50 MB` };
  }

  const declaredType =
    kind === 'IMAGE' ? normalizeImageMime(file.mimeType) : audioContentType(file.mimeType);
  if (!declaredType || (kind === 'IMAGE' && !isAllowedImageType(declaredType))) {
    return {
      ok: false,
      error:
        kind === 'IMAGE'
          ? 'Only JPEG, PNG, WebP and GIF images can be attached'
          : 'This audio format cannot be attached',
    };
  }

  const purpose =
    kind === 'IMAGE' ? UPLOAD_RESERVATION_PURPOSES.IMAGE : UPLOAD_RESERVATION_PURPOSES.AUDIO;
  const reserved = await reserveStorageQuota(billedUserId, file.sizeBytes, purpose);
  if ('error' in reserved) {
    return { ok: false, error: 'Not enough storage left for this file', response: reserved.error };
  }
  const reservationId = reserved.reservationId;

  let objectKey: string | null = null;
  try {
    const response = await fetch(driveDownloadUrl(file.id), {
      headers: { Authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new ContentError(400, `Google Drive refused the download (${response.status})`);
    }
    if (!response.body) throw new ContentError(400, `Google Drive sent no ${label}`);
    const expected = Number(file.sizeBytes);
    const download = await openDownload(response.body, expected);
    const { head } = download;

    let contentType: string;
    let extension: string;
    if (kind === 'IMAGE') {
      // The bytes decide, as with a browser upload.
      const detected = detectImageMime(head);
      if (!detected) {
        await download.cancel();
        throw new ContentError(400, 'This file is not a supported image');
      }
      contentType = detected;
      extension = getImageExtension(detected);
      objectKey = `images/${randomUUID()}.${extension}`;
    } else {
      contentType = declaredType;
      if (isHtmlContent(head) || !hasValidAudioMagicBytes(head.slice(0, 16), contentType)) {
        await download.cancel();
        throw new ContentError(400, 'This file does not match its audio format');
      }
      const fromName = (file.name.split('.').pop() ?? '').toLowerCase();
      extension = SAFE_AUDIO_EXTENSIONS.has(fromName)
        ? fromName
        : (AUDIO_MIME_TO_EXT[contentType] ?? 'webm');
      objectKey = `voice/${randomUUID()}.${extension}`;
    }

    // Drive's reported size decided the reservation and is the length storage
    // is told to expect, so a body of any other size fails the copy.
    const sizeMismatch = new ContentError(
      400,
      `The ${label} from Google Drive did not match its reported size`
    );
    // The SDK pipes the body without an error listener of its own; a Drive
    // failure mid-copy would otherwise surface as an uncaught exception. The
    // put still fails, through the abort signal.
    download.stream.on('error', () => undefined);
    try {
      await putAttachmentObjectStream(
        objectKey,
        contentType,
        download.stream,
        expected,
        // The download's own signal fires only while the stream is being
        // read, so a storage endpoint that stops reading needs its own limit.
        AbortSignal.any([download.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
      );
    } catch (error) {
      // Read before cancelling: a storage failure is not Drive's size lying.
      const drivesFault = download.state.sizeMismatch;
      await download.cancel();
      if (drivesFault) throw sizeMismatch;
      throw error;
    }
    if (download.state.received !== expected) {
      await download.cancel();
      throw sizeMismatch;
    }

    const fileName = objectKey.slice(objectKey.indexOf('/') + 1);
    const sourceUrl =
      kind === 'IMAGE' ? `/api/upload/image/${fileName}` : `/api/upload/audio/${fileName}`;

    const asset = await withConflictRetry(() =>
      contentTransaction([input.projectId], async (tx) => {
        // Anyone who may open the video may attach to it, as with a browser upload.
        const access = await checkVideoAccess(input.videoId, input.userId, tx);
        if (!access.hasAccess || access.video?.projectId !== input.projectId) {
          throw new ContentError(403, 'Access changed. Refresh and try again.');
        }
        if (reservationId) {
          await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(
            ('x' || left(md5(${billedUserId}), 16))::bit(64)::bigint
          )
        `;
          const consumed = await tx.uploadReservation.deleteMany({
            where: { id: reservationId, billedUserId, purpose, expiresAt: { gt: new Date() } },
          });
          // The hold was opened moments ago; losing it means the copy stalled
          // long enough for it to expire, and the quota is no longer promised.
          if (consumed.count !== 1) {
            throw new ContentError(400, 'The import took too long. Try again.');
          }
        }
        return tx.videoAsset.create({
          data: {
            videoId: input.videoId,
            kind,
            provider: kind === 'IMAGE' ? 'R2_IMAGE' : 'R2_AUDIO',
            displayName: sanitizeAssetDisplayName(file.name, kind === 'IMAGE' ? 'Image' : 'Audio'),
            sourceUrl,
            thumbnailUrl: kind === 'IMAGE' ? sourceUrl : null,
            sizeBytes: BigInt(download.state.received),
            uploadedByUserId: input.userId,
            billedUserId,
          },
          select: { id: true },
        });
      })
    );
    return { ok: true, assetId: asset.id };
  } catch (error) {
    await releaseStorageReservation(reservationId, billedUserId, purpose);
    if (objectKey) await deleteR2Object(objectKey).catch(() => undefined);
    if (error instanceof ContentError) return { ok: false, error: error.message };
    throw error;
  }
}
