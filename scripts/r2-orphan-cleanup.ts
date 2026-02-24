import { DeleteObjectCommand, ListObjectsV2Command, type ListObjectsV2CommandInput } from '@aws-sdk/client-s3';
import { db, disconnectDb } from '../lib/db';
import { r2Client, R2_BUCKET_NAME } from '../lib/r2';

const UNATTACHED_UPLOAD_TTL_MS = 15 * 60 * 1000;
const CHUNK_SIZE = 500;
const PREFIXES = ['images/', 'voice/'] as const;

type CleanupCandidate = {
  key: string;
  url: string;
};

type UserFeedbackScreenshotDelegate = {
  findMany: (args: { where: { url: { in: string[] } }; select: { url: true } }) => Promise<Array<{ url: string }>>;
};

function keyToProxyUrl(key: string): string | null {
  if (key.startsWith('images/')) {
    const filename = key.slice('images/'.length);
    return filename ? `/api/upload/image/${filename}` : null;
  }
  if (key.startsWith('voice/')) {
    const filename = key.slice('voice/'.length);
    return filename ? `/api/upload/audio/${filename}` : null;
  }
  return null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function listCleanupCandidates(): Promise<{ candidates: CleanupCandidate[]; scanned: number }> {
  const candidates: CleanupCandidate[] = [];
  const cutoff = Date.now() - UNATTACHED_UPLOAD_TTL_MS;
  let scanned = 0;

  for (const prefix of PREFIXES) {
    let continuationToken: string | undefined;
    let isTruncated = true;

    while (isTruncated) {
      const input: ListObjectsV2CommandInput = {
        Bucket: R2_BUCKET_NAME,
        Prefix: prefix,
      };
      if (continuationToken) input.ContinuationToken = continuationToken;

      const response = await r2Client.send(new ListObjectsV2Command(input));
      const contents = response.Contents ?? [];
      scanned += contents.length;

      for (const item of contents) {
        if (!item.Key || !item.LastModified) continue;
        if (item.LastModified.getTime() > cutoff) continue;

        const url = keyToProxyUrl(item.Key);
        if (!url) continue;
        candidates.push({ key: item.Key, url });
      }

      isTruncated = response.IsTruncated ?? false;
      continuationToken = response.NextContinuationToken;
    }
  }

  return { candidates, scanned };
}

async function findReferencedUrls(urls: string[]): Promise<Set<string>> {
  const referenced = new Set<string>();
  const userFeedbackScreenshotDelegate = (db as unknown as {
    userFeedbackScreenshot?: UserFeedbackScreenshotDelegate;
  }).userFeedbackScreenshot;

  for (const group of chunk(urls, CHUNK_SIZE)) {
    const [commentRows, feedbackRows, feedbackAttachmentRows] = await Promise.all([
      db.comment.findMany({
        where: {
          OR: [{ voiceUrl: { in: group } }, { imageUrl: { in: group } }],
        },
        select: {
          voiceUrl: true,
          imageUrl: true,
        },
      }),
      db.userFeedback.findMany({
        where: { screenshotUrl: { in: group } },
        select: { screenshotUrl: true },
      }),
      userFeedbackScreenshotDelegate
        ? userFeedbackScreenshotDelegate.findMany({
          where: { url: { in: group } },
          select: { url: true },
        })
        : Promise.resolve([] as Array<{ url: string }>),
    ]);

    for (const row of commentRows) {
      if (row.voiceUrl) referenced.add(row.voiceUrl);
      if (row.imageUrl) referenced.add(row.imageUrl);
    }
    for (const row of feedbackRows) {
      if (row.screenshotUrl) referenced.add(row.screenshotUrl);
    }
    for (const row of feedbackAttachmentRows) {
      if (row.url) referenced.add(row.url);
    }
  }

  return referenced;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[r2-orphan-cleanup] Starting (${dryRun ? 'dry-run' : 'delete mode'})`);

  const { candidates, scanned } = await listCleanupCandidates();
  console.log(`[r2-orphan-cleanup] Scanned: ${scanned}, eligible (old enough): ${candidates.length}`);

  if (candidates.length === 0) {
    console.log('[r2-orphan-cleanup] No eligible objects found');
    return;
  }

  const referenced = await findReferencedUrls(candidates.map((candidate) => candidate.url));

  let deleted = 0;
  let failed = 0;
  let orphaned = 0;
  let referencedCount = 0;

  for (const candidate of candidates) {
    if (referenced.has(candidate.url)) {
      referencedCount += 1;
      continue;
    }

    orphaned += 1;
    if (dryRun) continue;

    try {
      await r2Client.send(
        new DeleteObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: candidate.key,
        })
      );
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.error(`[r2-orphan-cleanup] Failed deleting ${candidate.key}:`, error);
    }
  }

  console.log('[r2-orphan-cleanup] Summary');
  console.log(`[r2-orphan-cleanup] Referenced: ${referencedCount}`);
  console.log(`[r2-orphan-cleanup] Orphaned: ${orphaned}`);
  console.log(`[r2-orphan-cleanup] Deleted: ${deleted}`);
  console.log(`[r2-orphan-cleanup] Failed: ${failed}`);
}

main()
  .catch((error) => {
    console.error('[r2-orphan-cleanup] Fatal error:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDb();
    r2Client.destroy();
  });
