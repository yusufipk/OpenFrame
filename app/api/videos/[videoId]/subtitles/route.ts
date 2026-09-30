import { withApiToken } from '@/lib/api-tokens';
import { NextRequest } from 'next/server';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { db } from '@/lib/db';
import { logError } from '@/lib/logger';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { rateLimit } from '@/lib/rate-limit';
import {
  releaseStorageReservation,
  reserveStorageQuota,
  UPLOAD_RESERVATION_PURPOSES,
} from '@/lib/storage-quota';
import {
  getSubtitleExtension,
  MAX_SUBTITLE_FILE_SIZE,
  normalizeSubtitleFile,
  normalizeSubtitleLanguage,
  sanitizeSubtitleLabel,
  subtitleFileNameToProxyUrl,
  SUBTITLE_CONTENT_TYPE,
  SUBTITLE_OBJECT_KEY_PREFIX,
  subtitleProxyPathToObjectKey,
} from '@/lib/subtitle-validation';
import { getVideoAssetAccessContext } from '@/lib/video-assets';

type RouteParams = { params: Promise<{ videoId: string }> };

const MAX_MULTIPART_BODY_SIZE = MAX_SUBTITLE_FILE_SIZE + 64 * 1024;

/** A cut with more tracks than this is not being subtitled, it is being used as storage. */
const MAX_SUBTITLES_PER_VERSION = 20;

type SubtitleRow = {
  id: string;
  versionId: string;
  language: string;
  label: string;
  sourceUrl: string;
  sizeBytes: bigint;
  createdAt: Date;
  updatedAt: Date;
  uploadedByUser: { id: string; name: string | null; image: string | null } | null;
};

function shapeSubtitle(subtitle: SubtitleRow, canManage: boolean) {
  return {
    id: subtitle.id,
    versionId: subtitle.versionId,
    language: subtitle.language,
    label: subtitle.label,
    url: subtitle.sourceUrl,
    sizeBytes: Number(subtitle.sizeBytes),
    createdAt: subtitle.createdAt,
    updatedAt: subtitle.updatedAt,
    uploadedByUser: subtitle.uploadedByUser,
    canDelete: canManage,
  };
}

const SUBTITLE_SELECT = {
  id: true,
  versionId: true,
  language: true,
  label: true,
  sourceUrl: true,
  sizeBytes: true,
  createdAt: true,
  updatedAt: true,
  uploadedByUser: { select: { id: true, name: true, image: true } },
} as const;

// GET /api/videos/[videoId]/subtitles?versionId=...
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'subtitle-list');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'VIEW');
    if (!context) return apiErrors.notFound('Video');
    if (!context.hasViewAccess) return apiErrors.forbidden('Access denied');

    const versionId = request.nextUrl.searchParams.get('versionId')?.trim() || null;

    const subtitles = await db.videoSubtitle.findMany({
      where: {
        version: {
          videoParentId: videoId,
          ...(versionId ? { id: versionId } : {}),
        },
      },
      orderBy: [{ language: 'asc' }],
      select: SUBTITLE_SELECT,
    });

    const response = successResponse({
      subtitles: subtitles.map((subtitle) => shapeSubtitle(subtitle, context.canManageAssets)),
      canManageSubtitles: context.canManageAssets,
    });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error listing subtitles:', error);
    return apiErrors.internalError('Failed to load subtitles');
  }
}

