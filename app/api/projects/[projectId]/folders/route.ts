import { NextRequest } from 'next/server';
import { randomBytes } from 'crypto';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { checkFolderAccess, checkVideoAccess, visibleFolderWhere } from '@/lib/content-access';
import {
  ContentError,
  contentId,
  contentName,
  contentTransaction,
  confirmContentChange,
  folderSubtree,
  moveContentVideos,
} from '@/lib/content-mutations';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { buildInvitationUrl } from '@/lib/invitations';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string }> };
function failure(error: unknown) {
  if (error instanceof ContentError) {
    if (error.status === 403) return apiErrors.forbidden(error.message);
    if (error.status === 409) return apiErrors.conflict(error.message);
    return apiErrors.badRequest(error.message);
  }
  logError('Content operation failed', error);
  return apiErrors.internalError('Content operation failed');
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    const { projectId } = await params;
    const folders = await db.projectFolder.findMany({
      where: { projectId, AND: visibleFolderWhere(session.user.id) },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, parentId: true, accessMode: true },
    });
    const visibleIds = new Set(folders.map((f) => f.id));
    const manageable = await db.projectFolder.findMany({
      where: { projectId, AND: visibleFolderWhere(session.user.id, true) },
      select: { id: true },
    });
    const manageableIds = new Set(manageable.map((f) => f.id));
    return withCacheControl(
      successResponse({
        folders: folders.map((f) => ({
          ...f,
          parentId: f.parentId && visibleIds.has(f.parentId) ? f.parentId : null,
          canEdit: manageableIds.has(f.id),
        })),
      }),
      'private, no-store'
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    const userId = session.user.id;
    const { projectId } = await params;
    const body = await request.json();
    const folderId = contentId(body.folderId);
    const videoId = contentId(body.videoId);
    const action = body.action;
    if (action === 'moveVideos') {
      if (
        !Array.isArray(body.videoIds) ||
        body.videoIds.length < 1 ||
        body.videoIds.length > 50 ||
        !body.videoIds.every((id: unknown) => typeof id === 'string' && id.length > 0)
      )
        throw new ContentError(400, 'Select 1 to 50 videos');
      const result = await moveContentVideos({
        projectId,
        targetProjectId: contentId(body.targetProjectId) ?? projectId,
        folderId,
        videoIds: [...new Set<string>(body.videoIds)],
        userId,
        confirmationToken: body.confirmationToken,
      });
      revalidatePath(`/projects/${projectId}`);
      return withCacheControl(successResponse(result), 'private, no-store');
    }
    const result = await contentTransaction([projectId], async (tx) => {
      const access = videoId
        ? await checkVideoAccess(videoId, userId, tx)
        : await checkFolderAccess(projectId, folderId, userId, tx);
      if (
        !access?.canEdit ||
        (videoId && (!('video' in access) || access.video?.projectId !== projectId))
      )
        throw new ContentError(403, 'Management access required');
      if (action === 'create') {
        if (videoId) throw new ContentError(400, 'A video cannot contain a folder');
        return tx.projectFolder.create({
          data: { projectId, parentId: folderId, name: contentName(body.name) },
        });
      }
      if (!folderId && !videoId) throw new ContentError(400, 'Select a folder or video');
      if (action === 'members') {
        const members = videoId
          ? await tx.videoMember.findMany({
              where: { videoId },
              include: { user: { select: { name: true, email: true } } },
            })
          : await tx.projectFolderMember.findMany({
              where: { folderId: folderId! },
              include: { user: { select: { name: true, email: true } } },
            });
        const invitations = await tx.invitation.findMany({
          where: {
            projectId,
            folderId: videoId ? null : folderId,
            videoId,
            status: 'PENDING',
            expiresAt: { gt: new Date() },
          },
          select: { id: true, email: true, role: true },
        });
        return { members, invitations };
      }
      if (action === 'invite') {
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          email.length > 254 ||
          !['ADMIN', 'COMMENTATOR'].includes(body.role)
        )
          throw new ContentError(400, 'Valid email and role required');
        const target = {
          projectId,
          folderId: videoId ? null : folderId,
          videoId,
          scope: videoId ? ('VIDEO' as const) : ('FOLDER' as const),
        };
        await tx.invitation.updateMany({
          where: { ...target, email, status: 'PENDING' },
          data: { status: 'CANCELED' },
        });
        const invitation = await tx.invitation.create({
          data: {
            ...target,
            email,
            role: body.role,
            invitedById: userId,
            token: randomBytes(32).toString('hex'),
            expiresAt: new Date(Date.now() + 7 * 86400000),
          },
        });
        return { invitationUrl: buildInvitationUrl(invitation.token) };
      }
      if (action === 'revokeMember') {
        const memberId = contentId(body.memberId);
        if (!memberId) throw new ContentError(400, 'Member required');
        if (videoId) await tx.videoMember.deleteMany({ where: { id: memberId, videoId } });
        else
          await tx.projectFolderMember.deleteMany({ where: { id: memberId, folderId: folderId! } });
        return { removed: true };
      }
      if (action === 'revokeInvitation') {
        await tx.invitation.updateMany({
          where: {
            id: contentId(body.invitationId) ?? '',
            projectId,
            folderId: videoId ? null : folderId,
            videoId,
          },
          data: { status: 'CANCELED' },
        });
        return { removed: true };
      }
      if (action === 'rename' && folderId && !videoId)
        return tx.projectFolder.update({
          where: { id: folderId },
          data: { name: contentName(body.name) },
        });
      if (action === 'delete' && folderId && !videoId) {
        const [children, videos] = await Promise.all([
          tx.projectFolder.count({ where: { parentId: folderId } }),
          tx.video.count({ where: { folderId } }),
        ]);
        if (children || videos) throw new ContentError(409, 'Only empty folders can be deleted');
        await tx.projectFolder.delete({ where: { id: folderId } });
        return { deleted: true };
      }
      if (action === 'access' || (action === 'move' && folderId && !videoId)) {
        if (action === 'access' && !['INHERIT', 'RESTRICTED'].includes(body.accessMode))
          throw new ContentError(400, 'Invalid access mode');
        const parentId = contentId(body.parentId);
        const subtree = folderId ? await folderSubtree(tx, projectId, folderId) : [];
        if (action === 'move') {
          if (parentId && subtree.includes(parentId))
            throw new ContentError(400, 'A folder cannot move into itself or its descendants');
          const destination = await checkFolderAccess(projectId, parentId, userId, tx);
          if (!destination?.canEdit)
            throw new ContentError(403, 'Destination management access required');
        }
        const operation = { action, folderId, videoId, parentId, accessMode: body.accessMode };
        const confirmation = await confirmContentChange(
          tx,
          [projectId],
          userId,
          operation,
          body.confirmationToken,
          'Inherited content will use its new parent access. Restricted content keeps its own direct members. A restriction cuts off normal parent members. Project and workspace managers retain access. Existing video links in the affected area will be revoked; create new links separately if needed.'
        );
        if (confirmation) return confirmation;
        await tx.shareLink.deleteMany({
          where: videoId ? { videoId } : { video: { folderId: { in: subtree } } },
        });
        if (videoId)
          return tx.video.update({ where: { id: videoId }, data: { accessMode: body.accessMode } });
        return tx.projectFolder.update({
          where: { id: folderId! },
          data: action === 'access' ? { accessMode: body.accessMode } : { parentId },
        });
      }
      throw new ContentError(400, 'Unknown folder operation');
    });
    revalidatePath(`/projects/${projectId}`);
    revalidatePath('/shared');
    return withCacheControl(successResponse(result), 'private, no-store');
  } catch (error) {
    return failure(error);
  }
}
