'use client';

import { convertAudioBlobToWav } from '@/lib/audio-to-wav';

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

export type DownloadProgress = {
  receivedBytes: number;
  /** null when the server didn't send a Content-Length. */
  totalBytes: number | null;
};

export function extensionFromUrl(url: string): string {
  const path = url.split('?')[0] ?? url;
  const dot = path.lastIndexOf('.');
  if (dot === -1) return '';
  const ext = path.slice(dot + 1).toLowerCase();
  return ext.length >= 1 && ext.length <= 5 ? ext : '';
}

export function replaceExtension(fileName: string, ext: string): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${stem}.${ext}`;
}

/** Strips the characters Windows and macOS reject in a file name. */
export function sanitizeDownloadFileName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** Percentage done, or null when the server didn't send a Content-Length. */
export function downloadProgressPercent(progress: DownloadProgress): number | null {
  const { receivedBytes, totalBytes } = progress;
  if (!totalBytes || totalBytes <= 0) return null;
  return Math.min(100, Math.floor((receivedBytes / totalBytes) * 100));
}

export function downloadProgressLabel(progress: DownloadProgress): string {
  const { receivedBytes, totalBytes } = progress;
  const pct = downloadProgressPercent(progress);
  if (pct !== null && totalBytes) {
    return `${pct}% · ${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`;
  }
  return formatBytes(receivedBytes);
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
 * The body is streamed through a counting transform so `onProgress` can report
 * live progress; the Blob itself is assembled by the browser (which can back
 * large blobs on disk) rather than accumulated in the JS heap.
 *
 * Returns `false` (without downloading) when the file is larger than
 * MAX_NAMED_DOWNLOAD_BYTES — buffering that would be unsafe — or when the fetch
 * isn't usable, so the caller can fall back to a plain navigation. Returns
 * `true` when the named blob was saved.
 */
export async function downloadNamedFile(
  url: string,
  fileName: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return false;
  }
  if (!res.ok) return false;

  const contentLengthRaw = Number(res.headers.get('content-length'));
  const totalBytes =
    Number.isFinite(contentLengthRaw) && contentLengthRaw > 0 ? contentLengthRaw : null;
  if (totalBytes !== null && totalBytes > MAX_NAMED_DOWNLOAD_BYTES) {
    await res.body?.cancel().catch(() => {});
    return false;
  }

  // Extension comes from the response Content-Type (a stream-built Blob has no
  // type), falling back to the URL.
  const contentType = (res.headers.get('content-type') || '').split(';')[0]?.trim() ?? '';

  let streamed: ReadableStream<Uint8Array<ArrayBufferLike>> | null = res.body;
  if (res.body && onProgress) {
    let received = 0;
    let lastMarker = -1;
    const counter = new TransformStream<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        // Safety net for streams without a Content-Length.
        if (received > MAX_NAMED_DOWNLOAD_BYTES) {
          controller.error(new Error('File exceeds the in-memory download limit'));
          return;
        }
        // Throttle: emit on each whole-percent change (or per ~2 MB if unknown).
        const marker = totalBytes
          ? Math.floor((received / totalBytes) * 100)
          : Math.floor(received / (2 * 1024 * 1024));
        if (marker !== lastMarker) {
          lastMarker = marker;
          onProgress({ receivedBytes: received, totalBytes });
        }
        controller.enqueue(chunk);
      },
    });
    streamed = res.body.pipeThrough(counter);
  }

  let blob: Blob;
  try {
    blob = streamed ? await new Response(streamed).blob() : await res.blob();
  } catch {
    return false;
  }

  const mimeExt = MIME_EXTENSION_MAP[contentType];
  saveBlobAs(blob, mimeExt ? replaceExtension(fileName, mimeExt) : fileName);
  return true;
}

const AUDIO_MIME_EXTENSION_MAP: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

const AUDIO_EXTENSIONS = new Set(Object.values(AUDIO_MIME_EXTENSION_MAP).concat('mp4', 'oga'));

/** Display names are often the recorded file name, extension and all, and
 * `recording.webm.wav` helps nobody. */
function stripAudioExtension(name: string): string {
  const ext = extensionFromUrl(name);
  return ext && AUDIO_EXTENSIONS.has(ext) ? name.slice(0, -(ext.length + 1)) : name;
}

/**
 * Containers an editing suite already opens. Audio assets are not only voice
 * recordings, anyone can upload an audio file, and decoding one of these back out
 * through the Web Audio API would resample it to 48 kHz and requantise it to 16
 * bit for no gain. A file in this set is handed over exactly as stored.
 */
const EDITOR_READY_MIME_TYPES = new Set(['audio/wav', 'audio/mpeg', 'audio/mp4']);

export type AudioDownloadResult =
  | 'wav'
  | 'no-conversion-needed'
  | 'conversion-unsupported'
  | 'failed';

/**
 * Voice notes are stored exactly as MediaRecorder produced them: WebM/Opus,
 * which browsers play and no editing suite imports. Convert on the way out so
 * the file lands in the timeline it was recorded for.
 *
 * Saves the stored file untouched when it is already in an editable container,
 * or when this browser cannot decode it, so the download always works. The
 * return value says which of the three happened, or 'failed' when the file
 * could not be fetched at all.
 */
export async function downloadAudioAsWav(
  url: string,
  baseName: string
): Promise<AudioDownloadResult> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return 'failed';
  }
  if (!res.ok) return 'failed';

  let source: Blob;
  try {
    source = await res.blob();
  } catch {
    return 'failed';
  }

  const stem = stripAudioExtension(sanitizeDownloadFileName(baseName)) || 'voice-note';
  // The proxy route names the real container; the URL usually carries no
  // extension, so the content type is the better source for both decisions.
  const contentType = (res.headers.get('content-type') || '').split(';')[0]?.trim() ?? '';
  const ext = AUDIO_MIME_EXTENSION_MAP[contentType] || extensionFromUrl(url) || 'webm';

  if (EDITOR_READY_MIME_TYPES.has(contentType)) {
    saveBlobAs(source, `${stem}.${ext}`);
    return 'no-conversion-needed';
  }

  const wav = await convertAudioBlobToWav(source);
  if (wav) {
    saveBlobAs(wav, `${stem}.wav`);
    return 'wav';
  }

  saveBlobAs(source, `${stem}.${ext}`);
  return 'conversion-unsupported';
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
