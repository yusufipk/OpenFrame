import { unstable_cache } from 'next/cache';
import { db } from '@/lib/db';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { ListObjectsV2Command, type ListObjectsV2CommandInput } from '@aws-sdk/client-s3';
import { isBunnyUploadsFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';

const BUNNY_API_BASE = 'https://video.bunnycdn.com';
const STORAGE_CACHE_SECONDS = 600;

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
    const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID || process.env.NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID;
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

    return Promise.reject(new Error('R2 storage snapshot is not available. Trigger a manual refresh from admin dashboard.'));
}

export async function refreshR2StorageSnapshot(): Promise<string> {
    const snapshot = await buildR2StorageSnapshot();
    globalForAdminStats.adminR2StorageSnapshot = snapshot;
    globalForAdminStats.adminR2StorageSnapshotPromise = undefined;
    return snapshot.refreshedAt;
}

async function fetchBunnyStorageStats(): Promise<BunnyStorageStats> {
    if (!isBunnyUploadsFeatureEnabled()) {
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
            : (Array.isArray(record.Items) ? record.Items : []);

        if (rawItems.length === 0) break;

        for (const rawItem of rawItems) {
            const guid = parseBunnyVideoGuid(rawItem);
            if (!guid) continue;
            const storageBytes = parseBunnyVideoStorageBytes(rawItem);
            byVideoId[guid] = storageBytes;
            totalBytes += storageBytes;
        }

        const totalItems = typeof record.totalItems === 'number'
            ? record.totalItems
            : (typeof record.TotalItems === 'number' ? record.TotalItems : null);

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

export const getCachedUserBunnyStorage = unstable_cache(
    async () => {
        const perUserStorage: Record<string, number> = {};
        try {
            const bunnyStats = await getCachedBunnyStorageStats();
            if (bunnyStats.totalBytes < 0) return perUserStorage;

            const [bunnyVersions, bunnyAssets] = await Promise.all([
                db.videoVersion.findMany({
                    where: { providerId: 'bunny' },
                    select: {
                        videoId: true,
                        video: {
                            select: {
                                project: {
                                    select: { ownerId: true },
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
                    },
                }),
            ]);

            const seenVideoIds = new Set<string>();
            for (const version of bunnyVersions) {
                const ownerId = version.video.project.ownerId;
                const dedupeKey = `${ownerId}:${version.videoId}`;
                if (seenVideoIds.has(dedupeKey)) continue;
                seenVideoIds.add(dedupeKey);

                const size = bunnyStats.byVideoId[version.videoId] || 0;
                perUserStorage[ownerId] = (perUserStorage[ownerId] || 0) + size;
            }

            for (const asset of bunnyAssets) {
                if (!asset.providerVideoId) continue;
                const billedUserId = asset.billedUserId;
                const dedupeKey = `${billedUserId}:${asset.providerVideoId}`;
                if (seenVideoIds.has(dedupeKey)) continue;
                seenVideoIds.add(dedupeKey);

                const size = bunnyStats.byVideoId[asset.providerVideoId] || 0;
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

export async function getCachedUserMediaStorage(): Promise<Record<string, { total: number, voice: number, image: number }>> {
    // Return a plain object so it maps cleanly out of server component boundaries
    const userStorage: Record<string, { total: number, voice: number, image: number }> = {};
    try {
        const snapshot = await getR2StorageSnapshot();
        const seenKeys = new Set<string>();

        const [mediaComments, imageAssets, audioAssets] = await Promise.all([
            db.comment.findMany({
                where: { OR: [{ voiceUrl: { not: null } }, { imageUrl: { not: null } }] },
                select: {
                    voiceUrl: true,
                    imageUrl: true,
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

            if (comment.imageUrl) {
                const keyParts = comment.imageUrl.split('/');
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
