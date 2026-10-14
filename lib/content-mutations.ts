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
/** A Serializable abort. The transaction rolled back, so running it again is safe. */
class SerializationConflict extends ContentError {
  constructor() {
    super(409, 'Content or access changed. Refresh and try again.');
  }
}

const CONTENT_TRANSACTION_ATTEMPTS = 3;
// An abort later than this is not retried; see contentTransaction.
const QUICK_ABORT_MS = 5000;

/**
 * The SQLSTATE behind a bare DriverAdapterError, which is what Prisma 7 throws
 * from a model call (not raw SQL) for errors it has no code of its own for, such
 * as a deadlock or a lock timeout, and from COMMIT on a serialization failure.
 * Read from `cause`, since the class name does not survive minification.
 */
function driverAdapterSqlState(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  // A DriverAdapterError's message is its kind when the driver gave none.
  if (error.message === 'TransactionWriteConflict') return '40001';
  if (typeof error.cause !== 'object' || error.cause === null) return null;
  const cause = error.cause as { kind?: unknown; originalCode?: unknown };
  if (cause.kind === 'TransactionWriteConflict') return '40001';
  return typeof cause.originalCode === 'string' ? cause.originalCode : null;
}

export async function contentTransaction<T>(
  projectIds: string[],
  run: (tx: ContentClient) => Promise<T>,
  timeout = 20000
): Promise<T> {
  // Serializable transactions in unrelated projects can still abort each other,
  // because Postgres predicate locks are coarse on small tables. Retrying a few
  // times spares the user a "changed" error for a change that never happened;
  // `run` re-reads and re-checks everything, so a real change still refuses.
  // Only an attempt that aborted quickly is repeated, so a long-running
  // transaction (bulk delete) never multiplies its time under the project lock.
  for (let attempt = 1; ; attempt++) {
    const startedAt = Date.now();
    try {
      return await contentTransactionAttempt(projectIds, run, timeout);
    } catch (error) {
      if (
        !(error instanceof SerializationConflict) ||
        attempt >= CONTENT_TRANSACTION_ATTEMPTS ||
        Date.now() - startedAt > QUICK_ABORT_MS
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.random() * 25));
    }
  }
}

async function contentTransactionAttempt<T>(
  projectIds: string[],
  run: (tx: ContentClient) => Promise<T>,
  timeout: number
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
      const sqlState = String(error.meta?.code ?? driverCode);
      if (
        error.code === 'P2034' ||
        (error.code === 'P2010' && ['40001', '40P01'].includes(sqlState))
      )
        throw new SerializationConflict();
      // A lock wait that already ran out its 5s is not worth repeating.
      if (error.code === 'P2010' && sqlState === '55P03')
        throw new ContentError(409, 'Content or access changed. Refresh and try again.');
      if (error.code === 'P2003')
        throw new ContentError(409, 'Folder is not empty or its destination changed.');
      if (error.code === 'P2004')
        throw new ContentError(
          400,
          'Folder cannot contain itself and must remain within 10 levels.'
        );
    }
    // Without these the bare adapter errors would end up a 500.
    const adapterState = driverAdapterSqlState(error);
    if (adapterState === '40001' || adapterState === '40P01') throw new SerializationConflict();
    if (adapterState === '55P03')
      throw new ContentError(409, 'Content or access changed. Refresh and try again.');
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

/**
 * Stacks one file onto another: every version of the source, with its comments,
 * approvals and subtitles, is renumbered after the target's newest version, and
 * the source's newest cut becomes the target's active one. The source's assets
 * follow it; its share links, direct members and invitations go with the row.
 *
 * Also lost with the source row: a live review running on it, and an upload or
 * Drive import still in flight towards it, which then fails as it would after a
 * delete. A pending approval moves with its version, so an approver whose only
 * access was a direct member grant on the source can no longer open it.
 */
export async function mergeVideoIntoVersions(input: {
  projectId: string;
  targetVideoId: string;
  sourceVideoId: string;
  userId: string;
  confirmationToken?: unknown;
}) {
  const { projectId, targetVideoId, sourceVideoId, userId } = input;
  if (targetVideoId === sourceVideoId)
    throw new ContentError(400, 'A file cannot become a version of itself');
  return contentTransaction([projectId], async (tx) => {
    const [target, source] = await Promise.all([
      checkVideoAccess(targetVideoId, userId, tx),
      checkVideoAccess(sourceVideoId, userId, tx),
    ]);
    if (target.video?.projectId !== projectId || source.video?.projectId !== projectId)
      throw new ContentError(404, 'File not found');
    if (!target.canEdit || !source.canEdit)
      throw new ContentError(403, 'You cannot edit one of these files');
    if (target.video.mediaType !== source.video.mediaType)
      throw new ContentError(400, 'Videos and images cannot be stacked together');
    const [sourceVersions, targetVersions] = await Promise.all([
      tx.videoVersion.findMany({
        where: { videoParentId: sourceVideoId },
        orderBy: { versionNumber: 'asc' },
        select: { id: true },
      }),
      tx.videoVersion.findMany({
        where: { videoParentId: targetVideoId },
        orderBy: { versionNumber: 'asc' },
        select: { id: true, versionNumber: true },
      }),
    ]);
    if (!sourceVersions.length) throw new ContentError(400, 'That file has no versions to add');
    // The version lists are part of the operation, so a cut uploaded to either
    // file between the preview and the commit asks for confirmation again.
    const confirmation = await confirmContentChange(
      tx,
      [projectId],
      userId,
      {
        mergeVersions: {
          projectId,
          targetVideoId,
          sourceVideoId,
          sourceVersionIds: sourceVersions.map((version) => version.id),
          targetVersionIds: targetVersions.map((version) => version.id),
        },
      },
      input.confirmationToken,
      'Its versions, comments and attachments move into the other file and its newest cut becomes the current version. Its own share links, members and invitations are removed, and the other file’s access applies.'
    );
    if (confirmation) return confirmation;

    const base = targetVersions.length
      ? targetVersions[targetVersions.length - 1].versionNumber
      : 0;
    const active = sourceVersions[sourceVersions.length - 1];

    await tx.videoVersion.updateMany({
      where: { videoParentId: targetVideoId },
      data: { isActive: false },
    });
    // Sequential so the (videoParentId, versionNumber) pair is never duplicated
    // mid-statement; every new number is above the target's current maximum.
    for (const [index, version] of sourceVersions.entries()) {
      await tx.videoVersion.update({
        where: { id: version.id },
        data: {
          videoParentId: targetVideoId,
          versionNumber: base + index + 1,
          isActive: version.id === active.id,
        },
      });
    }
    await tx.videoAsset.updateMany({
      where: { videoId: sourceVideoId },
      data: { videoId: targetVideoId },
    });
    await tx.video.delete({ where: { id: sourceVideoId } });
    // Bumps updatedAt so the stack sorts as recently changed.
    await tx.video.update({ where: { id: targetVideoId }, data: { updatedAt: new Date() } });
    return {
      targetVideoId,
      addedVersionNumbers: sourceVersions.map((_, index) => base + index + 1),
      activeVersionNumber: base + sourceVersions.length,
      versionCount: targetVersions.length + sourceVersions.length,
    };
  });
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
