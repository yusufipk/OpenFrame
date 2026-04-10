import { apiErrors } from '@/lib/api-response';
import { proxyR2MediaObject } from '@/lib/r2-media-proxy';
import { logError } from '@/lib/logger';

// Only allow UUID filenames with safe extensions
const SAFE_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;

// Map extensions to content types
const CONTENT_TYPE_MAP: Record<string, string> = {
  webm: 'audio/webm',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};
function getContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return CONTENT_TYPE_MAP[ext] || 'audio/webm';
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename } = await params;

    // Validate filename to prevent path traversal
    if (!SAFE_FILENAME.test(filename)) {
      return apiErrors.badRequest('Invalid filename');
    }

    const key = `voice/${filename}`;
    return proxyR2MediaObject({
      request,
      key,
      fallbackContentType: getContentType(filename),
      cacheControl: 'private, no-store',
      internalErrorMessage: 'Failed to retrieve audio',
    });
  } catch (error: unknown) {
    logError('Error serving audio:', error);
    return apiErrors.internalError('Failed to retrieve audio');
  }
}
