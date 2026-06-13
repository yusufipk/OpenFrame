import { captureVideoThumbnail } from '@/lib/client/video-thumbnail';

export type R2AssetVideoInitResponse = {
  presignedPutUrl: string;
  objectKey: string;
  proxyUrl: string;
  uploadToken: string;
  reservationId: string | null;
  contentType: string;
  thumbnailPresignedPutUrl: string;
  thumbnailObjectKey: string;
  thumbnailProxyUrl: string;
};

export type R2AssetVideoUploadResult = R2AssetVideoInitResponse & {
  thumbnailUrl: string | null;
};

type UploadProgressHandler = (progress: number) => void;

function uploadBytesWithProgress(
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
      onProgress(Math.round((event.loaded / event.total) * 100));
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

export async function initR2AssetVideoUpload(
  videoId: string,
  file: File
): Promise<R2AssetVideoInitResponse> {
  const initRes = await fetch(`/api/videos/${videoId}/assets/r2-init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
    }),
  });

  const initPayload = (await initRes.json().catch(() => null)) as {
    data?: R2AssetVideoInitResponse;
    error?: string;
  } | null;
  if (!initRes.ok || !initPayload?.data) {
    throw new Error(initPayload?.error || 'Failed to initialize video upload');
  }

  return initPayload.data;
}

export async function cleanupPendingR2AssetVideoUpload(
  videoId: string,
  input: {
    objectKey: string;
    uploadToken: string;
    thumbnailObjectKey?: string | null;
  },
  keepalive = false
): Promise<void> {
  try {
    await fetch(`/api/videos/${videoId}/assets/r2-init`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objectKey: input.objectKey,
        uploadToken: input.uploadToken,
        thumbnailObjectKey: input.thumbnailObjectKey ?? undefined,
      }),
      keepalive,
    });
  } catch (error) {
    console.error('Failed to cleanup pending R2 asset video upload:', error);
  }
}

export async function uploadAssetVideoToR2(
  videoId: string,
  file: File,
  options?: { onProgress?: UploadProgressHandler }
): Promise<R2AssetVideoUploadResult> {
  const init = await initR2AssetVideoUpload(videoId, file);

  const cleanupInput = {
    objectKey: init.objectKey,
    uploadToken: init.uploadToken,
    thumbnailObjectKey: init.thumbnailObjectKey,
  };

  try {
    await uploadBytesWithProgress(
      init.presignedPutUrl,
      file,
      init.contentType,
      options?.onProgress
    );
  } catch (error) {
    await cleanupPendingR2AssetVideoUpload(videoId, cleanupInput);
    throw error;
  }

  const thumbnailBlob = await captureVideoThumbnail(file);
  let thumbnailUrl: string | null = null;
  if (thumbnailBlob) {
    try {
      await uploadBytesWithProgress(init.thumbnailPresignedPutUrl, thumbnailBlob, 'image/jpeg');
      thumbnailUrl = init.thumbnailProxyUrl;
    } catch (error) {
      console.warn('Failed to upload asset video thumbnail:', error);
    }
  }

  return { ...init, thumbnailUrl };
}
