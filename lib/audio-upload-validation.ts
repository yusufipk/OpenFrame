/**
 * What an uploaded audio attachment may be. Shared by the browser upload route
 * and the Google Drive import. The Drive import only looks at files Drive types
 * as audio/*, so a voice note Drive calls video/webm is taken only by the
 * browser upload.
 */

export const MAX_AUDIO_UPLOAD_BYTES = 10 * 1024 * 1024;

// Canonical MIME types accepted
export const ALLOWED_AUDIO_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/opus',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
]);

// Normalize known MIME aliases to canonical values
export const AUDIO_MIME_ALIASES: Record<string, string> = {
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/x-pn-wav': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  // Some browsers report MediaRecorder audio-only blobs as video/* containers.
  'video/webm': 'audio/webm',
  'video/mp4': 'audio/mp4',
};

// Map canonical MIME to fallback file extension
export const AUDIO_MIME_TO_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

// Safe extensions to preserve from original filename (prevents path traversal, allows known types)
// Intentionally excludes flac/aac: they have no corresponding MIME in ALLOWED_TYPES and are
// never produced by MediaRecorder, so accepting them would create extension/MIME mismatches.
export const SAFE_AUDIO_EXTENSIONS = new Set(['webm', 'ogg', 'opus', 'mp3', 'm4a', 'mp4', 'wav']);

// Reject content that looks like HTML/XML/script regardless of the declared MIME type.
export function isHtmlContent(bytes: Uint8Array): boolean {
  const snippet = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString('latin1', 0, Math.min(bytes.length, 512))
    .trimStart()
    .slice(0, 50)
    .toLowerCase();
  return (
    snippet.startsWith('<!doctype') ||
    snippet.startsWith('<html') ||
    snippet.startsWith('<?xml') ||
    snippet.startsWith('<script') ||
    snippet.startsWith('<svg')
  );
}

// Verify that the first bytes of the file match known audio container signatures.
export function hasValidAudioMagicBytes(header: Uint8Array, mimeType: string): boolean {
  if (header.length < 8) return false;
  switch (mimeType) {
    // WebM / Matroska: EBML header 1a 45 df a3
    case 'audio/webm':
      return header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
    // OGG container (covers ogg vorbis and opus)
    case 'audio/ogg':
    case 'audio/opus':
      return header[0] === 0x4f && header[1] === 0x67 && header[2] === 0x67 && header[3] === 0x53; // "OggS"
    // MPEG audio: ID3 tag header or raw MPEG sync frame
    case 'audio/mpeg': {
      const hasId3 = header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33; // "ID3"
      const hasMpegSync = header[0] === 0xff && (header[1] & 0xe0) === 0xe0;
      return hasId3 || hasMpegSync;
    }
    // MP4 / M4A: ISO base media file; "ftyp" box starts at offset 4
    case 'audio/mp4':
      return header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70; // "ftyp"
    // WAV: RIFF header
    case 'audio/wav':
      return header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46; // "RIFF"
    default:
      return false;
  }
}
