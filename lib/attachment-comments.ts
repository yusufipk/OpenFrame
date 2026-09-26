import type { Prisma } from '@prisma/client';
import type { AttachmentCommentTarget } from '@/lib/attachment-comment-target';

export async function lockAttachmentCommentVideo(
  client: Prisma.TransactionClient,
  videoId: string
): Promise<void> {
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`attachment-comments:${videoId}`}, 715))`;
}

export function parseAttachmentCommentTarget(value: unknown): AttachmentCommentTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || raw.id.length < 1 || raw.id.length > 128) return null;
  if (raw.type === 'asset' || raw.type === 'comment-audio') {
    if (raw.url !== undefined) return null;
    return { type: raw.type, id: raw.id };
  }
  if (
    raw.type === 'comment-image' &&
    typeof raw.url === 'string' &&
    raw.url.length > 0 &&
    raw.url.length <= 2048
  ) {
    return { type: 'comment-image', id: raw.id, url: raw.url };
  }
  return null;
}

export function attachmentCommentWhere(
  target: AttachmentCommentTarget
): Prisma.AttachmentCommentWhereInput {
  switch (target.type) {
    case 'asset':
      return { targetType: 'ASSET', assetId: target.id };
    case 'comment-image':
      return { targetType: 'COMMENT_IMAGE', sourceCommentId: target.id, sourceUrl: target.url };
    case 'comment-audio':
      return { targetType: 'COMMENT_AUDIO', sourceCommentId: target.id };
  }
}

export async function resolveAttachmentCommentTarget(
  client: Prisma.TransactionClient,
  videoId: string,
  target: AttachmentCommentTarget
): Promise<AttachmentCommentTarget | null> {
  if (target.type === 'asset') {
    const asset = await client.videoAsset.findFirst({
      where: { id: target.id, videoId },
      select: { kind: true, sourceUrl: true },
    });
    if (!asset) return null;
    if (!['IMAGE', 'AUDIO'].includes(asset.kind) || !asset.sourceUrl) return target;
    const canonical = await client.videoAsset.findFirst({
      where: { videoId, kind: asset.kind, sourceUrl: asset.sourceUrl },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return canonical ? { type: 'asset', id: canonical.id } : null;
  }

  const comment = await client.comment.findFirst({
    where: { id: target.id, version: { videoParentId: videoId } },
    select: {
      imageUrl: true,
      voiceUrl: true,
      images: { select: { url: true } },
    },
  });
  if (!comment) return null;
  const sourceUrl = target.type === 'comment-audio' ? comment.voiceUrl : target.url;
  if (!sourceUrl) return null;
  if (target.type === 'comment-image') {
    const attached =
      comment.images.length > 0
        ? comment.images.some((image) => image.url === target.url)
        : comment.imageUrl === target.url;
    if (!attached) return null;
  }

  const asset = await client.videoAsset.findFirst({
    where: { videoId, sourceUrl, kind: target.type === 'comment-image' ? 'IMAGE' : 'AUDIO' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return asset ? { type: 'asset', id: asset.id } : target;
}
