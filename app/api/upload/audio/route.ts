import { auth } from '@/lib/auth';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'];

export async function POST(request: Request) {
  try {
    // Rate limit
    const limited = await rateLimit(request, 'voice-upload');
    if (limited) return limited;

    // Require authentication
    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const formData = await request.formData();
    const file = formData.get('audio') as File | null;

    if (!file) {
      return apiErrors.badRequest('No audio file provided');
    }

    if (file.size > MAX_FILE_SIZE) {
      return apiErrors.badRequest('File too large. Maximum size is 10MB.');
    }

    // Check content type
    const contentType = file.type || 'audio/webm';
    if (!ALLOWED_TYPES.includes(contentType)) {
      return apiErrors.badRequest(`Unsupported audio format: ${contentType}`);
    }

    // Generate unique filename
    const ext = contentType.split('/')[1] || 'webm';
    const filename = `${randomUUID()}.${ext}`;
    const key = `voice/${filename}`;

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
    const voiceUrl = `/api/upload/audio/${filename}`;

    const response = successResponse({ url: voiceUrl }, 201);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    console.error('Error uploading audio:', error);
    return apiErrors.internalError('Failed to upload audio');
  }
}
