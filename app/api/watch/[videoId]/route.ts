import { checkVideoAccess } from '@/lib/content-access';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { canDownloadProjectMedia } from '@/lib/project-download';
import { getGuestIdentityFromRequest } from '@/lib/guest-identity';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ videoId: string }> };

// GET /api/watch/[videoId] - Public watch endpoint (no projectId needed)
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    // Rate limit: 60 requests per minute per IP for public watch endpoint
    const limited = await rateLimit(request, 'watch', { windowMs: 60 * 1000, maxRequests: 60 });
    if (limited) return limited;

    const session = await auth();
    const { videoId } = await params;

    // Parse query params
    const searchParams = request.nextUrl.searchParams;
    const includeComments = searchParams.get('includeComments') === 'true';

    const video = await db.video.findUnique({
      where: { id: videoId },
      include: {
        project: true,
        versions: {
          orderBy: { versionNumber: 'desc' },
          ...(includeComments
            ? {
                include: {
                  comments: {
                    orderBy: { timestamp: 'asc' },
                    where: { parentId: null },
                    select: {
                      id: true,
                      content: true,
                      timestamp: true,
                      timestampEnd: true,
                      createdAt: true,
                      updatedAt: true,
                      isResolved: true,
                      resolvedAt: true,
                      voiceUrl: true,
                      voiceDuration: true,
                      imageUrl: true,
                      images: { select: { id: true, url: true }, orderBy: { position: 'asc' } },
                      annotationData: true,
                      parentId: true,
                      authorId: true,
                      guestIdentityId: true,
                      tagId: true,
                      versionId: true,
                      guestName: true,
                      author: { select: { id: true, name: true, image: true } },
                      tag: { select: { id: true, name: true, color: true } },
                      replies: {
                        orderBy: { createdAt: 'asc' },
                        select: {
                          id: true,
                          content: true,
                          timestamp: true,
                          timestampEnd: true,
                          createdAt: true,
                          updatedAt: true,
                          isResolved: true,
                          resolvedAt: true,
                          voiceUrl: true,
                          voiceDuration: true,
                          imageUrl: true,
                          images: { select: { id: true, url: true }, orderBy: { position: 'asc' } },
                          annotationData: true,
                          parentId: true,
                          authorId: true,
                          guestIdentityId: true,
                          tagId: true,
                          versionId: true,
                          guestName: true,
                          author: { select: { id: true, name: true, image: true } },
                          tag: { select: { id: true, name: true, color: true } },
                        },
                      },
                    },
                  },
                  _count: { select: { comments: true } },
                },
              }
            : {
                select: {
                  id: true,
                  thumbnailUrl: true,
                  duration: true,
                  versionNumber: true,
                  versionLabel: true,
                  providerId: true,
                  videoId: true,
                  originalUrl: true,
                  title: true,
                  isActive: true,
                  _count: { select: { comments: true } },
                },
              }),
        },
      },
    });

    if (!video) {
      return apiErrors.notFound('Video');
    }

    // Check access including workspace membership
    const access = await checkVideoAccess(video.id, session?.user?.id);
    const shareSession = getShareSessionFromRequest(request, video.id);
    const shareAccess = shareSession
      ? await validateShareLinkAccess({
          token: shareSession.token,
          projectId: video.projectId,
          videoId: video.id,
          requiredPermission: 'VIEW',
          passwordVerified: shareSession.passwordVerified,
        })
      : {
          hasAccess: false,
          canComment: false,
          canDownload: false,
          allowGuests: false,
          requiresPassword: false,
        };

    if (!access.hasAccess && !shareAccess.hasAccess) {
      return apiErrors.forbidden('Access denied');
    }

    // Include auth context so the client knows if the viewer is a guest
    const { project, ...videoData } = video;
    const viewerUserId = session?.user?.id ?? null;
    const viewerGuestIdentityId = viewerUserId ? null : getGuestIdentityFromRequest(request);
    const isProjectOwner = viewerUserId === project.ownerId;

    const versions = videoData.versions.map((version) => {
      if (!('comments' in version)) {
        return version;
      }

      return {
        ...version,
        comments: version.comments.map((comment) => {
          const canEditComment = viewerUserId
            ? comment.authorId === viewerUserId
            : !!viewerGuestIdentityId &&
              !!comment.guestIdentityId &&
              comment.guestIdentityId === viewerGuestIdentityId;
          const canDeleteComment = canEditComment || isProjectOwner;
          const replies = comment.replies;
          const commentData = Object.fromEntries(
            Object.entries(comment).filter(
              ([key]) => key !== 'authorId' && key !== 'guestIdentityId' && key !== 'replies'
            )
          );

          return {
            ...commentData,
            canEdit: canEditComment,
            canDelete: canDeleteComment,
            replies: replies.map((reply) => {
              const canEditReply = viewerUserId
                ? reply.authorId === viewerUserId
                : !!viewerGuestIdentityId &&
                  !!reply.guestIdentityId &&
                  reply.guestIdentityId === viewerGuestIdentityId;
              const canDeleteReply = canEditReply || isProjectOwner;
              const replyData = Object.fromEntries(
                Object.entries(reply).filter(
                  ([key]) => key !== 'authorId' && key !== 'guestIdentityId'
                )
              );
              return {
                ...replyData,
                canEdit: canEditReply,
                canDelete: canDeleteReply,
              };
            }),
          };
        }),
      };
    });

    const canCommentWithMembership = access.hasAccess;
    const canCommentWithShareLink =
      shareAccess.canComment && (session?.user?.id ? true : shareAccess.allowGuests);
    const canDownloadWithMembership = canDownloadProjectMedia(video.project, access);
    const canDownloadWithShareLink = shareAccess.hasAccess && shareAccess.canDownload;
    const canUploadAssets = canCommentWithMembership || canCommentWithShareLink;
    const canDownloadAssets =
      (access.hasAccess || shareAccess.hasAccess) &&
      (canDownloadWithMembership || canDownloadWithShareLink);
    const response = successResponse({
      ...videoData,
      versions,
      projectId: video.projectId,
      project: {
        name: access.hasProjectAccess ? project.name : 'Shared video',
        ownerId: access.hasProjectAccess ? project.ownerId : null,
        visibility: project.visibility,
        allowDownloads: project.allowDownloads,
      },
      isAuthenticated: !!session?.user?.id,
      currentUserId: session?.user?.id || null,
      currentUserName: session?.user?.name || null,
      canComment: canCommentWithMembership || canCommentWithShareLink,
      canDownload: canDownloadWithMembership || canDownloadWithShareLink,
      canManageTags: access.canManageProject,
      canResolveComments: access.canEdit,
      canShareVideo: access.canEdit,
      canUploadAssets,
      canDownloadAssets,
    });

    return withCacheControl(response, 'private, no-cache');
  } catch (error) {
    logError('Error fetching video:', error);
    return apiErrors.internalError('Failed to fetch video');
  }
}
