import { unstable_cache } from 'next/cache';
import { db } from '@/lib/db';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';

// Cache for 10 minutes (600 seconds)
export const getCachedTotalStorage = unstable_cache(
    async () => {
        let totalStorageBytes = 0;
        try {
            let isTruncated = true;
            let continuationToken: string | undefined = undefined;

            while (isTruncated) {
                const commandParams: any = { Bucket: R2_BUCKET_NAME };
                if (continuationToken) commandParams.ContinuationToken = continuationToken;

                const data = await r2Client.send(new ListObjectsV2Command(commandParams));
                if (data.Contents) {
                    for (const item of data.Contents) {
                        totalStorageBytes += item.Size || 0;
                    }
                }
                isTruncated = data.IsTruncated ?? false;
                continuationToken = data.NextContinuationToken;
            }
        } catch (err) {
            console.error('Failed to fetch total storage stats:', err);
            return -1;
        }
        return totalStorageBytes;
    },
    ['admin-total-storage'],
    { revalidate: 600 }
);

export const getCachedUserMediaStorage = unstable_cache(
    async () => {
        // Return a plain object so it maps cleanly out of unstable_cache across requests
        const userStorage: Record<string, { total: number, voice: number, image: number }> = {};
        try {
            const fileSizes = new Map<string, number>();
            let isTruncated = true;
            let continuationToken: string | undefined = undefined;

            while (isTruncated) {
                const commandParams: any = { Bucket: R2_BUCKET_NAME };
                if (continuationToken) commandParams.ContinuationToken = continuationToken;

                const data = await r2Client.send(new ListObjectsV2Command(commandParams));
                if (data.Contents) {
                    for (const item of data.Contents) {
                        if (item.Key) fileSizes.set(item.Key, item.Size || 0);
                    }
                }
                isTruncated = data.IsTruncated ?? false;
                continuationToken = data.NextContinuationToken;
            }

            const mediaComments = await db.comment.findMany({
                where: { OR: [{ voiceUrl: { not: null } }, { imageUrl: { not: null } }], authorId: { not: null } },
                select: { authorId: true, voiceUrl: true, imageUrl: true }
            });

            for (const comment of mediaComments) {
                if (!comment.authorId) continue;

                if (!userStorage[comment.authorId]) {
                    userStorage[comment.authorId] = { total: 0, voice: 0, image: 0 };
                }

                if (comment.voiceUrl) {
                    const keyParts = comment.voiceUrl.split('/');
                    const filename = keyParts[keyParts.length - 1];
                    const r2Key = `voice/${filename}`;
                    const size = fileSizes.get(r2Key) || 0;
                    userStorage[comment.authorId].voice += size;
                    userStorage[comment.authorId].total += size;
                }

                if (comment.imageUrl) {
                    const keyParts = comment.imageUrl.split('/');
                    const filename = keyParts[keyParts.length - 1];
                    const r2Key = `images/${filename}`;
                    const size = fileSizes.get(r2Key) || 0;
                    userStorage[comment.authorId].image += size;
                    userStorage[comment.authorId].total += size;
                }
            }
        } catch (err) {
            console.error('Failed to parse user storage:', err);
        }
        return userStorage;
    },
    ['admin-user-media-storage'],
    { revalidate: 600 }
);
