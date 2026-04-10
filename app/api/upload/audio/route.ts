import { NextRequest } from 'next/server';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { rateLimit } from '@/lib/rate-limit';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import {
  deriveGuestUploadContext,
  enforceGuestUploadQuota,
  verifyGuestUploadToken,
} from '@/lib/guest-upload-token';
import { logError } from '@/lib/logger';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_MULTIPART_BODY_SIZE = MAX_FILE_SIZE + (512 * 1024); // file + multipart overhead

// Canonical MIME types accepted
const ALLOWED_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/opus', 'audio/mp4', 'audio/mpeg', 'audio/wav']);

// Normalize known MIME aliases to canonical values
const MIME_ALIASES: Record<string, string> = {
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/x-pn-wav': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
};

// Map canonical MIME to fallback file extension
const MIME_TO_EXT: Record<string, string> = {
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
const SAFE_AUDIO_EXTENSIONS = new Set(['webm', 'ogg', 'opus', 'mp3', 'm4a', 'mp4', 'wav']);

// Reject content that looks like HTML/XML/script regardless of the declared MIME type.
function isHtmlContent(bytes: Buffer): boolean {
  const snippet = bytes.toString('latin1', 0, Math.min(bytes.length, 512)).trimStart().slice(0, 50).toLowerCase();
  return (
    snippet.startsWith('<!doctype') ||
    snippet.startsWith('<html') ||
    snippet.startsWith('<?xml') ||
    snippet.startsWith('<script') ||
    snippet.startsWith('<svg')
  );
}

// Verify that the first bytes of the file match known audio container signatures.
function hasValidAudioMagicBytes(header: Buffer, mimeType: string): boolean {
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

export async function POST(request: NextRequest) {
  try {
    // Check Content-Length header BEFORE loading the file
    const contentLength = request.headers.get('content-length');
    if (contentLength) {
      const bodySize = parseInt(contentLength, 10);
      if (isNaN(bodySize) || bodySize > MAX_MULTIPART_BODY_SIZE) {
        return apiErrors.badRequest('File too large. Maximum size is 10MB.');
      }
    }

    // Rate limit
    const limited = await rateLimit(request, 'voice-upload');
    if (limited) return limited;

    const session = await auth();

    const formData = await request.formData();
    const file = formData.get('audio') as File | null;
    const videoId = formData.get('videoId');
    const uploadToken = formData.get('uploadToken');

    if (!file) {
      return apiErrors.badRequest('No audio file provided');
    }
    if (typeof videoId !== 'string' || !videoId.trim()) {
      return apiErrors.badRequest('videoId is required');
    }

    const safeVideoId = videoId.trim();
    const video = await db.video.findUnique({
      where: { id: safeVideoId },
      include: { project: true },
    });
    if (!video) {
      return apiErrors.notFound('Video');
    }

    const access = await checkProjectAccess(video.project, session?.user?.id);
    const shareSession = getShareSessionFromRequest(request, safeVideoId);
    const shareAccess = shareSession
      ? await validateShareLinkAccess({
        token: shareSession.token,
        projectId: video.projectId,
        videoId: safeVideoId,
        requiredPermission: 'COMMENT',
        passwordVerified: shareSession.passwordVerified,
      })
      : { hasAccess: false, canComment: false, canDownload: false, allowGuests: false, requiresPassword: false };
    const canCommentWithMembership = !!session?.user?.id && access.hasAccess;
    const canCommentWithShareLink = shareAccess.canComment && (session?.user?.id ? true : shareAccess.allowGuests);
    if (!canCommentWithMembership && !canCommentWithShareLink) {
      return apiErrors.forbidden('Access denied');
    }

    if (!session?.user?.id) {
      if (typeof uploadToken !== 'string' || !uploadToken.trim()) {
        return apiErrors.badRequest('uploadToken is required for guest uploads');
      }

      const expectedContext = deriveGuestUploadContext(request, shareSession?.token ?? null);
      if (!expectedContext) {
        return apiErrors.forbidden('Missing trusted client IP header');
      }

      const isValidUploadToken = verifyGuestUploadToken(uploadToken.trim(), {
        projectId: video.projectId,
        videoId: safeVideoId,
        intent: 'audio',
        context: expectedContext,
      });
      if (!isValidUploadToken) {
        return apiErrors.forbidden('Invalid upload token');
      }

      const quotaError = await enforceGuestUploadQuota(request, safeVideoId, 'audio', shareSession?.token ?? null);
      if (quotaError) return quotaError;
    }

    // Double-check file size (defense in depth - Content-Length can be spoofed)
    if (file.size > MAX_FILE_SIZE) {
      return apiErrors.badRequest('File too large. Maximum size is 10MB.');
    }

    // Normalize content type: strip codec params, then resolve aliases
    const rawContentType = file.type || 'audio/webm';
    const strippedType = rawContentType.split(';')[0].trim().toLowerCase();
    const contentType = MIME_ALIASES[strippedType] ?? strippedType;
    if (!ALLOWED_TYPES.has(contentType)) {
      return apiErrors.badRequest(`Unsupported audio format: ${rawContentType}`);
    }

    // Prefer the original file extension when it's a known safe type (e.g. preserve .opus, .mp3)
    // Fall back to MIME-derived extension for blobs without a real name (e.g. MediaRecorder output)
    const origExt = (file.name.split('.').pop() ?? '').toLowerCase();
    const ext = SAFE_AUDIO_EXTENSIONS.has(origExt) ? origExt : (MIME_TO_EXT[contentType] ?? 'webm');
    const filename = `${randomUUID()}.${ext}`;
    const key = `voice/${filename}`;

    // Convert to buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Validate file content against magic bytes — rejects HTML/scripts masquerading as audio
    if (isHtmlContent(buffer)) {
      return apiErrors.badRequest('File content does not match an audio format');
    }
    if (!hasValidAudioMagicBytes(buffer.slice(0, 16), contentType)) {
      return apiErrors.badRequest('File content does not match the declared audio format');
    }

    // Upload to R2
    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );

    // Return the URL through our proxy endpoint
    const voiceUrl = `/api/upload/audio/${filename}`;

    const response = successResponse({ url: voiceUrl }, 201);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error uploading audio:', error);
    return apiErrors.internalError('Failed to upload audio');
  }
}
