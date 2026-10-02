const THUMBNAIL_MAX_WIDTH = 640;
const DEFAULT_SEEK_SECONDS = 1;

export async function captureVideoThumbnail(
  file: File,
  seekSeconds = DEFAULT_SEEK_SECONDS
): Promise<Blob | null> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    let settled = false;

    const finish = (blob: Blob | null) => {
      if (settled) return;
      settled = true;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
      resolve(blob);
    };

    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const target =
        duration > 0 ? Math.min(Math.max(seekSeconds, 0), Math.max(0, duration - 0.1)) : 0;
      video.currentTime = target;
    };

    video.onseeked = () => {
      try {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width <= 0 || height <= 0) {
          finish(null);
          return;
        }

        const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);

        const context = canvas.getContext('2d');
        if (!context) {
          finish(null);
          return;
        }

        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => finish(blob), 'image/jpeg', 0.85);
      } catch {
        finish(null);
      }
    };

    video.onerror = () => finish(null);
    video.src = objectUrl;
  });
}

/**
 * A thumbnail URL with a cache-busting `t` parameter for a retry. Signed Bunny
 * thumbnails already carry a query string, and a second `?` would fold the retry
 * key into the token's `expires` value and break the signature.
 */
export function withRetryParam(url: string, retryKey: number): string {
  if (!retryKey) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${retryKey}`;
}
