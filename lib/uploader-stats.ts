import { db } from '@/lib/db';

/** How far back "uploaders" looks, for both the admin users table and the scoreboard. */
export const UPLOADER_WINDOW_DAYS = 30;

export interface TeamUploader {
  userId: string;
  name: string | null;
  email: string | null;
}

/**
 * Distinct collaborators who added a video or version to each account's
 * workspaces since `since`, keyed by the workspace owner. The workspace owner
 * is excluded. This records upload activity, not current membership.
 *
 * Versions created before uploaders were recorded have a NULL uploader and are
 * skipped, so a window reaching back past that point undercounts.
 */
export async function getTeamUploadersByAccount(
  since: Date
): Promise<Record<string, TeamUploader[]>> {
  const rows = await db.$queryRaw<
    Array<{ owner_id: string; user_id: string; name: string | null; email: string | null }>
  >`
    SELECT DISTINCT w."ownerId" AS owner_id, u.id AS user_id, u.name, u.email
    FROM video_versions vv
    JOIN videos v ON v.id = vv."videoParentId"
    JOIN projects p ON p.id = v."projectId"
    JOIN workspaces w ON w.id = p."workspaceId"
    JOIN users u ON u.id = vv.uploaded_by_id
    WHERE vv.uploaded_by_id <> w."ownerId"
      AND vv."createdAt" >= ${since}
    ORDER BY owner_id, u.name NULLS LAST, u.email NULLS LAST, user_id
  `;

  const uploaders = new Map<string, TeamUploader[]>();
  for (const row of rows) {
    const account = uploaders.get(row.owner_id) ?? [];
    account.push({ userId: row.user_id, name: row.name, email: row.email });
    uploaders.set(row.owner_id, account);
  }
  return Object.fromEntries(uploaders);
}

export async function getUploaderCountsByAccount(since: Date): Promise<Record<string, number>> {
  const uploaders = await getTeamUploadersByAccount(since);
  return Object.fromEntries(
    Object.entries(uploaders).map(([ownerId, team]) => [ownerId, team.length])
  );
}

export function uploaderWindowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - UPLOADER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}
