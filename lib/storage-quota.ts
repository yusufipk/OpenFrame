import type { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiErrors } from '@/lib/api-response';
import { isStripeFeatureEnabled } from '@/lib/feature-flags';
import { getCachedUserBunnyStorage } from '@/lib/admin-stats';

// 200 GB expressed in bytes
export const PLAN_STORAGE_LIMIT_BYTES = BigInt(200) * BigInt(1024) * BigInt(1024) * BigInt(1024);

// TTL for upload reservations: 30 minutes is enough for R2 image/audio uploads
const RESERVATION_TTL_MS = 30 * 60 * 1000;

// Sentinel error thrown inside a Prisma transaction to signal quota exceeded
class QuotaExceededError extends Error {}

/**
 * Returns total bytes used by a given billed user across R2 (image + audio),
 * Bunny Stream, and any active (non-expired) upload reservations.
 * Uses the cached Bunny stats (10-min TTL) to avoid calling the Bunny API on
 * every upload.
 */
export async function getUserTotalStorageBytes(userId: string): Promise<bigint> {
  const [r2Rows, bunnyByUser, reservationRows] = await Promise.all([
    db.$queryRaw<[{ total: bigint }]>`
      SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
      FROM video_assets
      WHERE "billedUserId" = ${userId}
        AND provider IN ('R2_IMAGE', 'R2_AUDIO')
    `,
    getCachedUserBunnyStorage(),
    db.$queryRaw<[{ total: bigint }]>`
      SELECT COALESCE(SUM("sizeBytes"), 0)::bigint AS total
      FROM upload_reservations
      WHERE "billedUserId" = ${userId}
        AND "expiresAt" > NOW()
    `,
  ]);

  const r2Bytes = r2Rows[0]?.total ?? BigInt(0);
  const bunnyBytes = BigInt(bunnyByUser[userId] ?? 0);
  const reservedBytes = reservationRows[0]?.total ?? BigInt(0);

  return r2Bytes + bunnyBytes + reservedBytes;
}

/**
 * Returns storage usage info for a user in a UI-friendly shape.
 */
export async function getUserStorageInfo(userId: string): Promise<{
  usedBytes: bigint;
  limitBytes: bigint;
  percentage: number;
}> {
  const usedBytes = await getUserTotalStorageBytes(userId);
  const limitBytes = PLAN_STORAGE_LIMIT_BYTES;
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

  const usedBytes = await getUserTotalStorageBytes(userId);

  if (usedBytes + incomingSizeBytes >= PLAN_STORAGE_LIMIT_BYTES) {
    return apiErrors.storageExceeded() as NextResponse;
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
  incomingSizeBytes: bigint
): Promise<{ reservationId: string | null } | { error: NextResponse }> {
  if (!isStripeFeatureEnabled()) {
    return { reservationId: null };
  }

  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);

  // Fetch Bunny storage BEFORE entering the transaction to avoid holding the
  // advisory lock during a potentially slow/failing HTTP call on cache miss.
  const bunnyData = await getCachedUserBunnyStorage();
  const bunnyBytes = BigInt(bunnyData[userId] ?? 0);

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
      const [r2Row] = await tx.$queryRaw<[{ total: bigint }]>`
        SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
        FROM video_assets
        WHERE "billedUserId" = ${userId}
          AND provider IN ('R2_IMAGE', 'R2_AUDIO')
      `;
      const r2Bytes = r2Row?.total ?? BigInt(0);

      // Read active (non-expired) reservations under the same lock
      const [resRow] = await tx.$queryRaw<[{ total: bigint }]>`
        SELECT COALESCE(SUM("sizeBytes"), 0)::bigint AS total
        FROM upload_reservations
        WHERE "billedUserId" = ${userId}
          AND "expiresAt" > NOW()
      `;
      const reservedBytes = resRow?.total ?? BigInt(0);

      const totalUsed = r2Bytes + reservedBytes + bunnyBytes;
      if (totalUsed + incomingSizeBytes >= PLAN_STORAGE_LIMIT_BYTES) {
        throw new QuotaExceededError();
      }

      const reservation = await tx.uploadReservation.create({
        data: { billedUserId: userId, sizeBytes: incomingSizeBytes, expiresAt },
        select: { id: true },
      });

      return reservation.id;
    });

    return { reservationId };
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      return { error: apiErrors.storageExceeded() as NextResponse };
    }
    throw e;
  }
}

/**
 * Deletes an upload reservation created by `reserveStorageQuota`.
 * Safe to call with `null` (no-op) for flows where billing is disabled.
 */
export async function releaseStorageReservation(reservationId: string | null): Promise<void> {
  if (!reservationId) return;
  await db.uploadReservation.deleteMany({ where: { id: reservationId } });
}
