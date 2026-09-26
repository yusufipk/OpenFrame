import { apiRequestError } from '@/lib/client/api-error';
import { isVideoFile } from '@/lib/client/project-video-upload';

const IMAGE_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
]);
export const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;

export function isImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const expectedType = extension && IMAGE_TYPES.get(extension);
  const reportedType =
    file.type === 'image/jpg' || file.type === 'image/pjpeg' ? 'image/jpeg' : file.type;
  return Boolean(expectedType && (!reportedType || reportedType === expectedType));
}

export function isUploadableMediaFile(file: Pick<File, 'name' | 'type'>): boolean {
  return isImageFile(file) || isVideoFile(file);
}

export type ImageUploadResult = { id: string; videoId: string; versionId: string };

export function uploadProjectImage(
  projectId: string,
  file: File,
  options: {
    title?: string;
    description?: string | null;
    folderId?: string | null;
    targetVideoId?: string;
    versionLabel?: string;
    onProgress?: (progress: number) => void;
    signal?: AbortSignal;
  } = {}
): Promise<ImageUploadResult> {
  if (!isImageFile(file)) return Promise.reject(new Error('Choose a PNG, JPEG, or WebP image.'));
  if (options.signal?.aborted) return Promise.reject(new Error('Upload cancelled'));
  if (file.size > MAX_IMAGE_UPLOAD_BYTES)
    return Promise.reject(new Error('Images must be 20 MiB or smaller.'));
  const form = new FormData();
  form.set('file', file);
  for (const key of [
    'title',
    'description',
    'folderId',
    'targetVideoId',
    'versionLabel',
  ] as const) {
    const value = options[key];
    if (value) form.set(key, value);
  }

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const finish = (result: { data?: ImageUploadResult; error?: string; code?: string } | null) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      if (request.status >= 200 && request.status < 300 && result?.data?.versionId) {
        options.onProgress?.(100);
        resolve(result.data);
      } else {
        reject(apiRequestError(result, 'Failed to upload image'));
      }
    };
    const abort = () => request.abort();
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onload = () => {
      let payload = null;
      try {
        payload = JSON.parse(request.responseText);
      } catch {
        // The server did not return JSON.
      }
      finish(payload);
    };
    request.onerror = () => {
      if (!settled) {
        settled = true;
        options.signal?.removeEventListener('abort', abort);
        reject(new Error('Network error while uploading image'));
      }
    };
    request.onabort = () => {
      if (!settled) {
        settled = true;
        options.signal?.removeEventListener('abort', abort);
        reject(new Error('Upload cancelled'));
      }
    };
    request.open('POST', `/api/projects/${encodeURIComponent(projectId)}/videos/images`);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      settled = true;
      options.signal.removeEventListener('abort', abort);
      reject(new Error('Upload cancelled'));
      return;
    }
    request.send(form);
  });
}
