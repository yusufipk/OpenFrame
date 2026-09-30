import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { runWithConcurrency } from '@/lib/async-pool';
import { checkVideoAccess } from '@/lib/content-access';
import { db } from '@/lib/db';
import { importDriveAttachment } from '@/lib/drive-asset-import';
import { DRIVE_IMPORT_MAX_FILES, startDriveImport, type DriveImportView } from '@/lib/drive-import';
import { getDriveImportBackend } from '@/lib/feature-flags';
import {
  getDriveFileMetadata,
  isPlausibleAccessToken,
  isValidDriveFileId,
  titleFromDriveFileName,
  verifyDriveAccessToken,
} from '@/lib/google-drive';
import { logError } from '@/lib/logger';
import { checkRateLimit, RATE_LIMIT_CONFIGS, rateLimit, rateLimitHeaders } from '@/lib/rate-limit';

type RouteParams = { params: Promise<{ videoId: string }> };

const ACCEPTED_KINDS = ['video', 'image', 'audio'] as const;

// POST /api/videos/[videoId]/assets/drive-import
// Body: { fileIds: string[], accessToken: string }
//
// Attaches Google Drive files to a video as assets, each as the kind its Drive
// type says, so one pick can mix videos, images and audio. Images and audio are copied
// within this request and come back as created asset ids. Videos start an
// import that the uploader's polling of the project's drive-imports finishes.
//
// Signed-in project members only: a share-link visitor can attach files from
// their computer, but a Drive import runs on after the request under the
// uploader's account, and finalizing re-checks membership.
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'asset-drive-import');
    if (limited) return limited;

    const session = await auth();
    const { videoId } = await params;
    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }
    // Each request can move up to 10 files of 50 MB through this server, so the
    // limit also follows the account, which cannot change IPs to get around it.
    const userLimit = RATE_LIMIT_CONFIGS['asset-drive-import-user']!;
    const perUser = await checkRateLimit(session.user.id, 'asset-drive-import-user', userLimit);
    if (!perUser.allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429, headers: rateLimitHeaders(perUser, userLimit.maxRequests) }
      );
    }

    const access = await checkVideoAccess(videoId, session.user.id);
    if (!access.hasAccess || !access.video) {
      return apiErrors.forbidden('Access denied');
    }
    const projectId = access.video.projectId;

    const backend = getDriveImportBackend();
    if (!backend) {
      return apiErrors.badRequest('Google Drive import is not available on this server');
    }

    const body = await request.json().catch(() => null);

    const fileIds: unknown = body?.fileIds;
    if (
      !Array.isArray(fileIds) ||
      fileIds.length === 0 ||
      fileIds.length > DRIVE_IMPORT_MAX_FILES ||
      !fileIds.every(isValidDriveFileId)
    ) {
      return apiErrors.badRequest(
        `fileIds must list between 1 and ${DRIVE_IMPORT_MAX_FILES} Google Drive files`
      );
    }
    const uniqueFileIds = [...new Set(fileIds)];

    const accessToken: unknown = body?.accessToken;
    if (!isPlausibleAccessToken(accessToken)) {
      return apiErrors.badRequest('accessToken is required');
    }
    if (!(await verifyDriveAccessToken(accessToken))) {
      return apiErrors.forbidden('Google Drive authorization was not accepted. Try again.');
    }

    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { workspace: { select: { ownerId: true } } },
    });
    if (!project) {
      return apiErrors.forbidden('Access denied');
    }
    const billedUserId = project.workspace.ownerId;

    const imports: DriveImportView[] = [];
    const assetIds: string[] = [];
    const errors: Array<{ driveFileId: string; error: string }> = [];
    let firstRefusal: NextResponse | null = null;

    await runWithConcurrency(uniqueFileIds, 3, async (fileId) => {
      // One file failing must not fail the files that already went through.
      try {
        const lookup = await getDriveFileMetadata(fileId, accessToken, ACCEPTED_KINDS);
        if (!lookup.ok) {
          errors.push({ driveFileId: fileId, error: lookup.error });
          return;
        }

        if (lookup.file.mimeType.startsWith('video/')) {
          const result = await startDriveImport({
            userId: session.user.id,
            projectId,
            folderId: null,
            targetVideoId: null,
            assetVideoId: videoId,
            billedUserId,
            backend,
            accessToken,
            file: lookup.file,
            title: titleFromDriveFileName(lookup.file.name),
          });
          if (result.ok) {
            imports.push(result.view);
          } else {
            errors.push({ driveFileId: fileId, error: result.error });
            firstRefusal ??= result.response ?? null;
          }
          return;
        }

        const result = await importDriveAttachment({
          kind: lookup.file.mimeType.startsWith('image/') ? 'IMAGE' : 'AUDIO',
          videoId,
          projectId,
          userId: session.user.id,
          billedUserId,
          accessToken,
          file: lookup.file,
        });
        if (result.ok) {
          assetIds.push(result.assetId);
        } else {
          errors.push({ driveFileId: fileId, error: result.error });
          firstRefusal ??= result.response ?? null;
        }
      } catch (error) {
        logError('Error importing one Drive attachment:', error);
        errors.push({ driveFileId: fileId, error: 'This file could not be imported. Try again.' });
      }
    });

    if (imports.length === 0 && assetIds.length === 0) {
      if (firstRefusal) return firstRefusal;
      return apiErrors.badRequest(errors[0]?.error ?? 'No file could be imported');
    }

    const response = successResponse({ imports, assetIds, errors }, 201);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error importing Drive attachments:', error);
    return apiErrors.internalError('Failed to import from Google Drive');
  }
}
