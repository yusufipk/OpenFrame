/**
 * Google Drive images picked on the "Add file" page become image reviews. The
 * image has to be decoded in full to check it and to draw its thumbnail, so it
 * is downloaded into memory, within the 20 MB an image review may be, and then
 * stored exactly as a browser upload is, by lib/image-review-upload.ts.
 */

import type { NextResponse } from 'next/server';
import { ContentError } from '@/lib/content-mutations';
import {
  driveDownloadUrl,
  titleFromDriveFileName,
  type DriveFileMetadata,
} from '@/lib/google-drive';
import { normalizeImageMime } from '@/lib/image-upload-validation';
import {
  IMAGE_REVIEW_MIME_TYPES,
  MAX_IMAGE_REVIEW_BYTES,
  storeImageReview,
} from '@/lib/image-review-upload';

const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;

export type ImportDriveImageReviewInput = {
  projectId: string;
  folderId: string | null;
  userId: string;
  userName: string | null | undefined;
  billedUserId: string;
  accessToken: string;
  file: DriveFileMetadata;
  /**
   * Runs the store step. Several images of one pick may download at once, but
   * each takes the next position in the project in a Serializable transaction,
   * so the caller passes a queue that runs them one at a time.
   */
  runExclusive: <T>(run: () => Promise<T>) => Promise<T>;
};

export type ImportDriveImageReviewResult =
  | { ok: true; videoId: string }
  | { ok: false; error: string; response?: NextResponse };

/** Reads the whole body, or null when it is not exactly `expected` bytes long. */
async function readExactly(response: Response, expected: number): Promise<Buffer | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > expected) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return received === expected ? Buffer.concat(chunks) : null;
}

export async function importDriveImageReview(
  input: ImportDriveImageReviewInput
): Promise<ImportDriveImageReviewResult> {
  const { file } = input;
  if (file.sizeBytes > BigInt(MAX_IMAGE_REVIEW_BYTES)) {
    return { ok: false, error: 'This image is larger than 20 MB' };
  }
  const suppliedMime = normalizeImageMime(file.mimeType);
  if (!IMAGE_REVIEW_MIME_TYPES.has(suppliedMime)) {
    return { ok: false, error: 'Only PNG, JPEG and WebP images can be added for review' };
  }

  try {
    const response = await fetch(driveDownloadUrl(file.id), {
      headers: { Authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, error: `Google Drive refused the download (${response.status})` };
    }
    let bytes: Buffer | null;
    try {
      bytes = await readExactly(response, Number(file.sizeBytes));
    } catch {
      return { ok: false, error: 'Google Drive did not send the image in time. Try again.' };
    }
    if (!bytes) {
      return { ok: false, error: 'The image from Google Drive did not match its reported size' };
    }

    const stored = await input.runExclusive(() =>
      storeImageReview({
        projectId: input.projectId,
        folderId: input.folderId,
        targetVideoId: null,
        userId: input.userId,
        userName: input.userName,
        reservedOwnerId: input.billedUserId,
        bytes,
        suppliedMime,
        title: titleFromDriveFileName(file.name).slice(0, 100).trim() || 'Untitled image',
        description: null,
        versionLabel: null,
      })
    );
    if ('response' in stored) {
      return {
        ok: false,
        error: 'Not enough storage left for this file',
        response: stored.response,
      };
    }
    return { ok: true, videoId: stored.data.videoId };
  } catch (error) {
    if (error instanceof ContentError) return { ok: false, error: error.message };
    throw error;
  }
}
