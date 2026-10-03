const VIDEO_MIME_TO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogg',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
};

const EXT_TO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
};

const ALLOWED_VIDEO_EXTENSIONS = new Set(Object.keys(EXT_TO_MIME));

export function normalizeVideoMime(mime: string | undefined): string | null {
  if (!mime) return null;
  const normalized = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!normalized.startsWith('video/')) return null;
  return normalized;
}

export function getVideoExtensionFromMime(mime: string): string | null {
  return VIDEO_MIME_TO_EXT[mime] ?? null;
}

export function getVideoMimeFromExtension(ext: string): string | null {
  return EXT_TO_MIME[ext] ?? null;
}

export function getVideoExtensionFromFileName(fileName: string): string | null {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (!ext || !ALLOWED_VIDEO_EXTENSIONS.has(ext)) return null;
  return ext;
}

/**
 * The file name decides, always. A declared MIME type is a client claim, so trusting it
 * on its own let `payload.exe` through as long as it said `video/mp4`. The declared type
 * is only consulted to pick between two types that share an extension.
 */
export function resolveVideoContentType(fileName: string, mime: string | undefined): string | null {
  const ext = getVideoExtensionFromFileName(fileName);
  if (!ext) return null;

  const typeFromName = EXT_TO_MIME[ext];
  if (!typeFromName) return null;

  const normalizedMime = normalizeVideoMime(mime);
  if (normalizedMime && getVideoExtensionFromMime(normalizedMime) === ext) {
    return normalizedMime;
  }

  return typeFromName;
}

export function isAllowedVideoFile(fileName: string, mime: string | undefined): boolean {
  return resolveVideoContentType(fileName, mime) !== null;
}

export const VIDEO_OBJECT_KEY_PREFIX = 'videos/';
export const VIDEO_PROXY_PREFIX = '/api/upload/video/';

const SAFE_VIDEO_BASENAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;

export function buildVideoObjectKey(filename: string): string {
  return `${VIDEO_OBJECT_KEY_PREFIX}${filename}`;
}

export function videoProxyPathFromFilename(filename: string): string {
  return `${VIDEO_PROXY_PREFIX}${filename}`;
}

export function videoProxyPathToObjectKey(proxyPath: string): string | null {
  if (!proxyPath.startsWith(VIDEO_PROXY_PREFIX)) return null;
  const filename = proxyPath.slice(VIDEO_PROXY_PREFIX.length);
  if (!SAFE_VIDEO_BASENAME.test(filename)) return null;
  return buildVideoObjectKey(filename);
}

/**
 * Playback URL for a direct-upload (`r2`) version: media always streams through
 * the app's own upload route. Shared by the video page and the compare view so
 * the two cannot drift.
 */
export function resolveR2PlaybackUrl(version: { videoId: string; originalUrl: string }): string {
  if (version.originalUrl.startsWith(VIDEO_PROXY_PREFIX)) {
    return version.originalUrl;
  }
  if (version.originalUrl.startsWith(VIDEO_OBJECT_KEY_PREFIX)) {
    return videoProxyPathFromFilename(version.originalUrl.slice(VIDEO_OBJECT_KEY_PREFIX.length));
  }
  if (version.videoId.startsWith(VIDEO_OBJECT_KEY_PREFIX)) {
    return videoProxyPathFromFilename(version.videoId.slice(VIDEO_OBJECT_KEY_PREFIX.length));
  }
  return version.originalUrl;
}

/**
 * Guards what ends up in a `<video src>`: proxy paths must be a well-formed
 * upload route, anything else must be plain http(s).
 */
export function isPlayableVideoUrl(url: string): boolean {
  if (url.startsWith(VIDEO_PROXY_PREFIX)) {
    return videoProxyPathToObjectKey(url) !== null;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function objectKeyToVideoProxyPath(objectKey: string): string | null {
  if (!objectKey.startsWith(VIDEO_OBJECT_KEY_PREFIX)) return null;
  const filename = objectKey.slice(VIDEO_OBJECT_KEY_PREFIX.length);
  if (!SAFE_VIDEO_BASENAME.test(filename)) return null;
  return videoProxyPathFromFilename(filename);
}

export { SAFE_VIDEO_BASENAME };
