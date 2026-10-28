import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth';
import { buildBillingAccessWhereInput } from '@/lib/billing';

export type ContentClient = Prisma.TransactionClient;
export type ContentRole = 'ADMIN' | 'COMMENTATOR';
export type ContentMode = 'INHERIT' | 'RESTRICTED' | 'PUBLIC';
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

/**
 * No folder above this one is restricted. Public reach stops at a restricted folder, the
 * same boundary guest share links keep (see `videoIsRestricted`).
 */
function openToRoot(depth: number): Prisma.ProjectFolderWhereInput {
  if (depth <= 0) return { id: { in: [] } };
  return {
    OR: [
      { parentId: null },
      { parent: { accessMode: { not: 'RESTRICTED' }, ...openToRoot(depth - 1) } },
    ],
  };
}

function folderAudience(
  userId: string | undefined,
  manage: boolean,
  depth: number,
  includePublic = true,
  publicFolders = true
): Prisma.ProjectFolderWhereInput {
  if (depth <= 0) return { id: { in: [] } };
  return {
    OR: [
      ...(userId
        ? [{ members: { some: { userId, ...(manage ? { role: 'ADMIN' as const } : {}) } } }]
        : []),
      // A public folder opens to everyone the way a public project does, so it follows the
      // same `includePublic` switch and never grants management.
      ...(!manage && includePublic && publicFolders
        ? [{ accessMode: 'PUBLIC' as const, ...openToRoot(depth) }]
        : []),
      {
        // PUBLIC widens INHERIT, so the people the parent admits keep their access.
        accessMode: { in: ['INHERIT' as const, 'PUBLIC' as const] },
        OR: [
          { parentId: null, project: projectAudience(userId, manage, includePublic) },
          { parent: folderAudience(userId, manage, depth - 1, includePublic, publicFolders) },
        ],
      },
    ],
  };
}

/** Filters before pagination, counts and metadata selection. No per-video query loop. */
export function visibleVideoWhere(
  userId?: string,
  manage = false,
  includePublic = true,
  publicFolders = true
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
          {
            folder: folderAudience(userId, manage, MAX_FOLDER_DEPTH, includePublic, publicFolders),
          },
        ],
      },
    ],
  };
}

export function visibleFolderWhere(
  userId?: string,
  manage = false,
  publicFolders = true
): Prisma.ProjectFolderWhereInput {
  return {
    project: { workspace: { owner: buildBillingAccessWhereInput() } },
    OR: [
      { project: projectAudience(userId, true) },
      folderAudience(userId, manage, MAX_FOLDER_DEPTH, true, publicFolders),
    ],
  };
}

/**
 * Filters for listing a project's contents. A public folder is opened by its URL, so in a
 * list its reach only counts inside `openedSubtree`, the folder the visitor opened and its
 * descendants. Otherwise the link to one public folder would list every other public
 * folder in the project.
 */
export function listedVideoWhere(
  userId: string | undefined,
  openedSubtree: string[]
): Prisma.VideoWhereInput {
  return {
    OR: [
      visibleVideoWhere(userId, false, true, false),
      { folderId: { in: openedSubtree }, AND: visibleVideoWhere(userId) },
    ],
  };
}

export function listedFolderWhere(
  userId: string | undefined,
  openedSubtree: string[]
): Prisma.ProjectFolderWhereInput {
  return {
    OR: [
      visibleFolderWhere(userId, false, false),
      { id: { in: openedSubtree }, AND: visibleFolderWhere(userId) },
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
  let hasAccess = false;
  let canEdit = false;
  let publicReach = false;
  if (access.ownerBillingActive) {
    const videoMember = userId
      ? await client.videoMember.findUnique({
          where: { videoId_userId: { videoId, userId } },
          select: { role: true },
        })
      : null;
    hasAccess = !!videoMember;
    canEdit = videoMember?.role === 'ADMIN';

    if (video.accessMode === 'INHERIT' && !canEdit) {
      if (!video.folderId) {
        hasAccess ||= access.hasAccess;
      } else {
        let folderId: string | null = video.folderId;
        for (let depth = 0; folderId && depth < MAX_FOLDER_DEPTH; depth++) {
          const folder: {
            parentId: string | null;
            accessMode: ContentMode;
            members: Array<{ role: ContentRole }>;
          } | null = await client.projectFolder.findUnique({
            where: { id: folderId },
            select: {
              parentId: true,
              accessMode: true,
              members: {
                where: { userId: userId ?? '' },
                select: { role: true },
              },
            },
          });
          if (!folder) break;
          const folderRole = userId ? folder.members[0]?.role : undefined;
          hasAccess ||= !!folderRole;
          if (folderRole === 'ADMIN') {
            canEdit = true;
            break;
          }
          if (folder.accessMode === 'RESTRICTED') break;
          // Counts only once the walk reaches the root without passing a restricted folder.
          if (folder.accessMode === 'PUBLIC') publicReach = true;
          if (!folder.parentId) {
            hasAccess ||= access.hasAccess || publicReach;
            break;
          }
          folderId = folder.parentId;
        }
      }
    }
  }
  return {
    ...access,
    hasProjectAccess: access.hasAccess,
    canManageProject: access.canEdit,
    hasAccess,
    canEdit,
    canDelete: canEdit,
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

/** Whether any folder above `folderId` is restricted, which keeps the folder from being public. */
export async function hasRestrictedAncestor(
  folderId: string,
  client: ContentClient = db
): Promise<boolean> {
  let parentId = (
    await client.projectFolder.findUnique({ where: { id: folderId }, select: { parentId: true } })
  )?.parentId;
  for (let depth = 0; parentId && depth < MAX_FOLDER_DEPTH; depth++) {
    const parent = await client.projectFolder.findUnique({
      where: { id: parentId },
      select: { accessMode: true, parentId: true },
    });
    if (!parent || parent.accessMode === 'RESTRICTED') return true;
    parentId = parent.parentId;
  }
  return parentId != null;
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
