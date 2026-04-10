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
    detectImageMime,
    getImageExtension,
    isAllowedImageType,
    normalizeImageMime,
} from '@/lib/image-upload-validation';
import {
    deriveGuestUploadContext,
    enforceGuestUploadQuota,
    verifyGuestUploadToken,
} from '@/lib/guest-upload-token';
import { logError } from '@/lib/logger';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_MULTIPART_BODY_SIZE = MAX_FILE_SIZE + (512 * 1024); // file + multipart overhead

export async function POST(request: NextRequest) {
    try {
        // Check Content-Length header BEFORE loading the file
        const contentLength = request.headers.get('content-length');
        if (!contentLength) {
            return apiErrors.badRequest('Missing Content-Length header');
        }
        const bodySize = parseInt(contentLength, 10);
        if (isNaN(bodySize) || bodySize <= 0) {
            return apiErrors.badRequest('Invalid Content-Length header');
        }
        if (bodySize > MAX_MULTIPART_BODY_SIZE) {
            return apiErrors.badRequest('File too large. Maximum size is 10MB.');
        }

        // Rate limit
        const limited = await rateLimit(request, 'image-upload');
        if (limited) return limited;

        const session = await auth();

        const formData = await request.formData();
        const files = formData.getAll('image');
        if (files.length !== 1) {
            return apiErrors.badRequest('No image file provided');
        }
        const file = files[0];
        const videoId = formData.get('videoId');
        const uploadToken = formData.get('uploadToken');

        if (!(file instanceof File)) {
            return apiErrors.badRequest('No image file provided');
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
                intent: 'image',
                context: expectedContext,
            });
            if (!isValidUploadToken) {
                return apiErrors.forbidden('Invalid upload token');
            }

            const quotaError = await enforceGuestUploadQuota(request, safeVideoId, 'image', shareSession?.token ?? null);
            if (quotaError) return quotaError;
        }

        // Double-check file size (defense in depth - Content-Length can be spoofed)
        if (file.size > MAX_FILE_SIZE) {
            return apiErrors.badRequest('File too large. Maximum size is 10MB.');
        }

        // Check content type
        const normalizedMime = normalizeImageMime(file.type);
        if (normalizedMime && !isAllowedImageType(normalizedMime)) {
            return apiErrors.badRequest(`Unsupported image format: ${file.type}`);
        }

        // Convert to buffer
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const detectedMime = detectImageMime(buffer);
        if (!detectedMime) {
            return apiErrors.badRequest('Uploaded file content does not match an allowed image type');
        }

        // Generate unique filename
        const ext = getImageExtension(detectedMime);
        const filename = `${randomUUID()}.${ext}`;
        const key = `images/${filename}`;

        // Upload to R2
        await r2Client.send(
            new PutObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: key,
                Body: buffer,
                ContentType: detectedMime,
            })
        );

        // Return the URL through our proxy endpoint
        const imageUrl = `/api/upload/image/${filename}`;

        const response = successResponse({ url: imageUrl }, 201);
        return withCacheControl(response, 'public, max-age=31536000, immutable');
    } catch (error) {
        logError('Error uploading image:', error);
        return apiErrors.internalError('Failed to upload image');
    }
}
