import { NextRequest, type NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { checkUploadDestination } from '@/lib/content-access';
import { contentId, ContentError } from '@/lib/content-mutations';
import { db } from '@/lib/db';
import {
  DRIVE_IMPORT_MAX_FILES,
  listDriveImports,
  reconcileDriveImports,
  startDriveImport,
  toDriveImportView,
  type DriveImportView,
} from '@/lib/drive-import';
import { importDriveImageReview } from '@/lib/drive-image-review-import';
import { getDriveImportBackend } from '@/lib/feature-flags';
import {
  getDriveFileMetadata,
  isPlausibleAccessToken,
  isValidDriveFileId,
  titleFromDriveFileName,
  verifyDriveAccessToken,
} from '@/lib/google-drive';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { runWithConcurrency } from '@/lib/async-pool';

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/drive-imports
// The caller's own imports into this project. Polling this is also what moves
// them forward: see reconcileDriveImports.
//
// Only the caller's own rows are listed, so no project-level access is asked
// for: a folder or video editor imports without being able to open the
// project root, and their imports still have to finish. Finalizing re-checks
// access to the destination anyway.
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'drive-import-list');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const rows = await listDriveImports(projectId, session.user.id);
    await reconcileDriveImports(rows);
    const refreshed = await listDriveImports(projectId, session.user.id);

    // The imports this request turned into videos, so the page knows to reload
    // what it shows.
    const wasActive = new Set(
      rows.filter((row) => row.status !== 'DONE' && row.status !== 'FAILED').map((row) => row.id)
    );
    const landed = refreshed
      .filter((row) => row.status === 'DONE' && wasActive.has(row.id))
      .map((row) => row.id);

    const response = successResponse({ imports: refreshed.map(toDriveImportView), landed });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error listing Drive imports:', error);
    return apiErrors.internalError('Failed to list Google Drive imports');
  }
}

// POST /api/projects/[projectId]/drive-imports
// Body: { fileIds: string[], accessToken: string, folderId?, targetVideoId? }
//
// Videos start an import that polling finishes. Images (new files only, not a
// version) become image reviews within this request and come back in `images`.
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'create-video');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const body = await request.json().catch(() => null);
    const folderId = contentId(body?.folderId);
    const targetVideoId = contentId(body?.targetVideoId);

    // Authorization before anything about the request's shape is looked at, so
    // a caller without access learns nothing from which of its fields are wrong.
    const access = await checkUploadDestination(
      projectId,
      folderId,
      targetVideoId,
      session.user.id
    );
    if (!access?.canEdit) {
      return apiErrors.forbidden('Access denied');
    }
    if (targetVideoId && !('video' in access && access.video?.mediaType === 'VIDEO')) {
      return apiErrors.badRequest('Use the image upload for a new version of an image review');
    }

    const backend = getDriveImportBackend();
    if (!backend) {
      return apiErrors.badRequest('Google Drive import is not available on this server');
    }

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
    if (targetVideoId && uniqueFileIds.length !== 1) {
      return apiErrors.badRequest('A new version takes exactly one file');
    }

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

    const imports: DriveImportView[] = [];
    const images: Array<{ driveFileId: string; videoId: string }> = [];
    const errors: Array<{ driveFileId: string; error: string }> = [];
    let firstRefusal: NextResponse | null = null;
    // Image reviews are written one at a time: each claims the next position in
    // the project inside a Serializable transaction, and two at once conflict.
    let imageQueue: Promise<unknown> = Promise.resolve();

    // A few files at a time: a slow Bunny start must not hold the whole batch
    // long enough for a proxy to time the request out after some files already
    // started. Quota stays exact, since each reservation takes a per-account lock.
    await runWithConcurrency(uniqueFileIds, 3, async (fileId) => {
      // One file failing (a Google timeout, a database hiccup) must not turn the
      // whole request into an error while earlier files have already started:
      // the client would then pick again and import those twice.
      try {
        const lookup = await getDriveFileMetadata(
          fileId,
          accessToken,
          targetVideoId ? 'video' : ['video', 'image']
        );
        if (!lookup.ok) {
          errors.push({ driveFileId: fileId, error: lookup.error });
          return;
        }

        if (lookup.file.mimeType.startsWith('image/')) {
          const run = imageQueue.then(() =>
            importDriveImageReview({
              projectId,
              folderId,
              userId: session.user.id,
              userName: session.user.name,
              billedUserId: project.workspace.ownerId,
              accessToken,
              file: lookup.file,
            })
          );
          imageQueue = run.catch(() => undefined);
          const result = await run;
          if (result.ok) {
            images.push({ driveFileId: fileId, videoId: result.videoId });
          } else {
            errors.push({ driveFileId: fileId, error: result.error });
            firstRefusal ??= result.response ?? null;
          }
          return;
        }

        const result = await startDriveImport({
          userId: session.user.id,
          projectId,
          folderId: targetVideoId ? null : folderId,
          targetVideoId,
          assetVideoId: null,
          billedUserId: project.workspace.ownerId,
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
      } catch (error) {
        logError('Error starting one Drive import:', error);
        errors.push({ driveFileId: fileId, error: 'This file could not be imported. Try again.' });
      }
    });

    // Nothing started: answer with the reason, in the shape the upload forms
    // already understand (a quota refusal keeps its own status and code).
    if (imports.length === 0 && images.length === 0) {
      if (firstRefusal) return firstRefusal;
      return apiErrors.badRequest(errors[0]?.error ?? 'No file could be imported');
    }

    const response = successResponse({ imports, images, errors }, 201);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    if (error instanceof ContentError) {
      return error.status === 400
        ? apiErrors.badRequest(error.message)
        : apiErrors.forbidden(error.message);
    }
    logError('Error starting Drive import:', error);
    return apiErrors.internalError('Failed to start the Google Drive import');
  }
}
