import { db } from '@/lib/db';

/** How far back "uploaders" looks, for both the admin users table and the scoreboard. */
export const UPLOADER_WINDOW_DAYS = 30;

/**
 * Distinct people who added a video or a version to each account's workspaces
 * since `since`, keyed by the workspace owner. The owner counts as one of them
 * when they upload too, so 1 means a solo account and anything above it means a
 * team is working inside it.
 *
 * Versions created before uploaders were recorded have a NULL uploader and are
 * skipped, so a window reaching back past that point undercounts.
 */
export async function getUploaderCountsByAccount(since: Date): Promise<Record<string, number>> {
  const rows = await db.$queryRaw<Array<{ owner_id: string; uploaders: number }>>`
    SELECT w."ownerId" AS owner_id,
           COUNT(DISTINCT vv.uploaded_by_id)::int AS uploaders
    FROM video_versions vv
    JOIN videos v ON v.id = vv."videoParentId"
    JOIN projects p ON p.id = v."projectId"
    JOIN workspaces w ON w.id = p."workspaceId"
    WHERE vv.uploaded_by_id IS NOT NULL
      AND vv."createdAt" >= ${since}
    GROUP BY w."ownerId"
  `;

  return Object.fromEntries(rows.map((row) => [row.owner_id, row.uploaders]));
}

export function uploaderWindowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - UPLOADER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}
