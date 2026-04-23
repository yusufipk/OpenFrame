import { randomUUID } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse } from '@/lib/api-response';
import {
  detectImageMime,
  getImageExtension,
  isAllowedImageType,
  normalizeImageMime,
} from '@/lib/image-upload-validation';
import { rateLimit } from '@/lib/rate-limit';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { logError } from '@/lib/logger';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_MULTIPART_BODY_SIZE = MAX_FILE_SIZE + 512 * 1024; // file + multipart overhead

// POST /api/feedback/upload
export async function POST(request: NextRequest) {
  try {
    const limited = await rateLimit(request, 'feedback-upload');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized('You must be signed in to upload screenshots');
    }

    const contentLength = request.headers.get('content-length');
    if (!contentLength) {
      return apiErrors.badRequest('Missing Content-Length header');
    }
    const size = parseInt(contentLength, 10);
    if (Number.isNaN(size) || size <= 0) {
      return apiErrors.badRequest('Invalid Content-Length header');
    }
    if (size > MAX_MULTIPART_BODY_SIZE) {
      return apiErrors.badRequest('File too large. Maximum size is 10MB.');
    }

    const formData = await request.formData();
    const files = formData.getAll('image');
    if (files.length !== 1) {
      return apiErrors.badRequest('No image file provided');
    }
    const file = files[0];
    if (!(file instanceof File)) {
      return apiErrors.badRequest('No image file provided');
    }

    if (file.size > MAX_FILE_SIZE) {
      return apiErrors.badRequest('File too large. Maximum size is 10MB.');
    }

    const normalizedMime = normalizeImageMime(file.type);
    if (normalizedMime && !isAllowedImageType(normalizedMime)) {
      return apiErrors.badRequest(`Unsupported image format: ${file.type}`);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const detectedMime = detectImageMime(buffer);
    if (!detectedMime) {
      return apiErrors.badRequest('Uploaded file content does not match an allowed image type');
    }

    const ext = getImageExtension(detectedMime);
    const filename = `${randomUUID()}.${ext}`;
    const key = `images/${filename}`;

    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: detectedMime,
      })
    );

    return successResponse({ url: `/api/upload/image/${filename}` }, 201);
  } catch (error) {
    logError('Error uploading feedback screenshot:', error);
    return apiErrors.internalError('Failed to upload screenshot');
  }
}
