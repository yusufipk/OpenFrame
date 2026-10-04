import { unstable_cache } from 'next/cache';
import { db } from '@/lib/db';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { ListObjectsV2Command, type ListObjectsV2CommandInput } from '@aws-sdk/client-s3';
import { isBunnyUploadsEnabled, isStripeBillingEnabled } from '@/lib/feature-flags';
import { buildCardlessTrialWhereInput } from '@/lib/billing';
import { getPlanPriceId, getStoragePriceId } from '@/lib/billing-plans';
import { getStripe } from '@/lib/stripe';
import { logError } from '@/lib/logger';
import { COUNTED_USER } from '@/lib/stats-exclusion';

const BUNNY_API_BASE = 'https://video.bunnycdn.com';
const STORAGE_CACHE_SECONDS = 120;

interface R2StorageSnapshot {
  fileSizes: Map<string, number>;
  totalBytes: number;
  refreshedAt: string;
}

const globalForAdminStats = globalThis as unknown as {
  adminR2StorageSnapshot?: R2StorageSnapshot;
  adminR2StorageSnapshotPromise?: Promise<R2StorageSnapshot>;
};

interface BunnyStorageStats {
  totalBytes: number;
  byVideoId: Record<string, number>;
}

function bigintToNumber(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function getBunnyConfig(): { apiKey: string; libraryId: string } {
  const apiKey = process.env.BUNNY_STREAM_API_KEY;
  const libraryId =
    process.env.BUNNY_STREAM_LIBRARY_ID || process.env.NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID;
  if (!apiKey || !libraryId) {
    throw new Error('Missing Bunny Stream credentials.');
  }
  return { apiKey, libraryId };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function parseBunnyVideoStorageBytes(item: unknown): number {
  const record = toRecord(item);
  if (!record) return 0;

  const candidates = ['storageSize', 'storage', 'size'];
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return 0;
}

function parseBunnyVideoGuid(item: unknown): string | null {
  const record = toRecord(item);
  if (!record) return null;
  const value = record.guid;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function listAllR2FileSizes(): Promise<Map<string, number>> {
  const fileSizes = new Map<string, number>();
  let isTruncated = true;
  let continuationToken: string | undefined;

  while (isTruncated) {
    const commandParams: ListObjectsV2CommandInput = { Bucket: R2_BUCKET_NAME };
    if (continuationToken) {
      commandParams.ContinuationToken = continuationToken;
    }

    const data = await r2Client.send(new ListObjectsV2Command(commandParams));
    if (data.Contents) {
      for (const item of data.Contents) {
        if (item.Key) fileSizes.set(item.Key, item.Size || 0);
      }
    }
    isTruncated = data.IsTruncated ?? false;
    continuationToken = data.NextContinuationToken;
  }

  return fileSizes;
}

async function buildR2StorageSnapshot(): Promise<R2StorageSnapshot> {
  const fileSizes = await listAllR2FileSizes();
  let totalBytes = 0;
  for (const size of fileSizes.values()) {
    totalBytes += size;
  }

  return {
    fileSizes,
    totalBytes,
    refreshedAt: new Date().toISOString(),
  };
}

async function getR2StorageSnapshot(): Promise<R2StorageSnapshot> {
  if (globalForAdminStats.adminR2StorageSnapshot) {
    return globalForAdminStats.adminR2StorageSnapshot;
  }

  return Promise.reject(
    new Error(
      'R2 storage snapshot is not available. Trigger a manual refresh from admin dashboard.'
    )
  );
}

export async function refreshR2StorageSnapshot(): Promise<string> {
  // Single-flight. The promise slot was declared and cleared but never read, so two
  // concurrent admin refreshes each walked the whole bucket. A second caller now joins
  // the walk already in progress.
  const inFlight = globalForAdminStats.adminR2StorageSnapshotPromise;
  if (inFlight) {
    return (await inFlight).refreshedAt;
  }

  const pending = buildR2StorageSnapshot();
  globalForAdminStats.adminR2StorageSnapshotPromise = pending;
  try {
    const snapshot = await pending;
    globalForAdminStats.adminR2StorageSnapshot = snapshot;
    return snapshot.refreshedAt;
  } finally {
    globalForAdminStats.adminR2StorageSnapshotPromise = undefined;
  }
}

async function fetchBunnyStorageStats(): Promise<BunnyStorageStats> {
  // isBunnyUploadsEnabled(), not isBunnyUploadsFeatureEnabled(): the flag alone defaults
  // to on, so a self-hosted install that never configured Bunny threw
  // "Missing Bunny Stream credentials." out of getBunnyConfig() below and the dashboard
  // reported -1 instead of zero.
  if (!isBunnyUploadsEnabled()) {
    return { totalBytes: 0, byVideoId: {} };
  }

  const { apiKey, libraryId } = getBunnyConfig();
  const byVideoId: Record<string, number> = {};
  let totalBytes = 0;
  let page = 1;
  const itemsPerPage = 100;

  while (page <= 200) {
    const response = await fetch(
      `${BUNNY_API_BASE}/library/${libraryId}/videos?page=${page}&itemsPerPage=${itemsPerPage}`,
      { headers: { AccessKey: apiKey }, cache: 'no-store' }
    );

    if (!response.ok) {
      throw new Error(`Bunny API failed (${response.status})`);
    }

    const json = await response.json();
    const record = toRecord(json);
    if (!record) break;

    const rawItems = Array.isArray(record.items)
      ? record.items
      : Array.isArray(record.Items)
        ? record.Items
        : [];

    if (rawItems.length === 0) break;

    for (const rawItem of rawItems) {
      const guid = parseBunnyVideoGuid(rawItem);
      if (!guid) continue;
      const storageBytes = parseBunnyVideoStorageBytes(rawItem);
      byVideoId[guid] = storageBytes;
      totalBytes += storageBytes;
    }

    const totalItems =
      typeof record.totalItems === 'number'
        ? record.totalItems
        : typeof record.TotalItems === 'number'
          ? record.TotalItems
          : null;

    if (totalItems !== null && page * itemsPerPage >= totalItems) {
      break;
    }

    page += 1;
  }

  return { totalBytes, byVideoId };
}

export async function getCachedTotalStorage(): Promise<number> {
  try {
    const snapshot = await getR2StorageSnapshot();
    return snapshot.totalBytes;
  } catch (err) {
    logError('Failed to fetch total storage stats:', err);
    return -1;
  }
}

export const getCachedBunnyStorageStats = unstable_cache(
  async () => {
    try {
      return await fetchBunnyStorageStats();
    } catch (err) {
      logError('Failed to fetch Bunny storage stats:', err);
      return { totalBytes: -1, byVideoId: {} } as BunnyStorageStats;
    }
  },
  ['admin-bunny-storage'],
  { revalidate: STORAGE_CACHE_SECONDS }
);

/**
 * What this video costs us, as the larger of the two numbers we have.
 *
 * Bunny reports nothing for a video until it starts encoding, and what it reports
 * while encoding is partial: `storageSize` counts what has been written so far and
 * climbs as each rendition lands. A six minute cut uploaded at 2.5 GB read as
 * 475 MB midway through and settled above 3 GB once it finished, because Bunny
 * keeps the original alongside every rendition it makes.
 *
 * Both halves of the rule follow from that. Taking Bunny's figure whenever it is
 * non-zero would hand back most of the quota in the middle of an encode, which is
 * the hole the declared size exists to close. Taking the declared size forever
 * would ignore the renditions, which are the actual bill and end up larger than
 * the source. The larger of the two is right at every point: the declared size
 * covers the encode, and Bunny's own number takes over the moment it passes it.
 */
function chargeableSize(reported: number, declared: bigint | null): number {
  const declaredBytes = declared === null ? 0 : Number(declared);
  return reported > declaredBytes ? reported : declaredBytes;
}

/**
 * Bunny's reported sizes, or an empty map when the call to Bunny failed.
 *
 * A failed stats call is not a reason to bill an account for nothing. Bunny's own
 * figure is unavailable; the sizes declared at upload are sitting in our database
 * either way, and reading the whole account as empty is how a full account gets
 * waved through. Used to be an early return that skipped the rows entirely.
 */
function reportedSizes(stats: BunnyStorageStats): Record<string, number> {
  return stats.totalBytes < 0 ? {} : stats.byVideoId;
}

/**
 * What one account's Bunny videos cost, read fresh.
 *
 * This deliberately does not come from the cached per-user map. The declared size
 * lands on the row at the moment an upload finalizes, and a map computed up to two
 * minutes earlier does not have that row in it. For those two minutes the
 * reservation is already gone and the row is not yet visible, so an upload that
 * just succeeded reads as zero: the uploader watches their usage fall back to
 * nothing, and the next upload is measured against a total that ignores the one
 * before it.
 *
 * The call to Bunny stays cached. It is the slow half and its answer is the same
 * for everybody. Only the join against our own rows has to be current.
 */
export async function getUserBunnyStorageBytes(userId: string): Promise<number> {
  try {
    const [bunnyStats, bunnyVersions, bunnyAssets] = await Promise.all([
      getCachedBunnyStorageStats(),
      db.videoVersion.findMany({
        where: {
          providerId: 'bunny',
          // The workspace owner, not the project owner: this feeds
          // getUserTotalStorageBytes, which bills every other provider the same way.
          video: { project: { workspace: { ownerId: userId } } },
        },
        select: { videoId: true, sizeBytes: true },
      }),
      db.videoAsset.findMany({
        where: { provider: 'BUNNY', providerVideoId: { not: null }, billedUserId: userId },
        select: { providerVideoId: true, sizeBytes: true },
      }),
    ]);

    const reported = reportedSizes(bunnyStats);
    const seenVideoIds = new Set<string>();
    let total = 0;

    for (const row of [
      ...bunnyVersions.map((v) => ({ videoId: v.videoId, sizeBytes: v.sizeBytes })),
      ...bunnyAssets.map((a) => ({ videoId: a.providerVideoId!, sizeBytes: a.sizeBytes })),
    ]) {
      if (!row.videoId || seenVideoIds.has(row.videoId)) continue;
      seenVideoIds.add(row.videoId);
      total += chargeableSize(reported[row.videoId] || 0, row.sizeBytes);
    }

    return total;
  } catch (err) {
    logError('Failed to calculate Bunny storage for user:', err);
    return 0;
  }
}

export const getCachedUserBunnyStorage = unstable_cache(
  async () => {
    const perUserStorage: Record<string, number> = {};
    try {
      const bunnyStats = await getCachedBunnyStorageStats();

      const [bunnyVersions, bunnyAssets] = await Promise.all([
        db.videoVersion.findMany({
          where: { providerId: 'bunny' },
          select: {
            videoId: true,
            // What the uploader declared, used as a floor below.
            sizeBytes: true,
            video: {
              select: {
                project: {
                  // The workspace owner, not the project owner. lib/storage-quota.ts bills
                  // R2 versions to the workspace owner and comment media below does the
                  // same, and getCachedUserBunnyStorage feeds getUserTotalStorageBytes, so
                  // the moment project and workspace ownership can differ one workspace's
                  // Bunny bytes and its R2 bytes would count against two different quotas.
                  select: { workspace: { select: { ownerId: true } } },
                },
              },
            },
          },
        }),
        db.videoAsset.findMany({
          where: {
            provider: 'BUNNY',
            providerVideoId: { not: null },
          },
          select: {
            providerVideoId: true,
            billedUserId: true,
            sizeBytes: true,
          },
        }),
      ]);

      const reported = reportedSizes(bunnyStats);
      const seenVideoIds = new Set<string>();
      for (const version of bunnyVersions) {
        const ownerId = version.video.project.workspace.ownerId;
        const dedupeKey = `${ownerId}:${version.videoId}`;
        if (seenVideoIds.has(dedupeKey)) continue;
        seenVideoIds.add(dedupeKey);

        const size = chargeableSize(reported[version.videoId] || 0, version.sizeBytes);
        perUserStorage[ownerId] = (perUserStorage[ownerId] || 0) + size;
      }

      for (const asset of bunnyAssets) {
        if (!asset.providerVideoId) continue;
        const billedUserId = asset.billedUserId;
        const dedupeKey = `${billedUserId}:${asset.providerVideoId}`;
        if (seenVideoIds.has(dedupeKey)) continue;
        seenVideoIds.add(dedupeKey);

        const size = chargeableSize(reported[asset.providerVideoId] || 0, asset.sizeBytes);
        perUserStorage[billedUserId] = (perUserStorage[billedUserId] || 0) + size;
      }
    } catch (err) {
      logError('Failed to calculate per-user Bunny storage:', err);
    }
    return perUserStorage;
  },
  ['admin-user-bunny-storage'],
  { revalidate: STORAGE_CACHE_SECONDS }
);

export async function getCachedUserMediaStorage(): Promise<
  Record<string, { total: number; voice: number; image: number }>
> {
  // Return a plain object so it maps cleanly out of server component boundaries
  const userStorage: Record<string, { total: number; voice: number; image: number }> = {};
  try {
    const snapshot = await getR2StorageSnapshot();
    const seenKeys = new Set<string>();

    const [mediaComments, imageAssets, audioAssets] = await Promise.all([
      db.comment.findMany({
        where: { OR: [{ voiceUrl: { not: null } }, { images: { some: {} } }] },
        select: {
          voiceUrl: true,
          images: { select: { url: true } },
          version: {
            select: {
              video: {
                select: {
                  project: {
                    select: {
                      workspace: {
                        select: { ownerId: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      db.videoAsset.findMany({
        where: { provider: 'R2_IMAGE' },
        select: {
          sourceUrl: true,
          billedUserId: true,
        },
      }),
      db.videoAsset.findMany({
        where: { provider: 'R2_AUDIO' },
        select: {
          sourceUrl: true,
          billedUserId: true,
        },
      }),
    ]);

    for (const comment of mediaComments) {
      const billedUserId = comment.version.video.project.workspace.ownerId;
      if (!billedUserId) continue;

      if (!userStorage[billedUserId]) {
        userStorage[billedUserId] = { total: 0, voice: 0, image: 0 };
      }

      if (comment.voiceUrl) {
        const keyParts = comment.voiceUrl.split('/');
        const filename = keyParts[keyParts.length - 1];
        const r2Key = `voice/${filename}`;
        const dedupeKey = `${billedUserId}:${r2Key}`;
        if (!seenKeys.has(dedupeKey)) {
          seenKeys.add(dedupeKey);
          const size = snapshot.fileSizes.get(r2Key) || 0;
          userStorage[billedUserId].voice += size;
          userStorage[billedUserId].total += size;
        }
      }

      for (const image of comment.images) {
        const keyParts = image.url.split('/');
        const filename = keyParts[keyParts.length - 1];
        const r2Key = `images/${filename}`;
        const dedupeKey = `${billedUserId}:${r2Key}`;
        if (!seenKeys.has(dedupeKey)) {
          seenKeys.add(dedupeKey);
          const size = snapshot.fileSizes.get(r2Key) || 0;
          userStorage[billedUserId].image += size;
          userStorage[billedUserId].total += size;
        }
      }
    }

    for (const asset of imageAssets) {
      const billedUserId = asset.billedUserId;
      if (!billedUserId) continue;
      if (!userStorage[billedUserId]) {
        userStorage[billedUserId] = { total: 0, voice: 0, image: 0 };
      }

      const keyParts = asset.sourceUrl.split('/');
      const filename = keyParts[keyParts.length - 1];
      if (!filename) continue;
      const r2Key = `images/${filename}`;
      const dedupeKey = `${billedUserId}:${r2Key}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      const size = snapshot.fileSizes.get(r2Key) || 0;
      userStorage[billedUserId].image += size;
      userStorage[billedUserId].total += size;
    }

    for (const asset of audioAssets) {
      const billedUserId = asset.billedUserId;
      if (!billedUserId) continue;
      if (!userStorage[billedUserId]) {
        userStorage[billedUserId] = { total: 0, voice: 0, image: 0 };
      }

      const keyParts = asset.sourceUrl.split('/');
      const filename = keyParts[keyParts.length - 1];
      if (!filename) continue;
      const r2Key = `voice/${filename}`;
      const dedupeKey = `${billedUserId}:${r2Key}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      const size = snapshot.fileSizes.get(r2Key) || 0;
      userStorage[billedUserId].voice += size;
      userStorage[billedUserId].total += size;
    }
  } catch (err) {
    logError('Failed to parse user storage:', err);
  }
  return userStorage;
}

export const getCachedUserDownloadEgress = unstable_cache(
  async () => {
    const perUserDownloadEgress: Record<string, number> = {};
    try {
      const grouped = await db.downloadEgressEvent.groupBy({
        by: ['billedUserId'],
        _sum: {
          estimatedBytes: true,
        },
      });

      for (const row of grouped) {
        perUserDownloadEgress[row.billedUserId] = row._sum.estimatedBytes
          ? bigintToNumber(row._sum.estimatedBytes)
          : 0;
      }
    } catch (err) {
      logError('Failed to calculate per-user download egress:', err);
    }

    return perUserDownloadEgress;
  },
  ['admin-user-download-egress'],
  { revalidate: STORAGE_CACHE_SECONDS }
);

export interface StripeStats {
  activeSubscribers: number;
  trialingUsers: number;
  pastDueUsers: number;
  canceledUsers: number;
  freeUsers: number;
  /** UNPAID, INCOMPLETE and INCOMPLETE_EXPIRED, which belong to none of the buckets above. */
  otherStatusUsers: number;
  mrrCents: number;
  currency: string;
}

const STRIPE_STATS_CACHE_SECONDS = 300;
/** Expired when an account is excluded or included, so the change shows at once. */
export const STRIPE_STATS_CACHE_TAG = 'admin-stripe-stats';

export const getCachedStripeStats = unstable_cache(
  async (): Promise<StripeStats | null> => {
    if (!isStripeBillingEnabled()) return null;

    try {
      const now = new Date();
      // The cardless trial leaves `subscriptionStatus` at FREE, so the group-by
      // alone counted every trial as a free user and reported "On Trial" as zero.
      // Counted separately and moved across the two buckets below.
      const [statusCounts, cardlessTrialUsers] = await Promise.all([
        db.user.groupBy({
          by: ['subscriptionStatus'],
          where: COUNTED_USER,
          _count: { id: true },
        }),
        db.user.count({ where: { AND: [COUNTED_USER, buildCardlessTrialWhereInput(now)] } }),
      ]);

      const counts: Record<string, number> = {};
      for (const row of statusCounts) {
        counts[row.subscriptionStatus] = row._count.id;
      }

      const activeSubscribers = counts['ACTIVE'] ?? 0;
      const trialingUsers = (counts['TRIALING'] ?? 0) + cardlessTrialUsers;
      const pastDueUsers = counts['PAST_DUE'] ?? 0;
      const canceledUsers = counts['CANCELED'] ?? 0;
      // Clamped because the two queries above see two different snapshots: a signup
      // landing between them can be counted as a trial without having been counted
      // as free, which would otherwise report a negative number of free users.
      const freeUsers = Math.max(0, (counts['FREE'] ?? 0) - cardlessTrialUsers);
      // UNPAID, INCOMPLETE and INCOMPLETE_EXPIRED belonged to none of the five buckets
      // above, so those users were counted nowhere and the totals silently did not add
      // up to the user table.
      const otherStatusUsers =
        (counts['UNPAID'] ?? 0) + (counts['INCOMPLETE'] ?? 0) + (counts['INCOMPLETE_EXPIRED'] ?? 0);

      let mrrCents = 0;
      let currency = 'usd';

      // Each plan and interval in use is priced from its own Stripe price, normalised
      // to a month (a yearly price counts a twelfth), and storage blocks are added at
      // the price of their interval. Discounts are not reflected.
      try {
        const activeRows = await db.user.groupBy({
          by: ['billingPlan', 'billingInterval'],
          where: { ...COUNTED_USER, subscriptionStatus: 'ACTIVE' },
          _count: { id: true },
          _sum: { storageBlocks: true },
        });
        const stripe = getStripe();
        const unitAmounts = new Map<string, number>();
        const unitAmount = async (priceId: string | null) => {
          if (!priceId) return 0;
          if (!unitAmounts.has(priceId)) {
            const price = await stripe.prices.retrieve(priceId);
            currency = price.currency ?? currency;
            unitAmounts.set(priceId, price.unit_amount ?? 0);
          }
          return unitAmounts.get(priceId)!;
        };

        let monthly = 0;
        for (const row of activeRows) {
          const months = row.billingInterval === 'YEAR' ? 12 : 1;
          const planCents = await unitAmount(getPlanPriceId(row.billingPlan, row.billingInterval));
          const blocks = row._sum.storageBlocks ?? 0;
          const blockCents =
            blocks > 0 ? await unitAmount(getStoragePriceId(row.billingInterval)) : 0;
          monthly += (row._count.id * planCents + blocks * blockCents) / months;
        }
        mrrCents = Math.round(monthly);
      } catch (err) {
        mrrCents = 0;
        currency = 'usd';
        logError('Failed to fetch Stripe prices for MRR calculation:', err);
      }

      return {
        activeSubscribers,
        trialingUsers,
        pastDueUsers,
        canceledUsers,
        freeUsers,
        otherStatusUsers,
        mrrCents,
        currency,
      };
    } catch (err) {
      logError('Failed to fetch Stripe stats:', err);
      return null;
    }
  },
  ['admin-stripe-stats'],
  { revalidate: STRIPE_STATS_CACHE_SECONDS, tags: [STRIPE_STATS_CACHE_TAG] }
);
