import type { Prisma } from '@prisma/client';
import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import {
  attachmentCommentTargetKey,
  type AttachmentCommentTarget,
} from '@/lib/attachment-comment-target';
import {
  attachmentCommentWhere,
  lockAttachmentCommentVideo,
  parseAttachmentCommentTarget,
  resolveAttachmentCommentTarget,
} from '@/lib/attachment-comments';
import { checkVideoAccess } from '@/lib/content-access';
import { db } from '@/lib/db';
import {
  ensureGuestIdentityFromRequest,
  getGuestIdentityFromRequest,
  setGuestIdentityCookie,
} from '@/lib/guest-identity';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { validateShareLinkAccess } from '@/lib/share-links';
import { validateAnnotationStrokes } from '@/lib/validation';

type RouteParams = { params: Promise<{ videoId: string }> };

function parsePageNumber(value: string | null, fallback: number, max: number): number | null {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : null;
}

function targetFromQuery(params: URLSearchParams): AttachmentCommentTarget | null {
  return parseAttachmentCommentTarget({
    type: params.get('targetType'),
    id: params.get('targetId'),
    ...(params.has('imageUrl') ? { url: params.get('imageUrl') } : {}),
  });
}

async function sharePermissionStillValid(
  tx: Prisma.TransactionClient,
  token: string | null,
  projectId: string,
  videoId: string,
  passwordVerified: boolean,
  isGuest: boolean
): Promise<boolean> {
  if (!token) return false;
  const link = await tx.shareLink.findUnique({
    where: { token },
    select: {
      projectId: true,
      videoId: true,
      permission: true,
      allowGuests: true,
      expiresAt: true,
      passwordHash: true,
    },
  });
  return Boolean(
    link &&
    link.projectId === projectId &&
    link.videoId === videoId &&
    link.permission === 'COMMENT' &&
    (!link.expiresAt || link.expiresAt.getTime() > Date.now()) &&
    (!link.passwordHash || passwordVerified) &&
    (!isGuest || link.allowGuests)
  );
}

