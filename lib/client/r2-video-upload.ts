import { captureVideoThumbnail } from '@/lib/client/video-thumbnail';
import { apiRequestError } from '@/lib/client/api-error';
import {
  getMultipartProgressPercent,
  getPartByteRange,
  getRetryDelayMs,
  getUploadProgressPercent,
  isRetryableUploadError,
  PART_RETRY_DELAYS_MS,
} from '@/lib/client/upload-chunking';

export type R2MultipartPart = { partNumber: number; url: string };

export type R2MultipartInit = {
  uploadId: string;
  partSizeBytes: number;
  parts: R2MultipartPart[];
};

export type R2VideoInitResponse = {
  presignedPutUrl: string;
  objectKey: string;
  proxyUrl: string;
  uploadToken: string;
  reservationId: string | null;
  contentType: string;
  thumbnailPresignedPutUrl: string;
  thumbnailObjectKey: string;
  thumbnailProxyUrl: string;
  multipart: R2MultipartInit | null;
};

export type R2VideoUploadResult = R2VideoInitResponse & {
  duration: number | null;
  thumbnailUrl: string | null;
};

export type UploadProgressHandler = (progress: number) => void;

export function uploadBytesWithProgress(
  url: string,
  body: Blob | File,
  contentType: string,
  onProgress?: UploadProgressHandler
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);

    xhr.upload.onprogress = (event) => {
      if (!onProgress || !event.lengthComputable) return;
      onProgress(getUploadProgressPercent(event.loaded, event.total));
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(new Error(`Upload failed with status ${xhr.status}`));
    };

    xhr.onerror = () => {
      reject(
        new Error(
          'Network error during upload. If you use direct S3/R2 uploads, configure bucket CORS to allow PUT from this site origin.'
        )
      );
    };
    xhr.onabort = () => reject(new Error('Upload aborted'));

    xhr.send(body);
  });
}

function uploadPartWithProgress(
  url: string,
  body: Blob,
  onPartProgress?: (loadedBytes: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    // Intentionally no Content-Type header: it is not part of the presigned
    // UploadPart signature, and the part body is raw bytes.

    xhr.upload.onprogress = (event) => {
      if (!onPartProgress || !event.lengthComputable) return;
      onPartProgress(event.loaded);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag');
        if (!etag) {
          reject(
            new Error(
              'Upload response missing ETag header. Configure bucket CORS to expose the ETag header.'
            )
          );
          return;
        }
        resolve(etag);
        return;
      }
      reject(new Error(`Chunk upload failed with status ${xhr.status}`));
    };

    xhr.onerror = () => {
      reject(
        new Error(
          'Network error during upload. If you use direct S3/R2 uploads, configure bucket CORS to allow PUT from this site origin.'
        )
      );
    };
    xhr.onabort = () => reject(new Error('Upload aborted'));

    xhr.send(body);
  });
}

async function withRetry<T>(fn: () => Promise<T>, delays: number[]): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, getRetryDelayMs(attempt, delays)));
    }
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // An abort or a permanent 4xx will fail the same way every time, so repeating it
      // only delays the error the caller is waiting for.
      if (!isRetryableUploadError(error)) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Upload failed after retries');
}

async function completeMultipartUpload(
  projectId: string,
  objectKey: string,
  uploadToken: string,
  parts: Array<{ partNumber: number; etag: string }>
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/videos/r2-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ objectKey, uploadToken, parts }),
  });

  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw apiRequestError(payload, 'Failed to complete multipart upload');
  }
}

