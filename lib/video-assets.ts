import type { NextRequest } from 'next/server';
import type { VideoAsset } from '@prisma/client';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { getGuestIdentityFromRequest } from '@/lib/guest-identity';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { validateShareLinkAccess } from '@/lib/share-links';

const IMAGE_PROXY_PREFIX = '/api/upload/image/';
const AUDIO_PROXY_PREFIX = '/api/upload/audio/';

export const SAFE_IMAGE_PROXY_PATH =
  /^\/api\/upload\/image\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;
export const SAFE_AUDIO_PROXY_PATH =
  /^\/api\/upload\/audio\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;
export const SAFE_BUNNY_VIDEO_ID = /^[A-Za-z0-9_-]{8,128}$/;

export type VideoAssetAccessContext = {
  video: {
    id: string;
    title: string;
    projectId: string;
    project: {
      id: string;
      name: string;
      ownerId: string;
      workspaceId: string;
      visibility: string;
      workspace: {
        id: string;
        ownerId: string;
      };
    };
  };
  hasViewAccess: boolean;
  canUploadAssets: boolean;
  canDownloadAssets: boolean;
  canManageAssets: boolean;
  viewerUserId: string | null;
  viewerGuestIdentityId: string | null;
};

export function sanitizeAssetDisplayName(
  value: string | null | undefined,
  fallback: string
): string {
  const raw = typeof value === 'string' ? value : '';
  const normalized = raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\[\]\(\)]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length === 0) return fallback;
  return normalized.slice(0, 200);
}

export function extractImageKeyFromProxyUrl(url: string): string | null {
  if (!SAFE_IMAGE_PROXY_PATH.test(url)) return null;
  const filename = url.slice(IMAGE_PROXY_PREFIX.length);
  if (!filename) return null;
  return `images/${filename}`;
}

export function extractImageFileNameFromProxyUrl(url: string): string | null {
  if (!SAFE_IMAGE_PROXY_PATH.test(url)) return null;
  const filename = url.slice(IMAGE_PROXY_PREFIX.length);
  return filename || null;
}

export function extractAudioKeyFromProxyUrl(url: string): string | null {
  if (!SAFE_AUDIO_PROXY_PATH.test(url)) return null;
  const filename = url.slice(AUDIO_PROXY_PREFIX.length);
  if (!filename) return null;
  return `voice/${filename}`;
}

export function extractAudioFileNameFromProxyUrl(url: string): string | null {
  if (!SAFE_AUDIO_PROXY_PATH.test(url)) return null;
  const filename = url.slice(AUDIO_PROXY_PREFIX.length);
  return filename || null;
}

export function mediaUrlToR2Key(url: string): string | null {
  if (url.includes(IMAGE_PROXY_PREFIX)) {
    const filename = url.slice(url.indexOf(IMAGE_PROXY_PREFIX) + IMAGE_PROXY_PREFIX.length);
    return filename ? `images/${filename}` : null;
  }
  if (url.includes(AUDIO_PROXY_PREFIX)) {
    const filename = url.slice(url.indexOf(AUDIO_PROXY_PREFIX) + AUDIO_PROXY_PREFIX.length);
    return filename ? `voice/${filename}` : null;
  }
  return null;
}

export function canDeleteAssetForViewer(
  asset: Pick<VideoAsset, 'uploadedByUserId' | 'uploadedByGuestIdentityId'>,
  viewer: Pick<
    VideoAssetAccessContext,
    'canManageAssets' | 'viewerUserId' | 'viewerGuestIdentityId'
  >
): boolean {
  if (viewer.canManageAssets) return true;
  if (viewer.viewerUserId && asset.uploadedByUserId === viewer.viewerUserId) return true;
  if (
    !viewer.viewerUserId &&
    viewer.viewerGuestIdentityId &&
    asset.uploadedByGuestIdentityId &&
    asset.uploadedByGuestIdentityId === viewer.viewerGuestIdentityId
  ) {
    return true;
  }
  return false;
}

export async function getVideoAssetAccessContext(
  request: NextRequest,
  videoId: string,
  requiredPermission: 'VIEW' | 'COMMENT' = 'VIEW'
): Promise<VideoAssetAccessContext | null> {
  const session = await auth();
  const video = await db.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      title: true,
      projectId: true,
      project: {
        select: {
          id: true,
          name: true,
          ownerId: true,
          workspaceId: true,
          visibility: true,
          workspace: {
            select: {
              id: true,
              ownerId: true,
            },
          },
        },
      },
    },
  });

  if (!video) return null;

  const access = await checkProjectAccess(video.project, session?.user?.id);
  const shareSession = getShareSessionFromRequest(request, video.id);
  const shareAccess = shareSession
    ? await validateShareLinkAccess({
        token: shareSession.token,
        projectId: video.projectId,
        videoId: video.id,
        requiredPermission,
        passwordVerified: shareSession.passwordVerified,
      })
    : {
        hasAccess: false,
        canComment: false,
        canDownload: false,
        allowGuests: false,
        requiresPassword: false,
        link: null,
      };

  const hasViewAccess = access.hasAccess || shareAccess.hasAccess;
  const canCommentWithMembership = !!session?.user?.id && access.hasAccess;
  const canCommentWithShare =
    shareAccess.canComment && (session?.user?.id ? true : shareAccess.allowGuests);
  const canUploadAssets = canCommentWithMembership || canCommentWithShare;
  const canDownloadAssets = !!session?.user?.id && hasViewAccess;

  const viewerUserId = session?.user?.id ?? null;
  const viewerGuestIdentityId = viewerUserId ? null : getGuestIdentityFromRequest(request);

  return {
    video,
    hasViewAccess,
    canUploadAssets,
    canDownloadAssets,
    canManageAssets: access.canEdit,
    viewerUserId,
    viewerGuestIdentityId,
  };
}
