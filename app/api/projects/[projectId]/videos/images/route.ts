import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { checkUploadDestination } from '@/lib/content-access';
import { contentId, ContentError } from '@/lib/content-mutations';
import { db } from '@/lib/db';
import { hasR2Config } from '@/lib/feature-flags';
import { normalizeImageMime } from '@/lib/image-upload-validation';
import {
  MAX_IMAGE_REVIEW_BYTES as MAX_IMAGE_BYTES,
  storeImageReview,
} from '@/lib/image-review-upload';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

type RouteParams = { params: Promise<{ projectId: string }> };

function optionalText(value: FormDataEntryValue | null, maxLength: number): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw new ContentError(400, `Text must be ${maxLength} characters or fewer`);
  }
  return value.trim() || null;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'create-video');
    if (limited) return limited;
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    const { projectId } = await params;
    if (!hasR2Config())
      return apiErrors.badRequest('Image uploads require configured object storage');

    const contentLength = request.headers.get('content-length');
    if (contentLength !== null) {
      const declaredLength = Number(contentLength);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 1) {
        return apiErrors.badRequest('Invalid Content-Length header');
      }
      if (declaredLength > MAX_IMAGE_BYTES + 512 * 1024) {
        return apiErrors.badRequest('Image is too large. Maximum size is 20MB.');
      }
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File) || form.getAll('file').length !== 1 || file.size === 0) {
      return apiErrors.badRequest('One image file is required');
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return apiErrors.badRequest('Image is too large. Maximum size is 20MB.');
    }

    const targetVideoId = contentId(form.get('targetVideoId'));
    const folderId = contentId(form.get('folderId'));
    const title = optionalText(form.get('title'), 100) || file.name.replace(/\.[^.]+$/, '').trim();
    const description = optionalText(form.get('description'), 5000);
    const versionLabel = optionalText(form.get('versionLabel'), 100);
    if (!title || title.length > 100)
      return apiErrors.badRequest('Title must contain 1 to 100 characters');

    const destination = await checkUploadDestination(
      projectId,
      folderId,
      targetVideoId,
      session.user.id
    );
    if (!destination?.canEdit) return apiErrors.forbidden('Upload destination is unavailable');
    if (targetVideoId && (!('video' in destination) || destination.video?.mediaType !== 'IMAGE')) {
      return apiErrors.badRequest('Image versions require an image review');
    }
    const billedUserId = await db.project
      .findUnique({
        where: { id: projectId },
        select: { workspace: { select: { ownerId: true } } },
      })
      .then((project) => project?.workspace.ownerId ?? null);
    if (!billedUserId) return apiErrors.notFound('Project');
    const reservedOwnerId = billedUserId;

    const stored = await storeImageReview({
      projectId,
      folderId,
      targetVideoId,
      userId: session.user.id,
      userName: session.user.name,
      reservedOwnerId,
      bytes: Buffer.from(await file.arrayBuffer()),
      suppliedMime: normalizeImageMime(file.type) || null,
      title,
      description,
      versionLabel,
    });
    if ('response' in stored) return stored.response;
    return withCacheControl(successResponse(stored.data, 201), 'private, no-store');
  } catch (error) {
    if (error instanceof ContentError) {
      if (error.status === 403) return apiErrors.forbidden(error.message);
      return apiErrors.badRequest(error.message);
    }
    logError('Error uploading image review:', error);
    return apiErrors.internalError('Failed to upload image review');
  }
}
