import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { db } from '@/lib/db';

/** The path prefix for images served by the upload API. */
const IMAGE_PATH_PREFIX = '/api/upload/image/';
/** The path prefix for audio URLs served by the upload API. */
const AUDIO_PATH_PREFIX = '/api/upload/audio/';

/**
 * Extract the R2 object key from a media URL.
 * Uses string parsing instead of regex to avoid ReDoS risk on untrusted input.
 */
function mediaUrlToKey(url: string): string | null {
    if (url.includes(AUDIO_PATH_PREFIX)) {
        const filename = url.slice(url.indexOf(AUDIO_PATH_PREFIX) + AUDIO_PATH_PREFIX.length);
        return filename ? `voice/${filename}` : null;
    } else if (url.includes(IMAGE_PATH_PREFIX)) {
        const filename = url.slice(url.indexOf(IMAGE_PATH_PREFIX) + IMAGE_PATH_PREFIX.length);
        return filename ? `images/${filename}` : null;
    }
    return null;
}

/**
 * Delete a list of media files from R2 (best-effort, logs failures).
 */
async function deleteMediaFiles(mediaUrls: string[]) {
    for (const url of mediaUrls) {
        try {
            const key = mediaUrlToKey(url);
            if (key) {
                await r2Client.send(
                    new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key })
                );
            }
        } catch (err) {
            console.error('Failed to delete media from R2:', err);
        }
    }
}

/**
 * Collect all media URLs from comments under a given video (all versions).
 */
export async function collectVideoMediaUrls(videoId: string): Promise<string[]> {
    const comments = await db.comment.findMany({
        where: {
            OR: [{ voiceUrl: { not: null } }, { imageUrl: { not: null } }],
            version: { videoParentId: videoId },
        },
        select: { voiceUrl: true, imageUrl: true },
    });
    const urls: string[] = [];
    comments.forEach(c => {
        if (c.voiceUrl) urls.push(c.voiceUrl);
        if (c.imageUrl) urls.push(c.imageUrl);
    });
    return urls;
}

/**
 * Collect all media URLs from comments under all videos in a project.
 */
export async function collectProjectMediaUrls(projectId: string): Promise<string[]> {
    const comments = await db.comment.findMany({
        where: {
            OR: [{ voiceUrl: { not: null } }, { imageUrl: { not: null } }],
            version: { video: { projectId } },
        },
        select: { voiceUrl: true, imageUrl: true },
    });
    const urls: string[] = [];
    comments.forEach(c => {
        if (c.voiceUrl) urls.push(c.voiceUrl);
        if (c.imageUrl) urls.push(c.imageUrl);
    });
    return urls;
}

/**
 * Collect all media URLs from comments under all projects in a workspace.
 */
export async function collectWorkspaceMediaUrls(workspaceId: string): Promise<string[]> {
    const comments = await db.comment.findMany({
        where: {
            OR: [{ voiceUrl: { not: null } }, { imageUrl: { not: null } }],
            version: { video: { project: { workspaceId } } },
        },
        select: { voiceUrl: true, imageUrl: true },
    });
    const urls: string[] = [];
    comments.forEach(c => {
        if (c.voiceUrl) urls.push(c.voiceUrl);
        if (c.imageUrl) urls.push(c.imageUrl);
    });
    return urls;
}

/**
 * Delete all media files for a video from R2.
 * Call BEFORE deleting the video from the database (cascade would remove comment rows).
 */
export async function cleanupVideoMediaFiles(videoId: string) {
    const urls = await collectVideoMediaUrls(videoId);
    await deleteMediaFiles(urls);
}

/**
 * Delete all media files for a project from R2.
 * Call BEFORE deleting the project from the database.
 */
export async function cleanupProjectMediaFiles(projectId: string) {
    const urls = await collectProjectMediaUrls(projectId);
    await deleteMediaFiles(urls);
}

/**
 * Delete all media files for a workspace from R2.
 * Call BEFORE deleting the workspace from the database.
 */
export async function cleanupWorkspaceMediaFiles(workspaceId: string) {
    const urls = await collectWorkspaceMediaUrls(workspaceId);
    await deleteMediaFiles(urls);
}
