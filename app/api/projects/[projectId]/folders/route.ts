import { apiTokenScopeRefusal, getSession, withApiToken } from '@/lib/api-tokens';
import type { ApiTokenScope } from '@/lib/api-token-scopes';
import { NextRequest } from 'next/server';
import { randomBytes } from 'crypto';
import { revalidatePath } from 'next/cache';
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
import { isValidEmailAddress, normalizeEmail } from '@/lib/email-validation';
import { logError } from '@/lib/logger';
import {
  checkEditorAddition,
  editorLimitResponse,
  getWorkspaceOwnerId,
  type EditorAdditionResult,
} from '@/lib/editor-limit';

type RouteParams = { params: Promise<{ projectId: string }> };

class EditorLimitError extends Error {
  constructor(public result: Extract<EditorAdditionResult, { ok: false }>) {
    super(result.message);
  }
}

function failure(error: unknown) {
  if (error instanceof EditorLimitError) return editorLimitResponse(error.result);
  if (error instanceof ContentError) {
    if (error.status === 403) return apiErrors.forbidden(error.message);
    if (error.status === 409) return apiErrors.conflict(error.message);
    return apiErrors.badRequest(error.message);
  }
  logError('Content operation failed', error);
  return apiErrors.internalError('Content operation failed');
}

async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
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

// One POST does every folder job, so an API token is checked against the job it
// asked for: organising is `manage`, anything that decides who can see the
// content is `share`, and removing a folder is `delete`. Moving is both, since
// what moves takes on the access of where it lands.
const FOLDER_ACTION_SCOPES: Record<string, readonly ApiTokenScope[]> = {
  create: ['manage'],
  rename: ['manage'],
  move: ['manage', 'share'],
  moveVideos: ['manage', 'share'],
  members: ['share'],
  invite: ['share'],
  revokeMember: ['share'],
  revokeInvitation: ['share'],
  access: ['share'],
  delete: ['delete'],
};

async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;
    const session = await getSession();
    if (!session?.user?.id) return apiErrors.unauthorized();
    const userId = session.user.id;
    const { projectId } = await params;
    const body = await request.json();
    const folderId = contentId(body.folderId);
    const videoId = contentId(body.videoId);
    const action = body.action;
    // An action this map does not know is refused below anyway; asking for
    // `manage` keeps a token from learning anything more than a browser would.
    const requiredScopes = Object.prototype.hasOwnProperty.call(FOLDER_ACTION_SCOPES, action)
      ? FOLDER_ACTION_SCOPES[action]
      : (['manage'] as const);
    for (const scope of requiredScopes) {
      const scopeRefusal = apiTokenScopeRefusal(scope);
      if (scopeRefusal) return scopeRefusal;
    }
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
        const accessMode = 'video' in access ? access.video?.accessMode : access.folder?.accessMode;
        return { members, invitations, accessMode };
      }
      if (action === 'invite') {
        const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
        if (!isValidEmailAddress(email) || !['ADMIN', 'COMMENTATOR'].includes(body.role))
          throw new ContentError(400, 'Valid email and role required');
        if (body.role === 'ADMIN') {
          const ownerId = await getWorkspaceOwnerId({ projectId }, tx);
          if (ownerId) {
            const allowed = await checkEditorAddition({
              ownerId,
              actorUserId: userId,
              candidate: { email },
              client: tx,
            });
            if (!allowed.ok) throw new EditorLimitError(allowed);
          }
        }
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
        const linkCount = await tx.shareLink.count({
          where: videoId ? { videoId } : { video: { folderId: { in: subtree } } },
        });
        const accessMessage =
          body.accessMode === 'RESTRICTED'
            ? 'Account access is limited to invited members. Project and workspace managers retain access.'
            : 'Members with access to the parent can access this area.';
        const message =
          (action === 'access'
            ? accessMessage
            : 'Inherited content will use the destination’s access. Restricted content keeps its invited members.') +
          (linkCount > 0
            ? ` ${linkCount} existing video link${linkCount === 1 ? '' : 's'} will be revoked.`
            : '');
        const confirmation = await confirmContentChange(
          tx,
          [projectId],
          userId,
          operation,
          body.confirmationToken,
          message
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

export const GET = withApiToken('read', handleGet);
export const POST = withApiToken(['manage', 'share', 'delete'], handlePost);