async function uploadVideoMultipart(
  projectId: string,
  file: File,
  multipart: R2MultipartInit,
  objectKey: string,
  uploadToken: string,
  onProgress?: UploadProgressHandler
): Promise<void> {
  const totalBytes = file.size;
  const partSize = multipart.partSizeBytes;
  const loadedPerPart = new Array<number>(multipart.parts.length).fill(0);

  const reportProgress = () => {
    if (!onProgress) return;
    onProgress(getMultipartProgressPercent(loadedPerPart, totalBytes));
  };

  const completedParts: Array<{ partNumber: number; etag: string }> = [];

  for (let index = 0; index < multipart.parts.length; index += 1) {
    const part = multipart.parts[index];
    const { start, end } = getPartByteRange(part.partNumber, partSize, totalBytes);
    const blob = file.slice(start, end);

    const etag = await withRetry(
      () =>
        uploadPartWithProgress(part.url, blob, (loadedBytes) => {
          loadedPerPart[index] = loadedBytes;
          reportProgress();
        }),
      PART_RETRY_DELAYS_MS
    );

    loadedPerPart[index] = end - start;
    reportProgress();
    completedParts.push({ partNumber: part.partNumber, etag });
  }

  await completeMultipartUpload(projectId, objectKey, uploadToken, completedParts);
}

async function readVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };

    video.onloadedmetadata = () => {
      const duration =
        Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration) : null;
      cleanup();
      resolve(duration);
    };

    video.onerror = () => {
      cleanup();
      resolve(null);
    };

    video.src = objectUrl;
  });
}

export async function initR2VideoUpload(
  projectId: string,
  file: File,
  folderId: string | null = null,
  targetVideoId: string | null = null
): Promise<R2VideoInitResponse> {
  const initRes = await fetch(`/api/projects/${projectId}/videos/r2-init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      folderId,
      targetVideoId,
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
    }),
  });

  const initPayload = (await initRes.json().catch(() => null)) as {
    data?: R2VideoInitResponse;
    error?: string;
  } | null;
  if (!initRes.ok || !initPayload?.data) {
    throw apiRequestError(initPayload, 'Failed to initialize video upload');
  }

  return initPayload.data;
}

export async function cleanupPendingR2VideoUpload(
  projectId: string,
  input: {
    objectKey: string;
    uploadToken: string;
    reservationId: string | null;
    thumbnailObjectKey?: string | null;
  },
  keepalive = false
): Promise<void> {
  try {
    await fetch(`/api/projects/${projectId}/videos/r2-init`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objectKey: input.objectKey,
        uploadToken: input.uploadToken,
        reservationId: input.reservationId,
        thumbnailObjectKey: input.thumbnailObjectKey ?? undefined,
      }),
      keepalive,
    });
  } catch (error) {
    console.error('Failed to cleanup pending R2 video upload:', error);
  }
}

export async function uploadVideoToR2(
  projectId: string,
  file: File,
  options?: {
    onProgress?: UploadProgressHandler;
    folderId?: string | null;
    targetVideoId?: string | null;
  }
): Promise<R2VideoUploadResult> {
  const init = await initR2VideoUpload(
    projectId,
    file,
    options?.folderId ?? null,
    options?.targetVideoId ?? null
  );

  const cleanupInput = {
    objectKey: init.objectKey,
    uploadToken: init.uploadToken,
    reservationId: init.reservationId,
    thumbnailObjectKey: init.thumbnailObjectKey,
  };

  try {
    if (init.multipart) {
      await uploadVideoMultipart(
        projectId,
        file,
        init.multipart,
        init.objectKey,
        init.uploadToken,
        options?.onProgress
      );
    } else {
      await uploadBytesWithProgress(
        init.presignedPutUrl,
        file,
        init.contentType,
        options?.onProgress
      );
    }
  } catch (error) {
    await cleanupPendingR2VideoUpload(projectId, cleanupInput);
    throw error;
  }

  const [duration, thumbnailBlob] = await Promise.all([
    readVideoDuration(file),
    captureVideoThumbnail(file),
  ]);

  let thumbnailUrl: string | null = null;
  if (thumbnailBlob) {
    try {
      await uploadBytesWithProgress(init.thumbnailPresignedPutUrl, thumbnailBlob, 'image/jpeg');
      thumbnailUrl = init.thumbnailProxyUrl;
    } catch (error) {
      console.warn('Failed to upload video thumbnail:', error);
    }
  }

  return { ...init, duration, thumbnailUrl };
}
