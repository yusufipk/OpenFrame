'use client';

// Above this size we don't buffer the file in memory to rename it — the caller
// falls back to a plain navigation so the browser streams it straight to disk
// (with the CDN's own filename). 10 GiB.
export const MAX_NAMED_DOWNLOAD_BYTES = 10 * 1024 * 1024 * 1024;

const MIME_EXTENSION_MAP: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
};

export function extensionFromUrl(url: string): string {
  const path = url.split('?')[0] ?? url;
  const dot = path.lastIndexOf('.');
  if (dot === -1) return '';
  const ext = path.slice(dot + 1).toLowerCase();
  return ext.length >= 1 && ext.length <= 5 ? ext : '';
}

function replaceExtension(fileName: string, ext: string): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${stem}.${ext}`;
}

export function saveBlobAs(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the download has had a chance to start.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

/**
 * Fetch a (possibly cross-origin) file and save it under `fileName`. The
 * browser's `download` attribute is ignored across origins / redirects, so for
 * CDN sources we pull the bytes (CORS is open on them) and save the blob, which
 * lets us control the name and derive the real extension from the content type.
 *
 * Returns `false` (without downloading) when the file is larger than
 * MAX_NAMED_DOWNLOAD_BYTES — buffering that in memory would be unsafe — or when
 * the fetch isn't usable, so the caller can fall back to a plain navigation.
 * Returns `true` when the named blob was saved.
 */
export async function downloadNamedFile(url: string, fileName: string): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return false;
  }
  if (!res.ok) return false;

  const contentLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_NAMED_DOWNLOAD_BYTES) {
    await res.body?.cancel().catch(() => {});
    return false;
  }

  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    return false;
  }

  const mimeExt = MIME_EXTENSION_MAP[blob.type];
  saveBlobAs(blob, mimeExt ? replaceExtension(fileName, mimeExt) : fileName);
  return true;
}

/** Plain navigation download (streams to disk; filename controlled only for
 * same-origin URLs via the download attribute). */
export function navigateDownload(url: string, sameOriginFileName?: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener';
  if (sameOriginFileName && url.startsWith('/')) {
    anchor.download = sameOriginFileName;
  }
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
