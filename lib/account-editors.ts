// Who counts as an editor on an account, and how editors are turned back into
// reviewers. Kept free of billing imports because the Stripe sync in
// lib/billing.ts applies demotions, and the limit check in lib/editor-limit.ts
// reads billing state; both depend on this module, not on each other.

import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

type Client = Prisma.TransactionClient;

/**
 * Every distinct user who can upload under this owner's workspaces, the owner
 * included.
 *
 * An editor is anyone holding ADMIN at the workspace, project, folder or video
 * level, plus anyone who owns a project inside one of these workspaces (project
 * ownership grants the same edit rights as ADMIN). COMMENTATOR members and
 * share-link guests are never counted.
 */
export async function listAccountEditorIds(ownerId: string, client: Client = db) {
  const rows = await client.$queryRaw<Array<{ uid: string }>>`
    SELECT DISTINCT uid FROM (
      SELECT wm."userId" AS uid
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm."workspaceId"
      WHERE w."ownerId" = ${ownerId} AND wm.role = 'ADMIN'
      UNION
      SELECT pm."userId"
      FROM project_members pm
      JOIN projects p ON p.id = pm."projectId"
      JOIN workspaces w ON w.id = p."workspaceId"
      WHERE w."ownerId" = ${ownerId} AND pm.role = 'ADMIN'
      UNION
      SELECT p."ownerId"
      FROM projects p
      JOIN workspaces w ON w.id = p."workspaceId"
      WHERE w."ownerId" = ${ownerId}
      UNION
      SELECT fm."userId"
      FROM project_folder_members fm
      JOIN project_folders f ON f.id = fm."folderId"
      JOIN projects p ON p.id = f."projectId"
      JOIN workspaces w ON w.id = p."workspaceId"
      WHERE w."ownerId" = ${ownerId} AND fm.role = 'ADMIN'
      UNION
      SELECT vm."userId"
      FROM video_members vm
      JOIN videos v ON v.id = vm."videoId"
      JOIN projects p ON p.id = v."projectId"
      JOIN workspaces w ON w.id = p."workspaceId"
      WHERE w."ownerId" = ${ownerId} AND vm.role = 'ADMIN'
    ) editors
  `;

  const ids = new Set(rows.map((row) => row.uid));
  ids.add(ownerId);
  return ids;
}

/** The editors other than the owner, with what the owner needs to recognise them. */
export async function listAccountEditorsForReview(ownerId: string, client: Client = db) {
  const ids = await listAccountEditorIds(ownerId, client);
  ids.delete(ownerId);
  if (ids.size === 0) return [];
  return client.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true, email: true },
    orderBy: { email: 'asc' },
  });
}

/**
 * Turns the given users into reviewers everywhere under this owner's workspaces.
 *
 * Projects they own are handed to the workspace owner, the same thing removing a
 * workspace member does, and they keep access to those projects as COMMENTATOR so
 * the demotion takes upload rights away without locking anyone out.
 */
export async function demoteAccountEditors(client: Client, ownerId: string, userIds: string[]) {
  const targets = userIds.filter((id) => id !== ownerId);
  if (targets.length === 0) return;

  const inOwnerWorkspaces = { workspace: { ownerId } };

  await client.workspaceMember.updateMany({
    where: { userId: { in: targets }, role: 'ADMIN', ...inOwnerWorkspaces },
    data: { role: 'COMMENTATOR' },
  });
  await client.projectMember.updateMany({
    where: { userId: { in: targets }, role: 'ADMIN', project: inOwnerWorkspaces },
    data: { role: 'COMMENTATOR' },
  });
  await client.projectFolderMember.updateMany({
    where: { userId: { in: targets }, role: 'ADMIN', folder: { project: inOwnerWorkspaces } },
    data: { role: 'COMMENTATOR' },
  });
  await client.videoMember.updateMany({
    where: { userId: { in: targets }, role: 'ADMIN', video: { project: inOwnerWorkspaces } },
    data: { role: 'COMMENTATOR' },
  });

  const ownedProjects = await client.project.findMany({
    where: { ownerId: { in: targets }, ...inOwnerWorkspaces },
    select: { id: true, ownerId: true },
  });
  if (ownedProjects.length > 0) {
    await client.projectMember.createMany({
      data: ownedProjects.map((project) => ({
        projectId: project.id,
        userId: project.ownerId,
        role: 'COMMENTATOR' as const,
      })),
      skipDuplicates: true,
    });
    await client.project.updateMany({
      where: { id: { in: ownedProjects.map((project) => project.id) } },
      data: { ownerId },
    });
  }
}
