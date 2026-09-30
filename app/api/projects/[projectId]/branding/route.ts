import { getSession, withApiToken } from '@/lib/api-tokens';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { deleteMediaFilesBestEffort } from '@/lib/r2-cleanup';
import { hasR2Config } from '@/lib/feature-flags';
import { detectImageMime, getImageExtension } from '@/lib/image-upload-validation';
import {
  BRAND_ASSET_MAX_BYTES,
  brandAssetObjectKey,
  brandAssetUrl,
  isBrandAssetKind,
  toProjectBranding,
  type BrandAssetKind,
} from '@/lib/project-branding';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string }> };

const MAX_MULTIPART_BODY_SIZE = BRAND_ASSET_MAX_BYTES + 512 * 1024;

const brandingSelect = {
  id: true,
  ownerId: true,
  workspaceId: true,
  visibility: true,
  brandColor: true,
  brandBannerKey: true,
  brandLogoKey: true,
} as const;

function keyField(kind: BrandAssetKind) {
  return kind === 'banner' ? 'brandBannerKey' : 'brandLogoKey';
}

async function loadEditableProject(projectId: string, userId: string) {
  const project = await db.project.findUnique({ where: { id: projectId }, select: brandingSelect });
  if (!project) return null;
  const access = await checkProjectAccess(project, userId);
  return access.canEdit ? project : null;
}

async function removeObjectBestEffort(projectId: string, key: string | null) {
  const url = brandAssetUrl(projectId, key);
  if (url) await deleteMediaFilesBestEffort([url]);
}

// POST /api/projects/[projectId]/branding - Upload or replace the banner or the logo
//
// These files are not charged to the storage quota: a project holds at most one banner and
// one logo, each capped at BRAND_ASSET_MAX_BYTES, and a replaced file is deleted.
// scripts/r2-orphan-cleanup.ts does not scan branding/, so an object whose key never made
// it into the row (the row update throwing after PutObject succeeded) stays in the bucket.
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const contentLength = Number(request.headers.get('content-length'));
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      return apiErrors.badRequest('Missing Content-Length header');
    }
    if (contentLength > MAX_MULTIPART_BODY_SIZE) {
      return apiErrors.badRequest('File too large. Maximum size is 5MB.');
    }

    const limited = await rateLimit(request, 'image-upload');
    if (limited) return limited;

    const session = await getSession();
    const { projectId } = await params;
    if (!session?.user?.id) return apiErrors.unauthorized();

    const project = await loadEditableProject(projectId, session.user.id);
    if (!project) return apiErrors.forbidden('Access denied');

    if (!hasR2Config()) {
      return apiErrors.badRequest('Image uploads are not configured on this server');
    }

    const formData = await request.formData();
    const kind = formData.get('kind');
    if (!isBrandAssetKind(kind)) {
      return apiErrors.badRequest('kind must be "banner" or "logo"');
    }
    const files = formData.getAll('image');
    const file = files.length === 1 ? files[0] : null;
    if (!(file instanceof File)) {
      return apiErrors.badRequest('No image file provided');
    }
    if (file.size > BRAND_ASSET_MAX_BYTES) {
      return apiErrors.badRequest('File too large. Maximum size is 5MB.');
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const mime = detectImageMime(buffer);
    if (!mime) {
      return apiErrors.badRequest('Uploaded file content does not match an allowed image type');
    }

    const key = brandAssetObjectKey(`${randomUUID()}.${getImageExtension(mime)}`);
    await r2Client.send(
      new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key, Body: buffer, ContentType: mime })
    );

    // Only swap in the new key if nobody replaced the file since we read it. Otherwise two
    // uploads racing would each delete the same old file and leave one new file orphaned.
    const field = keyField(kind);
    const previousKey = project[field];
    const swapped = await db.project.updateMany({
      where: { id: projectId, [field]: previousKey },
      data: { [field]: key },
    });
    if (swapped.count === 0) {
      await removeObjectBestEffort(projectId, key);
      return apiErrors.conflict('Branding changed while uploading. Try again.');
    }
    await removeObjectBestEffort(projectId, previousKey);

    const branding = toProjectBranding(projectId, { ...project, [field]: key });
    return withCacheControl(successResponse({ branding }, 201), 'private, no-store');
  } catch (error) {
    logError('Error uploading project branding:', error);
    return apiErrors.internalError('Failed to upload branding image');
  }
}

// DELETE /api/projects/[projectId]/branding?kind=banner|logo - Remove the banner or the logo
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await getSession();
    const { projectId } = await params;
    if (!session?.user?.id) return apiErrors.unauthorized();

    const project = await loadEditableProject(projectId, session.user.id);
    if (!project) return apiErrors.forbidden('Access denied');

    const kind = request.nextUrl.searchParams.get('kind');
    if (!isBrandAssetKind(kind)) {
      return apiErrors.badRequest('kind must be "banner" or "logo"');
    }

    const field = keyField(kind);
    const previousKey = project[field];
    if (previousKey) {
      const cleared = await db.project.updateMany({
        where: { id: projectId, [field]: previousKey },
        data: { [field]: null },
      });
      // A concurrent upload already replaced the file and deleted this one.
      if (cleared.count > 0) await removeObjectBestEffort(projectId, previousKey);
    }

    const current = await db.project.findUnique({
      where: { id: projectId },
      select: brandingSelect,
    });
    const branding = current ? toProjectBranding(projectId, current) : null;
    return withCacheControl(successResponse({ branding }), 'private, no-store');
  } catch (error) {
    logError('Error removing project branding:', error);
    return apiErrors.internalError('Failed to remove branding image');
  }
}

export const POST = withApiToken('manage', handlePost);
export const DELETE = withApiToken('manage', handleDelete);
