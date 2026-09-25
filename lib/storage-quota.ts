import type { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiErrors } from '@/lib/api-response';
import {
  DEFAULT_MAX_VIDEO_UPLOAD_BYTES,
  getConfiguredMaxVideoUploadBytes,
  isStripeFeatureEnabled,
} from '@/lib/feature-flags';
import { getUserBunnyStorageBytes } from '@/lib/admin-stats';
import { isPaidTier } from '@/lib/billing';
import { getStorageLimitBytes } from '@/lib/trial-limits';
import { formatSizeLimit } from '@/lib/upload-size';

// 200 GB expressed in bytes
export const PLAN_STORAGE_LIMIT_BYTES = BigInt(200) * BigInt(1024) * BigInt(1024) * BigInt(1024);

/**
 * The ceiling this particular account is held to.
 *
 * A cardless trial gets a much smaller one: it is the only thing standing between
 * a throwaway signup and 200 GB of our storage. Reads the two billing columns
 * directly rather than taking a flag from the caller, so no upload route can
 * forget to pass it.
 */
export async function getStorageLimitForUser(userId: string): Promise<bigint> {
  return (await getStorageContextForUser(userId)).limitBytes;
}

export interface StorageContext {
  /** The ceiling this account is held to. */
  limitBytes: bigint;
  /** Whether that ceiling is the plan's or the trial's. */
  isPaid: boolean;
}

/**
 * The ceiling and the reason for it, read together.
 *
 * The two travel as a pair because a refusal has to say which one it is: an
 * unpaid account is out of room because it has not subscribed, and telling it to
 * delete files is advice that does not apply.
 */
export async function getStorageContextForUser(userId: string): Promise<StorageContext> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { subscriptionStatus: true, stripeCurrentPeriodEnd: true, billingAccessEndedAt: true },
  });

  const isPaid = user ? isPaidTier(user) : false;
  return { limitBytes: getStorageLimitBytes(isPaid, PLAN_STORAGE_LIMIT_BYTES), isPaid };
}

/**
 * The share of an account's storage ceiling one single upload may take.
 *
 * A video costs more than the file that was handed to us: the provider derives
 * its own renditions from it (1080p, 720p and down) and those land in the same
 * account's usage. A file allowed to fill the whole quota would therefore be
 * over the quota by the time it finished processing, so a fifth of the ceiling
 * is left free for what the upload turns into.
 */
export const MAX_UPLOAD_SHARE_PERCENT = BigInt(80);

/** The largest single file that fits under `limitBytes` with room to transcode. */
export function getMaxUploadBytesForLimit(limitBytes: bigint): bigint {
  return (limitBytes * MAX_UPLOAD_SHARE_PERCENT) / BigInt(100);
}

/**
 * The largest single file this account may upload.
 *
 * Derived from the account's own ceiling rather than fixed, so the answer moves
 * with the plan: 200 GB of storage allows a 160 GB file, and a cardless trial's
 * 3 GB allows 2.4 GB. A host that has pinned an absolute cap still wins where
 * it is the lower of the two, and a host running without billing has no quota
 * to divide, so it falls back to the flat default.
 */
export async function getMaxVideoUploadBytesForUser(userId: string): Promise<bigint> {
  const hostCeiling = getConfiguredMaxVideoUploadBytes();

  if (!isStripeFeatureEnabled()) {
    return hostCeiling ?? DEFAULT_MAX_VIDEO_UPLOAD_BYTES;
  }

  const { limitBytes } = await getStorageContextForUser(userId);
  const quotaCeiling = getMaxUploadBytesForLimit(limitBytes);

  return hostCeiling !== null && hostCeiling < quotaCeiling ? hostCeiling : quotaCeiling;
}

/**
 * The refusal, in the words that fit the account it is being given to.
 *
 * A paying account that has filled 200 GB has to delete something. An unpaid one
 * has three gigabytes because it has not subscribed, so the way out is the
 * subscription, and the response says so under its own error code rather than
 * leaving the client to guess from the number.
 */
export function storageExceededResponse(context: StorageContext): NextResponse {
  if (context.isPaid) {
    return apiErrors.storageExceeded() as NextResponse;
  }

  return apiErrors.trialStorageExceeded(
    `Your free trial includes ${formatSizeLimit(context.limitBytes)} of storage. ` +
      `Upgrade to get ${formatSizeLimit(PLAN_STORAGE_LIMIT_BYTES)}.`
  ) as NextResponse;
}

// TTL for upload reservations: 30 minutes is enough for R2 image/audio uploads
const RESERVATION_TTL_MS = 30 * 60 * 1000;

/**
 * What a hold was opened for.
 *
 * A reservation is only ever consumed by the flow that opened it, and the
 * finalize routes match on this as well as on the id. Without it, naming a
 * reservation would be enough to drop it: the asset route takes a reservation id
 * from the request body, and every hold an account owns is billed to the same
 * user, so an image being attached could quietly release a video upload that was
 * still in flight. The ids are not secret. Two of them are handed to the client
 * outright, and the rest ride inside signed-but-readable token payloads.
 */
