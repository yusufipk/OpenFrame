import { db } from '../lib/db';
import { buildExpiredBillingWhereInput } from '../lib/billing';
import { collectWorkspaceMediaUrls, deleteMediaFilesBestEffort } from '../lib/r2-cleanup';
import { cleanupBunnyStreamVideosBestEffort } from '../lib/bunny-stream-cleanup';

type ExpiredWorkspaceTarget = {
  id: string;
  ownerId: string;
  ownerEmail: string | null;
};

async function getExpiredWorkspaceTargets(): Promise<ExpiredWorkspaceTarget[]> {
  const expiredOwners = await db.user.findMany({
    where: buildExpiredBillingWhereInput(),
    select: { id: true },
  });

  if (expiredOwners.length === 0) {
    return [];
  }

  return db.workspace
    .findMany({
      where: {
        ownerId: { in: expiredOwners.map((owner) => owner.id) },
      },
      select: {
        id: true,
        ownerId: true,
        owner: {
          select: {
            email: true,
          },
        },
      },
    })
    .then((workspaces) =>
      workspaces.map((workspace) => ({
        id: workspace.id,
        ownerId: workspace.ownerId,
        ownerEmail: workspace.owner.email,
      }))
    );
}

export async function cleanupExpiredBillingWorkspaces(options?: { dryRun?: boolean }) {
  const dryRun = options?.dryRun ?? false;
  const workspaces = await getExpiredWorkspaceTargets();

  if (workspaces.length === 0) {
    return { scanned: 0, deleted: 0 };
  }

  let deleted = 0;

  for (const workspace of workspaces) {
    const [workspaceVersionRefs, workspaceAssetRefs, mediaUrls] = await Promise.all([
      db.videoVersion.findMany({
        where: {
          video: {
            project: {
              workspaceId: workspace.id,
            },
          },
        },
        select: {
          providerId: true,
          videoId: true,
        },
      }),
      db.videoAsset.findMany({
        where: {
          provider: 'BUNNY',
          providerVideoId: { not: null },
          video: {
            project: {
              workspaceId: workspace.id,
            },
          },
        },
        select: {
          providerVideoId: true,
        },
      }),
      collectWorkspaceMediaUrls(workspace.id),
    ]);

    if (dryRun) {
      const ownerLabel = workspace.ownerEmail ?? workspace.ownerId;
      console.log(
        `[expired-billing-cleanup] Would delete workspace ${workspace.id} owned by ${ownerLabel}`
      );
      continue;
    }

    const bunnyRefs = [
      ...workspaceVersionRefs,
      ...workspaceAssetRefs.map((asset) => ({
        providerId: 'bunny',
        videoId: asset.providerVideoId as string,
      })),
    ];

    await db.workspace.delete({ where: { id: workspace.id } });
    await Promise.all([
      cleanupBunnyStreamVideosBestEffort(bunnyRefs),
      deleteMediaFilesBestEffort(mediaUrls),
    ]);
    deleted += 1;
  }

  return { scanned: workspaces.length, deleted };
}
