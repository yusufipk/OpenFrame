import { apiErrors } from '@/lib/api-response';
import { proxyR2MediaObject } from '@/lib/r2-media-proxy';

// Only allow UUID filenames with safe extensions
const SAFE_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;

const CONTENT_TYPE_MAP: Record<string, string> = {
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
};
function getContentType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return CONTENT_TYPE_MAP[ext] || 'application/octet-stream';
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

        const key = `images/${filename}`;
        return proxyR2MediaObject({
            request,
            key,
            fallbackContentType: getContentType(filename),
            cacheControl: 'private, no-store',
            extraHeaders: {
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'; sandbox",
            },
            internalErrorMessage: 'Failed to retrieve image',
        });
    } catch (error: unknown) {
        console.error('Error serving image:', error);
        return apiErrors.internalError('Failed to retrieve image');
    }
}
