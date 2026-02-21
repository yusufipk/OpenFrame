import { auth } from '@/lib/auth';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml'
];

export async function POST(request: Request) {
    try {
        // Check Content-Length header BEFORE loading the file
        const contentLength = request.headers.get('content-length');
        if (contentLength) {
            const fileSize = parseInt(contentLength, 10);
            if (isNaN(fileSize) || fileSize > MAX_FILE_SIZE) {
                return apiErrors.badRequest('File too large. Maximum size is 10MB.');
            }
        }

        // Rate limit
        const limited = await rateLimit(request, 'image-upload');
        if (limited) return limited;

        // Require authentication
        const session = await auth();
        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const formData = await request.formData();
        const file = formData.get('image') as File | null;

        if (!file) {
            return apiErrors.badRequest('No image file provided');
        }

        // Double-check file size (defense in depth - Content-Length can be spoofed)
        if (file.size > MAX_FILE_SIZE) {
            return apiErrors.badRequest('File too large. Maximum size is 10MB.');
        }

        // Check content type
        const contentType = file.type;
        if (!ALLOWED_TYPES.includes(contentType)) {
            return apiErrors.badRequest(`Unsupported image format: ${contentType}`);
        }

        // Generate unique filename
        const ext = contentType.split('/')[1] === 'svg+xml' ? 'svg' : contentType.split('/')[1] || 'jpeg';
        const filename = `${randomUUID()}.${ext}`;
        const key = `images/${filename}`;

        // Convert to buffer
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

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
        const imageUrl = `/api/upload/image/${filename}`;

        const response = successResponse({ url: imageUrl }, 201);
        return withCacheControl(response, 'public, max-age=31536000, immutable');
    } catch (error) {
        console.error('Error uploading image:', error);
        return apiErrors.internalError('Failed to upload image');
    }
}