// POST /api/videos/[videoId]/subtitles
async function handlePost(request: NextRequest, { params }: RouteParams) {
  let reservationId: string | null = null;
  let billedUserId: string | null = null;
  let storedObjectKey: string | null = null;

  try {
    const contentLength = request.headers.get('content-length');
    if (!contentLength) {
      return apiErrors.badRequest('Missing Content-Length header');
    }
    const bodySize = Number.parseInt(contentLength, 10);
    if (!Number.isFinite(bodySize) || bodySize <= 0) {
      return apiErrors.badRequest('Invalid Content-Length header');
    }
    if (bodySize > MAX_MULTIPART_BODY_SIZE) {
      return apiErrors.badRequest('Subtitle file is too large. Maximum size is 2MB.');
    }

    const limited = await rateLimit(request, 'subtitle-create');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'VIEW');
    if (!context) return apiErrors.notFound('Video');
    // A subtitle is part of the delivered cut rather than a comment attachment, so it
    // takes the editor permission and never the commenter one. Guests and share-link
    // viewers can read the tracks but cannot add them.
    if (!context.viewerUserId || !context.canManageAssets) {
      return apiErrors.forbidden('Access denied');
    }

    const formData = await request.formData();
    const files = formData.getAll('subtitle');
    if (files.length !== 1 || !(files[0] instanceof File)) {
      return apiErrors.badRequest('No subtitle file provided');
    }
    const file = files[0];

    if (file.size > MAX_SUBTITLE_FILE_SIZE) {
      return apiErrors.badRequest('Subtitle file is too large. Maximum size is 2MB.');
    }
    if (!getSubtitleExtension(file.name)) {
      return apiErrors.badRequest('Subtitle must be a .srt or .vtt file');
    }

    const versionIdValue = formData.get('versionId');
    if (typeof versionIdValue !== 'string' || !versionIdValue.trim()) {
      return apiErrors.badRequest('versionId is required');
    }
    const versionId = versionIdValue.trim();

    const language = normalizeSubtitleLanguage(formData.get('language'));
    if (!language) {
      return apiErrors.badRequest('language must be a BCP-47 tag such as "tr" or "en-US"');
    }
    const label = sanitizeSubtitleLabel(formData.get('label'), language.toUpperCase());

    const version = await db.videoVersion.findFirst({
      where: { id: versionId, videoParentId: videoId },
      select: { id: true },
    });
    if (!version) return apiErrors.notFound('Version');

    const existing = await db.videoSubtitle.findUnique({
      where: { versionId_language: { versionId, language } },
      select: { id: true, sourceUrl: true },
    });

    if (!existing) {
      const trackCount = await db.videoSubtitle.count({ where: { versionId } });
      if (trackCount >= MAX_SUBTITLES_PER_VERSION) {
        return apiErrors.badRequest(
          `A version can hold at most ${MAX_SUBTITLES_PER_VERSION} subtitle tracks`
        );
      }
    }

    const normalized = normalizeSubtitleFile(new Uint8Array(await file.arrayBuffer()));
    if (!normalized.ok) {
      return apiErrors.badRequest(normalized.error);
    }

    const body = Buffer.from(normalized.vtt, 'utf8');
    const sizeBytes = BigInt(body.byteLength);

    billedUserId = context.video.project.workspace.ownerId;
    const reserveResult = await reserveStorageQuota(
      billedUserId,
      sizeBytes,
      UPLOAD_RESERVATION_PURPOSES.SUBTITLE
    );
    if ('error' in reserveResult) return reserveResult.error;
    reservationId = reserveResult.reservationId;

    const fileName = `${randomUUID()}.vtt`;
    const objectKey = `${SUBTITLE_OBJECT_KEY_PREFIX}${fileName}`;
    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: objectKey,
        Body: body,
        ContentType: SUBTITLE_CONTENT_TYPE,
      })
    );
    storedObjectKey = objectKey;

    const created = await db.$transaction(async (tx) => {
      if (existing) {
        await tx.videoSubtitle.delete({ where: { id: existing.id } });
      }
      return tx.videoSubtitle.create({
        data: {
          versionId,
          language,
          label,
          sourceUrl: subtitleFileNameToProxyUrl(fileName),
          sizeBytes,
          billedUserId: billedUserId as string,
          uploadedByUserId: context.viewerUserId,
        },
        select: SUBTITLE_SELECT,
      });
    });

    // The row is committed, so the bytes are counted by the usage sum and the hold that
    // stood in for them until now is no longer needed.
    await releaseStorageReservation(
      reservationId,
      billedUserId,
      UPLOAD_RESERVATION_PURPOSES.SUBTITLE
    );
    reservationId = null;
    storedObjectKey = null;

    if (existing) {
      // Best effort: the replaced track is already unreachable, and a stranded object is
      // a cleanup problem rather than a reason to fail an upload that succeeded.
      const staleKey = subtitleProxyPathToObjectKey(existing.sourceUrl);
      if (staleKey) {
        try {
          await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: staleKey }));
        } catch (deleteError) {
          logError('Failed to delete replaced subtitle object:', deleteError);
        }
      }
    }

    const response = successResponse(shapeSubtitle(created, true), 201);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    if (storedObjectKey) {
      try {
        await r2Client.send(
          new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: storedObjectKey })
        );
      } catch (cleanupError) {
        logError('Failed to clean up subtitle object after a failed upload:', cleanupError);
      }
    }
    await releaseStorageReservation(
      reservationId,
      billedUserId,
      UPLOAD_RESERVATION_PURPOSES.SUBTITLE
    );
    logError('Error uploading subtitle:', error);
    return apiErrors.internalError('Failed to upload subtitle');
  }
}

export const GET = withApiToken('read', handleGet);
export const POST = withApiToken('upload', handlePost);
