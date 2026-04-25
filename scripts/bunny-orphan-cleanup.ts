import { db, disconnectDb } from '../lib/db';
import { cleanupExpiredBillingWorkspaces } from './expired-billing-cleanup';
import { logError } from '@/lib/logger';

const BUNNY_API_BASE = 'https://video.bunnycdn.com';
const BUNNY_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const ITEMS_PER_PAGE = 100;
const MAX_PAGES = 200;
const CHUNK_SIZE = 500;
const DEFAULT_GRACE_HOURS = 24;

type BunnyConfig = {
  apiKey: string;
  libraryId: string;
};

type BunnyVideo = {
  id: string;
  uploadedAt: Date;
};

function getBunnyConfig(): BunnyConfig {
  const apiKey = process.env.BUNNY_STREAM_API_KEY;
  const libraryId =
    process.env.BUNNY_STREAM_LIBRARY_ID || process.env.NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID;

  if (!apiKey || !libraryId) {
    throw new Error('Missing BUNNY_STREAM_API_KEY or BUNNY_STREAM_LIBRARY_ID.');
  }

  return { apiKey, libraryId };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function parseVideoId(item: unknown): string | null {
  const record = toRecord(item);
  if (!record) return null;

  const candidates = [record.guid, record.videoId, record.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (BUNNY_VIDEO_ID_PATTERN.test(trimmed)) return trimmed;
    }
  }

  return null;
}

function parseUploadedAt(item: unknown): Date | null {
  const record = toRecord(item);
  if (!record) return null;

  const candidates = [
    record.dateUploaded,
    record.DateUploaded,
    record.dateCreated,
    record.DateCreated,
    record.createdAt,
    record.CreatedAt,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

async function fetchBunnyPage(
  config: BunnyConfig,
  page: number
): Promise<{ items: unknown[]; totalItems: number | null }> {
  const response = await fetch(
    `${BUNNY_API_BASE}/library/${config.libraryId}/videos?page=${page}&itemsPerPage=${ITEMS_PER_PAGE}`,
    {
      headers: {
        AccessKey: config.apiKey,
        Accept: 'application/json',
      },
      cache: 'no-store',
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Bunny list API failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  const record = toRecord(payload);
  if (!record) return { items: [], totalItems: null };

  const items = Array.isArray(record.items)
    ? record.items
    : Array.isArray(record.Items)
      ? record.Items
      : [];

  const totalItems =
    typeof record.totalItems === 'number'
      ? record.totalItems
      : typeof record.TotalItems === 'number'
        ? record.TotalItems
        : null;

  return { items, totalItems };
}

async function listBunnyVideos(
  config: BunnyConfig
): Promise<{ videos: BunnyVideo[]; scanned: number; skippedInvalid: number }> {
  const videos: BunnyVideo[] = [];
  let scanned = 0;
  let skippedInvalid = 0;
  let page = 1;

  while (page <= MAX_PAGES) {
    const { items, totalItems } = await fetchBunnyPage(config, page);
    if (items.length === 0) break;

    scanned += items.length;
    for (const item of items) {
      const id = parseVideoId(item);
      const uploadedAt = parseUploadedAt(item);
      if (!id || !uploadedAt) {
        skippedInvalid += 1;
        continue;
      }
      videos.push({ id, uploadedAt });
    }

    if (totalItems !== null && page * ITEMS_PER_PAGE >= totalItems) break;
    page += 1;
  }

  return { videos, scanned, skippedInvalid };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function findReferencedVideoIds(videoIds: string[]): Promise<Set<string>> {
  const referenced = new Set<string>();

  for (const group of chunk(videoIds, CHUNK_SIZE)) {
    const [versionRows, assetRows] = await Promise.all([
      db.videoVersion.findMany({
        where: {
          providerId: 'bunny',
          videoId: { in: group },
        },
        select: { videoId: true },
      }),
      db.videoAsset.findMany({
        where: {
          provider: 'BUNNY',
          providerVideoId: { in: group },
        },
        select: { providerVideoId: true },
      }),
    ]);
    versionRows.forEach((row) => {
      if (row.videoId) referenced.add(row.videoId);
    });
    assetRows.forEach((row) => {
      if (row.providerVideoId) referenced.add(row.providerVideoId);
    });
  }

  return referenced;
}

async function deleteBunnyVideo(
  config: BunnyConfig,
  videoId: string
): Promise<'deleted' | 'already_missing'> {
  const response = await fetch(
    `${BUNNY_API_BASE}/library/${config.libraryId}/videos/${encodeURIComponent(videoId)}`,
    {
      method: 'DELETE',
      headers: {
        AccessKey: config.apiKey,
      },
    }
  );

  if (response.status === 404) return 'already_missing';
  if (response.ok) return 'deleted';

  const body = await response.text().catch(() => '');
  throw new Error(
    `Bunny delete API failed for ${videoId} (${response.status}): ${body.slice(0, 300)}`
  );
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const graceHours = DEFAULT_GRACE_HOURS;
  const graceMs = graceHours * 60 * 60 * 1000;
  const cutoff = Date.now() - graceMs;

  const config = getBunnyConfig();
  console.log(`[bunny-orphan-cleanup] Starting (${dryRun ? 'dry-run' : 'delete mode'})`);
  console.log(`[bunny-orphan-cleanup] Grace period: ${graceHours}h`);

  const expiredBillingCleanup = await cleanupExpiredBillingWorkspaces({ dryRun });
  console.log(
    `[bunny-orphan-cleanup] Expired owner workspaces scanned: ${expiredBillingCleanup.scanned}`
  );
  console.log(
    `[bunny-orphan-cleanup] Expired owner workspaces deleted: ${expiredBillingCleanup.deleted}`
  );

  const { videos, scanned, skippedInvalid } = await listBunnyVideos(config);
  const eligible = videos.filter((video) => video.uploadedAt.getTime() <= cutoff);
  console.log(`[bunny-orphan-cleanup] Scanned: ${scanned}`);
  console.log(`[bunny-orphan-cleanup] Skipped invalid metadata: ${skippedInvalid}`);
  console.log(`[bunny-orphan-cleanup] Eligible (old enough): ${eligible.length}`);

  if (eligible.length === 0) {
    console.log('[bunny-orphan-cleanup] No eligible Bunny videos found');
    return;
  }

  const eligibleIds = eligible.map((video) => video.id);
  const referenced = await findReferencedVideoIds(eligibleIds);

  const orphanIds = eligibleIds.filter((id) => !referenced.has(id));
  let deleted = 0;
  let alreadyMissing = 0;
  let failed = 0;

  for (const orphanId of orphanIds) {
    if (dryRun) continue;

    try {
      const result = await deleteBunnyVideo(config, orphanId);
      if (result === 'already_missing') {
        alreadyMissing += 1;
      } else {
        deleted += 1;
      }
    } catch (error) {
      failed += 1;
      logError(`[bunny-orphan-cleanup] Failed deleting ${orphanId}:`, error);
    }
  }

  console.log('[bunny-orphan-cleanup] Summary');
  console.log(`[bunny-orphan-cleanup] Referenced: ${referenced.size}`);
  console.log(`[bunny-orphan-cleanup] Orphaned: ${orphanIds.length}`);
  console.log(`[bunny-orphan-cleanup] Deleted: ${deleted}`);
  console.log(`[bunny-orphan-cleanup] Already missing: ${alreadyMissing}`);
  console.log(`[bunny-orphan-cleanup] Failed: ${failed}`);
}

main()
  .catch((error) => {
    logError('[bunny-orphan-cleanup] Fatal error:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDb();
  });
