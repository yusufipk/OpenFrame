import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth';
import { checkFolderAccess, checkVideoAccess, type ContentClient } from '@/lib/content-access';

export class ContentError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
export function contentId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 128)
    throw new ContentError(400, 'Invalid content id');
  return value;
}
export function contentName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100)
    throw new ContentError(400, 'Name must contain 1 to 100 characters');
  return value.trim();
}
export async function contentTransaction<T>(
  projectIds: string[],
  run: (tx: ContentClient) => Promise<T>,
  timeout = 20000
): Promise<T> {
  try {
    return await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        for (const id of [...new Set(projectIds)].sort()) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 715))`;
          // A waiter may have acquired its Serializable snapshot before the lock.
          // Force a write conflict against the previous holder without changing preview data.
          await tx.$executeRaw`UPDATE projects SET id = id WHERE id = ${id}`;
        }
        return run(tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout }
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const driverCode = (
        error.meta?.driverAdapterError as { cause?: { originalCode?: string } } | undefined
      )?.cause?.originalCode;
      if (
        error.code === 'P2034' ||
        (error.code === 'P2010' &&
          ['40001', '40P01', '55P03'].includes(String(error.meta?.code ?? driverCode)))
      )
        throw new ContentError(409, 'Content or access changed. Refresh and try again.');
      if (error.code === 'P2003')
        throw new ContentError(409, 'Folder is not empty or its destination changed.');
      if (error.code === 'P2004')
        throw new ContentError(
          400,
          'Folder cannot contain itself and must remain within 10 levels.'
        );
    }
    if (
      error instanceof Error &&
      error.message.includes('Folder tree must be acyclic and at most 10 levels deep')
    )
      throw new ContentError(400, 'Folder cannot contain itself and must remain within 10 levels.');
    throw error;
  }
}

/** A confirmation is bound to the entire current permission graph, actor and exact operation. */
export async function confirmContentChange(
  tx: ContentClient,
  projectIds: string[],
  userId: string,
  operation: unknown,
  token: unknown,
  message: string
) {
  const projects = await tx.project.findMany({
    where: { id: { in: projectIds } },
    orderBy: { id: 'asc' },
    include: {
      members: { orderBy: { id: 'asc' } },
      workspace: {
        include: {
          members: { orderBy: { id: 'asc' } },
          owner: {
            select: {
              subscriptionStatus: true,
              trialEndsAt: true,
              stripeCurrentPeriodEnd: true,
              billingAccessEndedAt: true,
            },
          },
        },
      },
      folders: { orderBy: { id: 'asc' }, include: { members: { orderBy: { id: 'asc' } } } },
      videos: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          folderId: true,
          accessMode: true,
          members: { orderBy: { id: 'asc' } },
          shareLinks: { orderBy: { id: 'asc' } },
        },
      },
    },
  });
  const expected = createHash('sha256')
    .update(JSON.stringify({ userId, operation, projects }))
    .digest('hex');
  return token === expected
    ? null
    : { needsConfirmation: true as const, confirmationToken: expected, message };
}

export async function folderSubtree(tx: ContentClient, projectId: string, folderId: string) {
  const folders = await tx.projectFolder.findMany({
    where: { projectId },
    select: { id: true, parentId: true },
  });
  const ids = new Set([folderId]);
  for (let n = 0; n < 10; n++)
    for (const f of folders) if (f.parentId && ids.has(f.parentId)) ids.add(f.id);
  return [...ids];
}

export async function moveContentVideos(input: {
  projectId: string;
  targetProjectId: string;
  folderId: string | null;
  videoIds: string[];
  userId: string;
  confirmationToken?: unknown;
}) {
  const { projectId, targetProjectId, folderId, videoIds, userId } = input;
  return contentTransaction([projectId, targetProjectId], async (tx) => {
    const target = await checkFolderAccess(targetProjectId, folderId, userId, tx);

    const source = await tx.project.findUnique({ where: { id: projectId } });
    if (!source || source.workspaceId !== target?.project.workspaceId)
      throw new ContentError(400, 'Move requires projects in the same workspace');
    if (!target?.canEdit)
      throw new ContentError(403, 'You cannot move videos into this destination');
    const videos = await tx.video.findMany({ where: { id: { in: videoIds }, projectId } });
    if (videos.length !== videoIds.length)
      throw new ContentError(400, 'One or more videos are unavailable');
    if (projectId === targetProjectId && videos.every((v) => v.folderId === folderId))
      throw new ContentError(400, 'Videos are already in this folder');
    const access = await Promise.all(videos.map((v) => checkVideoAccess(v.id, userId, tx)));
    if (access.some((a) => !a.canEdit))
      throw new ContentError(403, 'One or more videos cannot be moved');
    if (projectId !== targetProjectId && !(await checkProjectAccess(source, userId, tx)).canEdit)
      throw new ContentError(403, 'Project management is required for cross-project moves');
    const confirmation = await confirmContentChange(
      tx,
      [projectId, targetProjectId],
      userId,
      { videoIds: [...videoIds].sort(), projectId, targetProjectId, folderId },
      input.confirmationToken,
      'Inherited videos will use destination access. Restricted videos keep their direct members. Existing video links will be revoked. Direct video invitations remain valid. Destination project and workspace managers can access the videos.'
    );
    if (confirmation) return confirmation;
    const position = await tx.video.aggregate({
      where: { projectId: targetProjectId },
      _max: { position: true },
    });
    await tx.shareLink.deleteMany({ where: { videoId: { in: videoIds } } });
    await tx.invitation.updateMany({
      where: { videoId: { in: videoIds }, scope: 'VIDEO' },
      data: { projectId: targetProjectId },
    });
    await Promise.all(
      videoIds.map((id, i) =>
        tx.video.update({
          where: { id },
          data: {
            projectId: targetProjectId,
            folderId,
            position: (position._max.position ?? -1) + 1 + i,
          },
        })
      )
    );
    return { movedCount: videos.length, targetProjectId };
  });
}