export const UPLOAD_RESERVATION_PURPOSES = {
  /** A comment attachment or standalone image going to R2. */
  IMAGE: 'IMAGE',
  /** A voice note going to R2. */
  AUDIO: 'AUDIO',
  /** Image and voice attachments weighed together when a comment is posted. */
  ATTACHMENT: 'ATTACHMENT',
  /** A presigned direct upload to our own S3-compatible storage. */
  R2_VIDEO: 'R2_VIDEO',
  /** A direct upload to Bunny, where the bytes never pass through us. */
  BUNNY: 'BUNNY',
  /** A subtitle track, which lands in our own S3-compatible storage whatever hosts the video. */
  SUBTITLE: 'SUBTITLE',
} as const;

export type UploadReservationPurpose =
  (typeof UPLOAD_RESERVATION_PURPOSES)[keyof typeof UPLOAD_RESERVATION_PURPOSES];

// Sentinel error thrown inside a Prisma transaction to signal quota exceeded
class QuotaExceededError extends Error {}

/**
 * Returns total bytes used by a given billed user across R2 (image + audio),
 * Bunny Stream, and any active (non-expired) upload reservations.
 * Uses the cached Bunny stats (10-min TTL) to avoid calling the Bunny API on
 * every upload.
 */
export async function getUserTotalStorageBytes(userId: string): Promise<bigint> {
  const [r2AssetRows, r2VideoRows, subtitleRows, bunnyUserBytes, reservationRows] =
    await Promise.all([
      db.$queryRaw<[{ total: bigint }]>`
      SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
      FROM video_assets
      WHERE "billedUserId" = ${userId}
        AND provider IN ('R2_IMAGE', 'R2_AUDIO', 'R2_VIDEO')
    `,
      db.$queryRaw<[{ total: bigint }]>`
      SELECT COALESCE(SUM(vv.size_bytes + vv.thumbnail_size_bytes), 0)::bigint AS total
      FROM video_versions vv
      INNER JOIN videos v ON v.id = vv."videoParentId"
      INNER JOIN projects p ON p.id = v."projectId"
      INNER JOIN workspaces w ON w.id = p."workspaceId"
      WHERE w."ownerId" = ${userId}
        AND vv."providerId" IN ('r2', 'r2-image')
    `,
      db.$queryRaw<[{ total: bigint }]>`
      SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
      FROM video_subtitles
      WHERE "billedUserId" = ${userId}
    `,
      getUserBunnyStorageBytes(userId),
      db.$queryRaw<[{ total: bigint }]>`
      SELECT COALESCE(SUM("sizeBytes"), 0)::bigint AS total
      FROM upload_reservations
      WHERE "billedUserId" = ${userId}
        AND "expiresAt" > NOW()
    `,
    ]);

  const r2AssetBytes = r2AssetRows[0]?.total ?? BigInt(0);
  const r2VideoBytes = r2VideoRows[0]?.total ?? BigInt(0);
  const subtitleBytes = subtitleRows[0]?.total ?? BigInt(0);
  const bunnyBytes = BigInt(bunnyUserBytes);
  const reservedBytes = reservationRows[0]?.total ?? BigInt(0);

  return r2AssetBytes + r2VideoBytes + subtitleBytes + bunnyBytes + reservedBytes;
}

/**
 * Returns storage usage info for a user in a UI-friendly shape.
 */
export async function getUserStorageInfo(userId: string): Promise<{
  usedBytes: bigint;
  limitBytes: bigint;
  percentage: number;
}> {
  const [usedBytes, limitBytes] = await Promise.all([
    getUserTotalStorageBytes(userId),
    getStorageLimitForUser(userId),
  ]);
  const percentage =
    limitBytes > BigInt(0)
      ? Math.min(100, Number((usedBytes * BigInt(10000)) / limitBytes) / 100)
      : 0;

  return { usedBytes, limitBytes, percentage };
}

/**
 * Checks whether the user can upload `incomingSizeBytes` more data.
 *
 * Returns a 507 response if the quota would be exceeded, or `null` if the
 * upload is allowed. When Stripe is disabled the check is always skipped so
 * self-hosted instances without billing still work.
 *
 * Uses `>=` so a user at exactly the limit cannot initiate new uploads.
 */
export async function enforceStorageQuota(
  userId: string,
  incomingSizeBytes: bigint
): Promise<NextResponse | null> {
  if (!isStripeFeatureEnabled()) {
    return null;
  }

  const [usedBytes, storage] = await Promise.all([
    getUserTotalStorageBytes(userId),
    getStorageContextForUser(userId),
  ]);

  if (usedBytes + incomingSizeBytes >= storage.limitBytes) {
    return storageExceededResponse(storage);
  }

  return null;
}

