import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth';
import { buildBillingAccessWhereInput } from '@/lib/billing';

export type ContentClient = Prisma.TransactionClient;
export type ContentRole = 'ADMIN' | 'COMMENTATOR';
export type ContentMode = 'INHERIT' | 'RESTRICTED';
export const MAX_FOLDER_DEPTH = 10;

function projectAudience(
  userId?: string,
  manage = false,
  includePublic = true
): Prisma.ProjectWhereInput {
  return {
    workspace: { owner: buildBillingAccessWhereInput() },
    OR: [
      ...(!manage && includePublic ? [{ visibility: 'PUBLIC' as const }] : []),
      ...(userId
        ? [
            { ownerId: userId },
            { members: { some: { userId, ...(manage ? { role: 'ADMIN' as const } : {}) } } },
            { workspace: { ownerId: userId } },
            {
              workspace: {
                members: { some: { userId, ...(manage ? { role: 'ADMIN' as const } : {}) } },
              },
            },
          ]
        : []),
    ],
  };
}

function folderAudience(
  userId: string | undefined,
  manage: boolean,
  depth: number,
  includePublic = true
): Prisma.ProjectFolderWhereInput {
  if (depth <= 0) return { id: { in: [] } };
  return {
    OR: [
      ...(userId
        ? [{ members: { some: { userId, ...(manage ? { role: 'ADMIN' as const } : {}) } } }]
        : []),
      {
        accessMode: 'INHERIT',
        OR: [
          { parentId: null, project: projectAudience(userId, manage, includePublic) },
          { parent: folderAudience(userId, manage, depth - 1, includePublic) },
        ],
      },
    ],
  };
}

/** Filters before pagination, counts and metadata selection. No per-video query loop. */
export function visibleVideoWhere(
  userId?: string,
  manage = false,
  includePublic = true
): Prisma.VideoWhereInput {
  return {
    project: { workspace: { owner: buildBillingAccessWhereInput() } },
    OR: [
      { project: projectAudience(userId, true) },
      ...(userId
        ? [{ members: { some: { userId, ...(manage ? { role: 'ADMIN' as const } : {}) } } }]
        : []),
      {
        accessMode: 'INHERIT',
        OR: [
          { folderId: null, project: projectAudience(userId, manage, includePublic) },
          { folder: folderAudience(userId, manage, MAX_FOLDER_DEPTH, includePublic) },
        ],
      },
    ],
  };
}

export function visibleFolderWhere(
  userId?: string,
  manage = false
): Prisma.ProjectFolderWhereInput {
  return {
    project: { workspace: { owner: buildBillingAccessWhereInput() } },
    OR: [
      { project: projectAudience(userId, true) },
      folderAudience(userId, manage, MAX_FOLDER_DEPTH),
    ],
  };
}

export async function checkVideoAccess(
  videoId: string,
  userId?: string,
  client: ContentClient = db
) {
  const video = await client.video.findUnique({
    where: { id: videoId },
    include: { project: true },
  });
  if (!video)
    return {
      isOwner: false,
      isProjectMember: false,
      isProjectAdmin: false,
      isWorkspaceMember: false,
      isWorkspaceAdmin: false,
      hasAccess: false,
      canEdit: false,
      canDelete: false,
      ownerBillingActive: false,
      hasProjectAccess: false,
      canManageProject: false,
      video: null,
    };
  const access = await checkProjectAccess(video.project, userId, client);
  if (access.canEdit)
    return {
      ...access,
      hasProjectAccess: access.hasAccess,
      canManageProject: access.canEdit,
      video,
    };
  const [visible, editable] = await Promise.all([
    client.video.count({ where: { id: videoId, AND: visibleVideoWhere(userId) } }),
    userId
      ? client.video.count({ where: { id: videoId, AND: visibleVideoWhere(userId, true) } })
      : 0,
  ]);
  return {
    ...access,
    hasProjectAccess: access.hasAccess,
    canManageProject: access.canEdit,
    hasAccess: visible > 0,
    canEdit: editable > 0,
    canDelete: editable > 0,
    video,
  };
}

export async function checkFolderAccess(
  projectId: string,
  folderId: string | null,
  userId?: string,
  client: ContentClient = db
) {
  const project = await client.project.findUnique({ where: { id: projectId } });
  if (!project) return null;
  const access = await checkProjectAccess(project, userId, client);
  if (!folderId) return { ...access, project, folder: null };
  const folder = await client.projectFolder.findFirst({ where: { id: folderId, projectId } });
  if (!folder) return null;
  if (access.canEdit) return { ...access, project, folder };
  const [visible, editable] = await Promise.all([
    client.projectFolder.count({ where: { id: folderId, AND: visibleFolderWhere(userId) } }),
    userId
      ? client.projectFolder.count({
          where: { id: folderId, AND: visibleFolderWhere(userId, true) },
        })
      : 0,
  ]);
  return {
    ...access,
    hasAccess: visible > 0,
    canEdit: editable > 0,
    canDelete: editable > 0,
    project,
    folder,
  };
}

/** Used only for the guest link boundary, never as a substitute for account access. */
export async function videoIsRestricted(
  videoId: string,
  client: ContentClient = db
): Promise<boolean> {
  const video = await client.video.findUnique({
    where: { id: videoId },
    select: { accessMode: true, folderId: true },
  });
  if (!video || video.accessMode === 'RESTRICTED') return true;
  let folderId = video.folderId;
  for (let depth = 0; folderId && depth < MAX_FOLDER_DEPTH; depth++) {
    const folder = await client.projectFolder.findUnique({
      where: { id: folderId },
      select: { accessMode: true, parentId: true },
    });
    if (!folder || folder.accessMode === 'RESTRICTED') return true;
    folderId = folder.parentId;
  }
  return folderId !== null;
}

export async function checkUploadDestination(
  projectId: string,
  folderId: string | null,
  targetVideoId: string | null,
  userId: string,
  client: ContentClient = db
) {
  if (!targetVideoId) return checkFolderAccess(projectId, folderId, userId, client);
  const access = await checkVideoAccess(targetVideoId, userId, client);
  if (!access.video || access.video.projectId !== projectId) return null;
  return { ...access, project: access.video.project };
}