function serializeComment(
  comment: {
    id: string;
    content: string;
    annotationData: string | null;
    createdAt: Date;
    authorId: string | null;
    author: { id: string; name: string | null; image: string | null } | null;
    guestName: string | null;
    guestIdentityId: string | null;
  },
  userId: string | undefined,
  guestIdentityId: string | null,
  canManage: boolean,
  canDeleteOwn: boolean
) {
  return {
    id: comment.id,
    content: comment.content,
    annotationData: comment.annotationData,
    createdAt: comment.createdAt,
    author: comment.author,
    guestName: comment.guestName,
    canDelete:
      canManage ||
      Boolean(canDeleteOwn && userId && comment.authorId === userId) ||
      Boolean(
        !userId && canDeleteOwn && guestIdentityId && comment.guestIdentityId === guestIdentityId
      ),
  };
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { videoId } = await params;
    const userId = (await auth())?.user?.id;
    const video = await db.video.findUnique({
      where: { id: videoId },
      select: { id: true, projectId: true },
    });
    if (!video) return apiErrors.notFound('Video');

    const direct = await checkVideoAccess(videoId, userId);
    const shareSession = getShareSessionFromRequest(request, videoId);
    const shared = shareSession
      ? await validateShareLinkAccess({
          token: shareSession.token,
          projectId: video.projectId,
          videoId,
          requiredPermission: 'VIEW',
          passwordVerified: shareSession.passwordVerified,
        })
      : null;
    if (!direct.hasAccess && !shared?.hasAccess) return apiErrors.forbidden('Access denied');
    const canComment =
      direct.hasAccess || Boolean(shared?.canComment && (userId || shared.allowGuests));

    const query = new URL(request.url).searchParams;
    if (query.get('counts') === 'true') {
      const versionId = query.get('versionId');
      if (!versionId || versionId.length > 128)
        return apiErrors.badRequest('Valid versionId is required');
      const version = await db.videoVersion.findFirst({
        where: { id: versionId, videoParentId: videoId },
        select: { id: true },
      });
      if (!version) return apiErrors.notFound('Version');
      const [assets, comments] = await Promise.all([
        db.videoAsset.findMany({
          where: { videoId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, sourceUrl: true, kind: true },
        }),
        db.comment.findMany({
          where: { versionId },
          select: { id: true, imageUrl: true, voiceUrl: true, images: { select: { url: true } } },
        }),
      ]);
      const allowed = new Set<string>();
      const assetBySource = new Map<string, string>();
      const aliases = new Map<string, string>();
      for (const asset of assets) {
        const key = attachmentCommentTargetKey({ type: 'asset', id: asset.id });
        if (!['IMAGE', 'AUDIO'].includes(asset.kind) || !asset.sourceUrl) {
          allowed.add(key);
          continue;
        }
        const sourceKey = `${asset.kind}:${asset.sourceUrl}`;
        const canonicalId = assetBySource.get(sourceKey);
        if (canonicalId) {
          aliases.set(key, attachmentCommentTargetKey({ type: 'asset', id: canonicalId }));
        } else {
          assetBySource.set(sourceKey, asset.id);
          allowed.add(key);
        }
      }
      for (const comment of comments) {
        const urls = comment.images.length
          ? comment.images.map((image) => image.url)
          : comment.imageUrl
            ? [comment.imageUrl]
            : [];
        for (const url of urls) {
          const key = attachmentCommentTargetKey({ type: 'comment-image', id: comment.id, url });
          const assetId = assetBySource.get(`IMAGE:${url}`);
          if (assetId) aliases.set(key, attachmentCommentTargetKey({ type: 'asset', id: assetId }));
          else allowed.add(key);
        }
        if (comment.voiceUrl) {
          const key = attachmentCommentTargetKey({ type: 'comment-audio', id: comment.id });
          const assetId = assetBySource.get(`AUDIO:${comment.voiceUrl}`);
          if (assetId) aliases.set(key, attachmentCommentTargetKey({ type: 'asset', id: assetId }));
          else allowed.add(key);
        }
      }
      if (assets.length === 0 && comments.length === 0) {
        return withCacheControl(successResponse({ counts: {} }), 'private, no-store');
      }
      const rows = await db.attachmentComment.groupBy({
        by: ['targetType', 'assetId', 'sourceCommentId', 'sourceUrl'],
        where: {
          OR: [
            ...(assets.length ? [{ assetId: { in: assets.map((asset) => asset.id) } }] : []),
            ...(comments.length
              ? [{ sourceCommentId: { in: comments.map((comment) => comment.id) } }]
              : []),
          ],
        },
        _count: { _all: true },
      });
      const counts: Record<string, number> = {};
      for (const row of rows) {
        const key =
          row.targetType === 'ASSET'
            ? attachmentCommentTargetKey({ type: 'asset', id: row.assetId! })
            : row.targetType === 'COMMENT_IMAGE'
              ? attachmentCommentTargetKey({
                  type: 'comment-image',
                  id: row.sourceCommentId!,
                  url: row.sourceUrl!,
                })
              : attachmentCommentTargetKey({ type: 'comment-audio', id: row.sourceCommentId! });
        if (allowed.has(key)) counts[key] = row._count._all;
      }
      for (const [alias, canonical] of aliases) counts[alias] = counts[canonical] ?? 0;
      return withCacheControl(successResponse({ counts }), 'private, no-store');
    }

    const target = targetFromQuery(query);
    if (!target) return apiErrors.badRequest('Invalid attachment target');
    const canonicalTarget = await resolveAttachmentCommentTarget(db, videoId, target);
    if (!canonicalTarget) return apiErrors.notFound('Attachment');
    const offset = parsePageNumber(query.get('offset'), 0, 50000);
    const limit = parsePageNumber(query.get('limit'), 30, 100);
    if (offset === null || limit === null || limit === 0)
      return apiErrors.badRequest('Invalid pagination');
    const where = attachmentCommentWhere(canonicalTarget);
    const [total, comments] = await Promise.all([
      db.attachmentComment.count({ where }),
      db.attachmentComment.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: offset,
        take: limit,
        select: {
          id: true,
          content: true,
          annotationData: true,
          createdAt: true,
          authorId: true,
          guestName: true,
          guestIdentityId: true,
          author: { select: { id: true, name: true, image: true } },
        },
      }),
    ]);
    const guestIdentityId = userId ? null : getGuestIdentityFromRequest(request);
    const response = successResponse({
      comments: comments.map((comment) =>
        serializeComment(comment, userId, guestIdentityId, direct.canEdit, canComment)
      ),
      total,
      hasMore: offset + comments.length < total,
      canComment,
    });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error fetching attachment comments:', error);
    return apiErrors.internalError('Failed to fetch attachment comments');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'comment');
    if (limited) return limited;
    const { videoId } = await params;
    const userId = (await auth())?.user?.id;
    const video = await db.video.findUnique({
      where: { id: videoId },
      select: { id: true, projectId: true },
    });
    if (!video) return apiErrors.notFound('Video');
    const direct = await checkVideoAccess(videoId, userId);
    const shareSession = getShareSessionFromRequest(request, videoId);
    const shared = shareSession
      ? await validateShareLinkAccess({
          token: shareSession.token,
          projectId: video.projectId,
          videoId,
          requiredPermission: 'COMMENT',
          passwordVerified: shareSession.passwordVerified,
        })
      : null;
    if (!direct.hasAccess && !shared?.canComment) return apiErrors.forbidden('Access denied');
    if (!userId && !direct.hasAccess && !shared?.allowGuests)
      return apiErrors.forbidden('Sign in required to comment');

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return apiErrors.badRequest('Invalid request body');
    const target = parseAttachmentCommentTarget(body.target);
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!target) return apiErrors.badRequest('Invalid attachment target');
    if (typeof body.content !== 'string' || body.content.length > 10000)
      return apiErrors.badRequest('Comment content must be 0 to 10,000 characters');
    let annotationData: string | null = null;
    if (body.annotationData !== undefined && body.annotationData !== null) {
      if (!Array.isArray(body.annotationData)) {
        return apiErrors.badRequest('annotationData must be an array of valid stroke objects');
      }
      const strokes = validateAnnotationStrokes(body.annotationData);
      if (strokes === null || strokes.some((stroke) => stroke.points.length < 2)) {
        return apiErrors.badRequest('annotationData must be an array of valid stroke objects');
      }
      annotationData = strokes.length ? JSON.stringify(strokes) : null;
      if (!content && !annotationData) {
        return apiErrors.badRequest('Comment content or drawing is required');
      }
    } else if (!content) {
      return apiErrors.badRequest('Comment content or drawing is required');
    }
    const guestName = typeof body.guestName === 'string' ? body.guestName.trim() : '';
    if (!userId && (!guestName || guestName.length > 100))
      return apiErrors.badRequest('Guest name must be 1 to 100 characters');
    const guestIdentity = userId ? null : ensureGuestIdentityFromRequest(request);

    const result = await db.$transaction(async (tx) => {
      await lockAttachmentCommentVideo(tx, videoId);
      const freshVideo = await tx.video.findUnique({
        where: { id: videoId },
        select: { projectId: true },
      });
      if (!freshVideo || freshVideo.projectId !== video.projectId)
        return { status: 'forbidden' } as const;
      const freshDirect = await checkVideoAccess(videoId, userId, tx);
      const freshShare = await sharePermissionStillValid(
        tx,
        shareSession?.token ?? null,
        video.projectId,
        videoId,
        shareSession?.passwordVerified ?? false,
        !userId
      );
      if (!freshDirect.hasAccess && !(freshShare && freshDirect.ownerBillingActive))
        return { status: 'forbidden' } as const;
      if (target.type !== 'asset') {
        await tx.$queryRaw`SELECT id FROM comments WHERE id = ${target.id} FOR UPDATE`;
      }
      const canonicalTarget = await resolveAttachmentCommentTarget(tx, videoId, target);
      if (!canonicalTarget) return { status: 'notfound' } as const;
      if (annotationData && canonicalTarget.type !== 'comment-image') {
        if (canonicalTarget.type !== 'asset') return { status: 'invalidAnnotationTarget' } as const;
        const asset = await tx.videoAsset.findUnique({
          where: { id: canonicalTarget.id },
          select: { kind: true },
        });
        if (asset?.kind !== 'IMAGE') return { status: 'invalidAnnotationTarget' } as const;
      }
      const comment = await tx.attachmentComment.create({
        data: {
          targetType:
            canonicalTarget.type === 'asset'
              ? 'ASSET'
              : canonicalTarget.type === 'comment-image'
                ? 'COMMENT_IMAGE'
                : 'COMMENT_AUDIO',
          assetId: canonicalTarget.type === 'asset' ? canonicalTarget.id : null,
          sourceCommentId: canonicalTarget.type === 'asset' ? null : canonicalTarget.id,
          sourceUrl: canonicalTarget.type === 'comment-image' ? canonicalTarget.url : null,
          content,
          annotationData,
          authorId: userId ?? null,
          guestName: userId ? null : guestName,
          guestIdentityId: userId ? null : (guestIdentity?.identityId ?? null),
        },
        select: {
          id: true,
          content: true,
          annotationData: true,
          createdAt: true,
          authorId: true,
          guestName: true,
          guestIdentityId: true,
          author: { select: { id: true, name: true, image: true } },
        },
      });
      return { status: 'created', comment, canManage: freshDirect.canEdit } as const;
    });
    if (result.status === 'forbidden') return apiErrors.forbidden('Access denied');
    if (result.status === 'notfound') return apiErrors.notFound('Attachment');
    if (result.status === 'invalidAnnotationTarget')
      return apiErrors.badRequest('Annotations require an image attachment');
    const response = successResponse(
      {
        comment: serializeComment(
          result.comment,
          userId,
          guestIdentity?.identityId ?? null,
          result.canManage,
          true
        ),
      },
      201
    );
    if (guestIdentity?.shouldSetCookie) setGuestIdentityCookie(response, guestIdentity.identityId);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error creating attachment comment:', error);
    return apiErrors.internalError('Failed to create attachment comment');
  }
}