/**
 * Atomically checks the quota and records an in-flight upload reservation.
 *
 * Uses a PostgreSQL advisory transaction lock (per user) so concurrent callers
 * are serialised: the second request sees the first reservation in the sum and
 * cannot double-book the same headroom.
 *
 * Returns `{ reservationId }` on success or `{ error }` (a 507 NextResponse)
 * when the quota would be exceeded. Call `releaseStorageReservation` to delete
 * the reservation once the paired asset is committed (or if the upload fails).
 *
 * When Stripe is disabled the check is skipped and `reservationId` is `null`.
 */
export async function reserveStorageQuota(
  userId: string,
  incomingSizeBytes: bigint,
  purpose: UploadReservationPurpose,
  reservationTtlMs: number = RESERVATION_TTL_MS
): Promise<{ reservationId: string | null } | { error: NextResponse }> {
  if (!isStripeFeatureEnabled()) {
    return { reservationId: null };
  }

  const expiresAt = new Date(Date.now() + reservationTtlMs);

  // Fetch Bunny storage and the account's ceiling BEFORE entering the transaction,
  // to avoid holding the advisory lock during a potentially slow/failing HTTP call
  // on cache miss or an extra round trip to Postgres.
  const [bunnyUserBytes, storage] = await Promise.all([
    getUserBunnyStorageBytes(userId),
    getStorageContextForUser(userId),
  ]);
  const bunnyBytes = BigInt(bunnyUserBytes);

  try {
    const reservationId = await db.$transaction(async (tx) => {
      // Serialise quota checks for this user via a per-user advisory lock.
      // Combine two 32-bit hashtext() halves into a single 64-bit bigint to
      // eliminate the 32-bit hash-space collision risk of plain hashtext().
      // Use $executeRaw — the function returns void which $queryRaw cannot deserialize.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          ('x' || left(md5(${userId}), 16))::bit(64)::bigint
        )
      `;

      // Read committed R2 storage under the lock
      const [r2AssetRow] = await tx.$queryRaw<[{ total: bigint }]>`
        SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
        FROM video_assets
        WHERE "billedUserId" = ${userId}
          AND provider IN ('R2_IMAGE', 'R2_AUDIO', 'R2_VIDEO')
      `;
      const [r2VideoRow] = await tx.$queryRaw<[{ total: bigint }]>`
        SELECT COALESCE(SUM(vv.size_bytes + vv.thumbnail_size_bytes), 0)::bigint AS total
        FROM video_versions vv
        INNER JOIN videos v ON v.id = vv."videoParentId"
        INNER JOIN projects p ON p.id = v."projectId"
        INNER JOIN workspaces w ON w.id = p."workspaceId"
        WHERE w."ownerId" = ${userId}
          AND vv."providerId" IN ('r2', 'r2-image')
      `;
      const [subtitleRow] = await tx.$queryRaw<[{ total: bigint }]>`
        SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
        FROM video_subtitles
        WHERE "billedUserId" = ${userId}
      `;
      const r2Bytes =
        (r2AssetRow?.total ?? BigInt(0)) +
        (r2VideoRow?.total ?? BigInt(0)) +
        (subtitleRow?.total ?? BigInt(0));

      // Read active (non-expired) reservations under the same lock
      const [resRow] = await tx.$queryRaw<[{ total: bigint }]>`
        SELECT COALESCE(SUM("sizeBytes"), 0)::bigint AS total
        FROM upload_reservations
        WHERE "billedUserId" = ${userId}
          AND "expiresAt" > NOW()
      `;
      const reservedBytes = resRow?.total ?? BigInt(0);

      const totalUsed = r2Bytes + reservedBytes + bunnyBytes;
      if (totalUsed + incomingSizeBytes >= storage.limitBytes) {
        throw new QuotaExceededError();
      }

      const reservation = await tx.uploadReservation.create({
        data: { billedUserId: userId, sizeBytes: incomingSizeBytes, expiresAt, purpose },
        select: { id: true },
      });

      return reservation.id;
    });

    return { reservationId };
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      return { error: storageExceededResponse(storage) };
    }
    throw e;
  }
}

/**
 * Deletes an upload reservation created by `reserveStorageQuota`.
 * Safe to call with `null` (no-op) for flows where billing is disabled.
 *
 * Pass the purpose wherever the caller knows it. A release that names only an id
 * will delete a hold opened for something else, which is the same hole the
 * purpose column exists to close.
 */
export async function releaseStorageReservation(
  reservationId: string | null,
  billedUserId?: string | null,
  purpose?: UploadReservationPurpose
): Promise<void> {
  if (!reservationId) return;
  await db.uploadReservation.deleteMany({
    where: {
      id: reservationId,
      ...(billedUserId ? { billedUserId } : {}),
      ...(purpose ? { purpose } : {}),
    },
  });
}
