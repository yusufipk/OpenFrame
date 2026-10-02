import { Metadata } from 'next';
import { Prisma, BillingSubscriptionStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { isBunnyUploadsFeatureEnabled, isStripeBillingEnabled } from '@/lib/feature-flags';
import {
  buildBillingAccessWhereInput,
  buildEffectiveBillingStatusWhereInput,
  getBillingStatusLabel,
  getEffectiveBillingStatus,
  hasBillingAccess,
} from '@/lib/billing';
import { redirect } from 'next/navigation';
import {
  getCachedBunnyStorageStats,
  getCachedUserBunnyStorage,
  getCachedUserDownloadEgress,
  getCachedUserMediaStorage,
} from '@/lib/admin-stats';
import {
  getUploaderCountsByAccount,
  UPLOADER_WINDOW_DAYS,
  uploaderWindowStart,
} from '@/lib/uploader-stats';
import { Film, HardDrive } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { format } from 'date-fns';

function getBillingStatusVariant(
  status: BillingSubscriptionStatus
): 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' {
  switch (status) {
    case BillingSubscriptionStatus.ACTIVE:
      return 'default';
    case BillingSubscriptionStatus.TRIALING:
    case BillingSubscriptionStatus.INCOMPLETE:
      return 'secondary';
    case BillingSubscriptionStatus.PAST_DUE:
    case BillingSubscriptionStatus.UNPAID:
      return 'destructive';
    case BillingSubscriptionStatus.CANCELED:
    case BillingSubscriptionStatus.INCOMPLETE_EXPIRED:
      return 'outline';
    case BillingSubscriptionStatus.FREE:
    default:
      return 'ghost';
  }
}

function getOwnBillingAccess(
  user: {
    subscriptionStatus: BillingSubscriptionStatus;
    trialEndsAt: Date | null;
    stripeCurrentPeriodEnd: Date | null;
    stripeCancelAtPeriodEnd: boolean;
    stripeCancelAt: Date | null;
    billingAccessEndedAt: Date | null;
  },
  now: Date
): { ownAccess: boolean; endsAt: Date | null } {
  if (!hasBillingAccess(user, now)) {
    return { ownAccess: false, endsAt: null };
  }

  const isEnding =
    user.stripeCancelAtPeriodEnd || user.subscriptionStatus === BillingSubscriptionStatus.CANCELED;

  let endsAt: Date | null = null;
  // The effective status, so a cardless trial (stored as FREE) still shows the
  // date its access runs out instead of an open-ended "Active access".
  if (getEffectiveBillingStatus(user, now) === BillingSubscriptionStatus.TRIALING) {
    endsAt = user.trialEndsAt;
  } else if (isEnding) {
    endsAt = user.stripeCurrentPeriodEnd ?? user.stripeCancelAt;
  }

  return { ownAccess: true, endsAt };
}

export const metadata: Metadata = {
  title: 'Manage Users | Admin',
};

type SortBy =
  | 'user'
  | 'subscription'
  | 'joinedDate'
  | 'workspacesOwned'
  | 'invitedMembers'
  | 'uploaders'
  | 'projectsOwned'
  | 'totalComments'
  | 'bunnyUpload'
  | 'downloadEgress'
  | 'mediaStorage';

type SortDirection = 'asc' | 'desc';

type StatusFilter = 'ALL' | BillingSubscriptionStatus;
type AccessFilter = 'ALL' | 'ACTIVE' | 'NONE';

// Order the badges the way an admin scans them: paying first, problems next,
// churned last.
const STATUS_FILTERS: BillingSubscriptionStatus[] = [
  BillingSubscriptionStatus.ACTIVE,
  BillingSubscriptionStatus.TRIALING,
  BillingSubscriptionStatus.PAST_DUE,
  BillingSubscriptionStatus.UNPAID,
  BillingSubscriptionStatus.CANCELED,
  BillingSubscriptionStatus.INCOMPLETE,
  BillingSubscriptionStatus.INCOMPLETE_EXPIRED,
  BillingSubscriptionStatus.FREE,
];

// Sorting by subscription happens in memory (see canSortInDb), so the order the
// database would have used for the enum has to be spelled out. Same order as the
// enum is declared in the schema.
const STATUS_SORT_ORDER: BillingSubscriptionStatus[] = [
  BillingSubscriptionStatus.FREE,
  BillingSubscriptionStatus.TRIALING,
  BillingSubscriptionStatus.ACTIVE,
  BillingSubscriptionStatus.PAST_DUE,
  BillingSubscriptionStatus.CANCELED,
  BillingSubscriptionStatus.UNPAID,
  BillingSubscriptionStatus.INCOMPLETE,
  BillingSubscriptionStatus.INCOMPLETE_EXPIRED,
];

const ACCESS_FILTERS: Array<{ value: AccessFilter; label: string }> = [
  { value: 'ALL', label: 'All Access' },
  { value: 'ACTIVE', label: 'Has Access' },
  { value: 'NONE', label: 'No Access' },
];

const MAX_QUERY_LENGTH = 120;

const SORTABLE_COLUMNS: SortBy[] = [
  'user',
  'subscription',
  'joinedDate',
  'workspacesOwned',
  'invitedMembers',
  'uploaders',
  'projectsOwned',
  'totalComments',
  'bunnyUpload',
  'downloadEgress',
  'mediaStorage',
];

function formatBytes(bytes: number, decimals = 2) {
  if (bytes < 0) return 'Error Fetching';
  if (!+bytes) return '0 Bytes';
  const k = 1000;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function isSortBy(value: string | undefined): value is SortBy {
  return !!value && SORTABLE_COLUMNS.includes(value as SortBy);
}

function getDefaultSortDirection(sortBy: SortBy): SortDirection {
  return sortBy === 'user' ? 'asc' : 'desc';
}

function parseQuery(value: string | undefined): string {
  return (value ?? '').trim().slice(0, MAX_QUERY_LENGTH);
}

function parseStatusFilter(value: string | undefined): StatusFilter {
  return STATUS_FILTERS.includes(value as BillingSubscriptionStatus)
    ? (value as BillingSubscriptionStatus)
    : 'ALL';
}

function parseAccessFilter(value: string | undefined): AccessFilter {
  return value === 'ACTIVE' || value === 'NONE' ? value : 'ALL';
}

/**
 * User ids that have in-app access through somebody else's paid workspace or
 * project. Mirrors hasCollaboratorBillingBackedAccess in lib/route-access.ts,
 * but resolves every user in two queries instead of two queries per user, so
 * the same set can back both the table column and the access filter.
 */
async function getCollaboratorAccessUserIds(now: Date): Promise<Set<string>> {
  const payingOwner = buildBillingAccessWhereInput(now);

  const [workspaces, projects] = await Promise.all([
    db.workspace.findMany({
      where: { owner: payingOwner },
      select: { ownerId: true, members: { select: { userId: true } } },
    }),
    db.project.findMany({
      where: { workspace: { owner: payingOwner } },
      select: {
        ownerId: true,
        members: { select: { userId: true } },
        workspace: { select: { members: { select: { userId: true } } } },
      },
    }),
  ]);

  const userIds = new Set<string>();

  for (const workspace of workspaces) {
    userIds.add(workspace.ownerId);
    for (const member of workspace.members) userIds.add(member.userId);
  }

  for (const project of projects) {
    userIds.add(project.ownerId);
    for (const member of project.members) userIds.add(member.userId);
    for (const member of project.workspace.members) userIds.add(member.userId);
  }

  return userIds;
}

function getSortIndicator(
  column: SortBy,
  activeSortBy: SortBy,
  activeSortDirection: SortDirection
): string {
  if (column !== activeSortBy) return '↕';
  return activeSortDirection === 'asc' ? '↑' : '↓';
}

function canSortInDb(sortBy: SortBy): boolean {
  return (
    sortBy === 'user' ||
    // 'subscription' is deliberately absent: it sorts on the effective status,
    // which lives on trialEndsAt as much as on the stored column, so a cardless
    // trial would otherwise sort among the free accounts it is not shown with.
    sortBy === 'joinedDate' ||
    sortBy === 'workspacesOwned' ||
    sortBy === 'projectsOwned' ||
    sortBy === 'totalComments'
  );
}

function getUsersOrderBy(
  sortBy: SortBy,
  sortDirection: SortDirection
): Prisma.UserOrderByWithRelationInput[] {
  const createdAtTieBreaker: Prisma.UserOrderByWithRelationInput = { createdAt: 'desc' };

  if (sortBy === 'user') {
    return [{ name: sortDirection }, { email: sortDirection }, createdAtTieBreaker];
  }

  if (sortBy === 'joinedDate') {
    return [{ createdAt: sortDirection }];
  }

  if (sortBy === 'workspacesOwned') {
    return [{ ownedWorkspaces: { _count: sortDirection } }, createdAtTieBreaker];
  }

  if (sortBy === 'projectsOwned') {
    return [{ projects: { _count: sortDirection } }, createdAtTieBreaker];
  }

  if (sortBy === 'totalComments') {
    return [{ comments: { _count: sortDirection } }, createdAtTieBreaker];
  }

  return [createdAtTieBreaker];
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    sortBy?: string;
    sortDirection?: string;
    q?: string;
    status?: string;
    access?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.isAdmin) {
    redirect('/');
  }

  const resolvedSearchParams = await searchParams;
  const requestedPage = Number(resolvedSearchParams?.page) || 1;
  const sortBy: SortBy = isSortBy(resolvedSearchParams?.sortBy)
    ? resolvedSearchParams.sortBy
    : 'joinedDate';
  const sortDirection: SortDirection =
    resolvedSearchParams?.sortDirection === 'asc' || resolvedSearchParams?.sortDirection === 'desc'
      ? resolvedSearchParams.sortDirection
      : getDefaultSortDirection(sortBy);
  const pageSize = 20;
  const stripeBillingEnabled = isStripeBillingEnabled();
  const now = new Date();

  const query = parseQuery(resolvedSearchParams?.q);
  // Subscription/access are only meaningful (and only rendered) when billing is on.
  const statusFilter: StatusFilter = stripeBillingEnabled
    ? parseStatusFilter(resolvedSearchParams?.status)
    : 'ALL';
  const accessFilter: AccessFilter = stripeBillingEnabled
    ? parseAccessFilter(resolvedSearchParams?.access)
    : 'ALL';
  const hasActiveFilters = Boolean(query) || statusFilter !== 'ALL' || accessFilter !== 'ALL';

  // Access is not just the user's own subscription: a user with no billing of
  // their own still has access as a collaborator on a paying owner's workspace
  // or project (mirrors hasAppNavigationAccess in lib/route-access.ts).
  const collaboratorAccessUserIds = stripeBillingEnabled
    ? await getCollaboratorAccessUserIds(now)
    : new Set<string>();

  const filters: Prisma.UserWhereInput[] = [];

  if (query) {
    filters.push({
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { email: { contains: query, mode: 'insensitive' } },
      ],
    });
  }

  if (statusFilter !== 'ALL') {
    filters.push(buildEffectiveBillingStatusWhereInput(statusFilter, now));
  }

  if (accessFilter !== 'ALL') {
    const hasAccess: Prisma.UserWhereInput = {
      OR: [
        buildBillingAccessWhereInput(now),
        { id: { in: Array.from(collaboratorAccessUserIds) } },
      ],
    };
    filters.push(accessFilter === 'ACTIVE' ? hasAccess : { NOT: hasAccess });
  }

  const where: Prisma.UserWhereInput = filters.length > 0 ? { AND: filters } : {};

  const [
    totalUsers,
    matchingUsers,
    userStorage,
    userBunnyStorage,
    userDownloadEgress,
    bunnyStorageStats,
    uploaderCounts,
  ] = await Promise.all([
    db.user.count(),
    db.user.count({ where }),
    getCachedUserMediaStorage(),
    getCachedUserBunnyStorage(),
    getCachedUserDownloadEgress(),
    getCachedBunnyStorageStats(),
    getUploaderCountsByAccount(uploaderWindowStart(now)),
  ]);
  const totalPages = Math.max(1, Math.ceil(matchingUsers / pageSize));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const skip = (page - 1) * pageSize;

  const select = {
    id: true,
    name: true,
    email: true,
    createdAt: true,
    subscriptionStatus: true,
    trialEndsAt: true,
    stripeCurrentPeriodEnd: true,
    stripeCancelAtPeriodEnd: true,
    stripeCancelAt: true,
    billingAccessEndedAt: true,
    ownedWorkspaces: {
      select: {
        _count: {
          select: {
            members: true,
          },
        },
      },
    },
    _count: {
      select: {
        ownedWorkspaces: true,
        projects: true,
        comments: true,
      },
    },
  } satisfies Prisma.UserSelect;

  let paginatedUsers: Array<{
    id: string;
    name: string | null;
    email: string | null;
    createdAt: Date;
    subscriptionStatus: BillingSubscriptionStatus;
    effectiveStatus: BillingSubscriptionStatus;
    trialEndsAt: Date | null;
    stripeCurrentPeriodEnd: Date | null;
    stripeCancelAtPeriodEnd: boolean;
    stripeCancelAt: Date | null;
    billingAccessEndedAt: Date | null;
    ownedWorkspaces: Array<{ _count: { members: number } }>;
    _count: { ownedWorkspaces: number; projects: number; comments: number };
    invitedMembersCount: number;
    uploadersCount: number;
    bunnyUploadBytes: number;
    downloadEgressBytes: number;
    mediaStorageBytes: number;
  }> = [];

  if (canSortInDb(sortBy)) {
    const users = await db.user.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: getUsersOrderBy(sortBy, sortDirection),
      select,
    });

    paginatedUsers = users.map((user) => ({
      ...user,
      effectiveStatus: getEffectiveBillingStatus(user, now),
      invitedMembersCount: user.ownedWorkspaces.reduce(
        (total, workspace) => total + workspace._count.members,
        0
      ),
      uploadersCount: uploaderCounts[user.id] ?? 0,
      bunnyUploadBytes: userBunnyStorage[user.id] || 0,
      downloadEgressBytes: userDownloadEgress[user.id] || 0,
      mediaStorageBytes: userStorage[user.id]?.total || 0,
    }));
  } else {
    const users = await db.user.findMany({ where, select });

    const usersWithMetrics = users.map((user) => ({
      ...user,
      effectiveStatus: getEffectiveBillingStatus(user, now),
      invitedMembersCount: user.ownedWorkspaces.reduce(
        (total, workspace) => total + workspace._count.members,
        0
      ),
      uploadersCount: uploaderCounts[user.id] ?? 0,
      bunnyUploadBytes: userBunnyStorage[user.id] || 0,
      downloadEgressBytes: userDownloadEgress[user.id] || 0,
      mediaStorageBytes: userStorage[user.id]?.total || 0,
    }));

    const sortedUsers = usersWithMetrics.sort((a, b) => {
      let comparison = 0;

      if (sortBy === 'subscription') {
        comparison =
          STATUS_SORT_ORDER.indexOf(a.effectiveStatus) -
          STATUS_SORT_ORDER.indexOf(b.effectiveStatus);
      } else if (sortBy === 'invitedMembers') {
        comparison = a.invitedMembersCount - b.invitedMembersCount;
      } else if (sortBy === 'uploaders') {
        comparison = a.uploadersCount - b.uploadersCount;
      } else if (sortBy === 'bunnyUpload') {
        comparison = a.bunnyUploadBytes - b.bunnyUploadBytes;
      } else if (sortBy === 'downloadEgress') {
        comparison = a.downloadEgressBytes - b.downloadEgressBytes;
      } else if (sortBy === 'mediaStorage') {
        comparison = a.mediaStorageBytes - b.mediaStorageBytes;
      }

      if (comparison === 0) {
        comparison = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    paginatedUsers = sortedUsers.slice(skip, skip + pageSize);
  }

  // Resolve the real in-app access for each user on the current page.
  const accessByUserId = new Map<string, { hasAppAccess: boolean; viaCollaboration: boolean }>();
  if (stripeBillingEnabled) {
    for (const user of paginatedUsers) {
      const { ownAccess } = getOwnBillingAccess(user, now);
      const hasAppAccess = ownAccess || collaboratorAccessUserIds.has(user.id);
      accessByUserId.set(user.id, {
        hasAppAccess,
        viaCollaboration: hasAppAccess && !ownAccess,
      });
    }
  }

  const buildUsersPageHref = (
    targetPage: number,
    targetSortBy: SortBy = sortBy,
    targetSortDirection: SortDirection = sortDirection,
    targetQuery: string = query,
    targetStatus: StatusFilter = statusFilter,
    targetAccess: AccessFilter = accessFilter
  ): string => {
    const params = new URLSearchParams({
      page: String(targetPage),
      sortBy: targetSortBy,
      sortDirection: targetSortDirection,
    });

    if (targetQuery) params.set('q', targetQuery);
    if (targetStatus !== 'ALL') params.set('status', targetStatus);
    if (targetAccess !== 'ALL') params.set('access', targetAccess);

    return `/admin/users?${params.toString()}`;
  };

  const buildSortHref = (column: SortBy): string => {
    const nextDirection: SortDirection =
      column === sortBy
        ? sortDirection === 'asc'
          ? 'desc'
          : 'asc'
        : getDefaultSortDirection(column);

    return buildUsersPageHref(1, column, nextDirection);
  };

  const buildStatusHref = (targetStatus: StatusFilter): string =>
    buildUsersPageHref(1, sortBy, sortDirection, query, targetStatus, accessFilter);

  const buildAccessHref = (targetAccess: AccessFilter): string =>
    buildUsersPageHref(1, sortBy, sortDirection, query, statusFilter, targetAccess);

  const clearFiltersHref = buildUsersPageHref(1, sortBy, sortDirection, '', 'ALL', 'ALL');

  return (
    <div className="flex-1 space-y-4">
      <div className="flex items-center justify-between space-y-2">
        <h2 className="text-3xl font-bold tracking-tight">Users</h2>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Bunny Stream Storage</CardTitle>
            <Film className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isBunnyUploadsFeatureEnabled()
                ? formatBytes(bunnyStorageStats.totalBytes)
                : 'Disabled'}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Cloudflare R2 Media Storage</CardTitle>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatBytes(Object.values(userStorage).reduce((sum, item) => sum + item.total, 0))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <form method="get" action="/admin/users" className="flex items-center gap-2">
            <input type="hidden" name="sortBy" value={sortBy} />
            <input type="hidden" name="sortDirection" value={sortDirection} />
            {statusFilter !== 'ALL' && <input type="hidden" name="status" value={statusFilter} />}
            {accessFilter !== 'ALL' && <input type="hidden" name="access" value={accessFilter} />}
            <Input
              type="search"
              name="q"
              defaultValue={query}
              maxLength={MAX_QUERY_LENGTH}
              placeholder="Search by name or email…"
              aria-label="Search users by name or email"
              className="w-72"
            />
            <Button type="submit" size="sm">
              Search
            </Button>
          </form>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" asChild>
              <Link href={clearFiltersHref}>Clear filters</Link>
            </Button>
          )}
        </div>

        {stripeBillingEnabled && (
          <>
            <div className="flex flex-wrap gap-2">
              <Button variant={statusFilter === 'ALL' ? 'default' : 'outline'} size="sm" asChild>
                <Link href={buildStatusHref('ALL')}>All Statuses</Link>
              </Button>
              {STATUS_FILTERS.map((status) => (
                <Button
                  key={status}
                  variant={statusFilter === status ? 'default' : 'outline'}
                  size="sm"
                  asChild
                >
                  <Link href={buildStatusHref(status)}>{getBillingStatusLabel(status)}</Link>
                </Button>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              {ACCESS_FILTERS.map((filter) => (
                <Button
                  key={filter.value}
                  variant={accessFilter === filter.value ? 'default' : 'outline'}
                  size="sm"
                  asChild
                >
                  <Link href={buildAccessHref(filter.value)}>{filter.label}</Link>
                </Button>
              ))}
            </div>
          </>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Users</CardTitle>
          <CardDescription>
            {hasActiveFilters
              ? `${matchingUsers} of ${totalUsers} users match the current filters.`
              : `A comprehensive list of all ${totalUsers} users registered on the platform.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Link
                      href={buildSortHref('user')}
                      className="inline-flex items-center gap-1 hover:underline"
                    >
                      User
                      <span className="text-xs">
                        {getSortIndicator('user', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  {stripeBillingEnabled && (
                    <TableHead>
                      <Link
                        href={buildSortHref('subscription')}
                        className="inline-flex items-center gap-1 hover:underline"
                      >
                        Subscription
                        <span className="text-xs">
                          {getSortIndicator('subscription', sortBy, sortDirection)}
                        </span>
                      </Link>
                    </TableHead>
                  )}
                  <TableHead>
                    <Link
                      href={buildSortHref('joinedDate')}
                      className="inline-flex items-center gap-1 hover:underline"
                    >
                      Joined Date
                      <span className="text-xs">
                        {getSortIndicator('joinedDate', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-center">
                    <Link
                      href={buildSortHref('workspacesOwned')}
                      className="inline-flex items-center justify-center gap-1 hover:underline"
                    >
                      Workspaces Owned
                      <span className="text-xs">
                        {getSortIndicator('workspacesOwned', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-center">
                    <Link
                      href={buildSortHref('invitedMembers')}
                      className="inline-flex items-center justify-center gap-1 hover:underline"
                    >
                      Invited Members
                      <span className="text-xs">
                        {getSortIndicator('invitedMembers', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-center">
                    <Link
                      href={buildSortHref('uploaders')}
                      title={`Distinct people, owner included, who added a video or version to this account's workspaces in the last ${UPLOADER_WINDOW_DAYS} days. Uploads from before this was recorded are not counted.`}
                      className="inline-flex items-center justify-center gap-1 hover:underline"
                    >
                      Uploaders ({UPLOADER_WINDOW_DAYS}d)
                      <span className="text-xs">
                        {getSortIndicator('uploaders', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-center">
                    <Link
                      href={buildSortHref('projectsOwned')}
                      className="inline-flex items-center justify-center gap-1 hover:underline"
                    >
                      Projects Owned
                      <span className="text-xs">
                        {getSortIndicator('projectsOwned', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-center">
                    <Link
                      href={buildSortHref('totalComments')}
                      className="inline-flex items-center justify-center gap-1 hover:underline"
                    >
                      Total Comments
                      <span className="text-xs">
                        {getSortIndicator('totalComments', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-right">
                    <Link
                      href={buildSortHref('bunnyUpload')}
                      className="inline-flex items-center justify-end gap-1 hover:underline"
                    >
                      Bunny Upload
                      <span className="text-xs">
                        {getSortIndicator('bunnyUpload', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-right">
                    <Link
                      href={buildSortHref('downloadEgress')}
                      className="inline-flex items-center justify-end gap-1 hover:underline"
                    >
                      Download Egress (Est.)
                      <span className="text-xs">
                        {getSortIndicator('downloadEgress', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-right">
                    <Link
                      href={buildSortHref('mediaStorage')}
                      className="inline-flex items-center justify-end gap-1 hover:underline"
                    >
                      Media Storage
                      <span className="text-xs">
                        {getSortIndicator('mediaStorage', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedUsers.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={stripeBillingEnabled ? 11 : 10}
                      className="h-24 text-center"
                    >
                      {hasActiveFilters ? 'No users match these filters.' : 'No users found.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedUsers.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{user.name || 'Anonymous'}</span>
                          <span className="text-xs text-muted-foreground">{user.email}</span>
                        </div>
                      </TableCell>
                      {stripeBillingEnabled &&
                        (() => {
                          const { endsAt } = getOwnBillingAccess(user, now);
                          const access = accessByUserId.get(user.id) ?? {
                            hasAppAccess: false,
                            viaCollaboration: false,
                          };
                          return (
                            <TableCell>
                              <div className="flex flex-col items-start gap-1">
                                <Badge variant={getBillingStatusVariant(user.effectiveStatus)}>
                                  {getBillingStatusLabel(user.effectiveStatus)}
                                </Badge>
                                {access.hasAppAccess ? (
                                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                    Active access
                                    {access.viaCollaboration
                                      ? ' · via team'
                                      : endsAt
                                        ? ` · until ${format(new Date(endsAt), 'MMM dd')}`
                                        : ''}
                                  </span>
                                ) : (
                                  <span className="text-xs text-muted-foreground">No access</span>
                                )}
                              </div>
                            </TableCell>
                          );
                        })()}
                      <TableCell>{format(new Date(user.createdAt), 'MMM dd, yyyy')}</TableCell>
                      <TableCell className="text-center">{user._count.ownedWorkspaces}</TableCell>
                      <TableCell className="text-center">{user.invitedMembersCount}</TableCell>
                      <TableCell className="text-center">{user.uploadersCount}</TableCell>
                      <TableCell className="text-center">{user._count.projects}</TableCell>
                      <TableCell className="text-center">{user._count.comments}</TableCell>
                      <TableCell className="text-right text-sm font-medium">
                        {formatBytes(user.bunnyUploadBytes)}
                      </TableCell>
                      <TableCell className="text-right text-sm font-medium">
                        {formatBytes(user.downloadEgressBytes)}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        <div className="flex flex-col items-end">
                          <span className="font-medium text-foreground">
                            {formatBytes(user.mediaStorageBytes)}
                          </span>
                          {(userStorage[user.id]?.voice > 0 || userStorage[user.id]?.image > 0) && (
                            <span className="text-xs text-muted-foreground mt-0.5 whitespace-nowrap space-x-1">
                              {userStorage[user.id]?.voice > 0 && (
                                <span>🎤 {formatBytes(userStorage[user.id]?.voice)}</span>
                              )}
                              {userStorage[user.id]?.voice > 0 &&
                                userStorage[user.id]?.image > 0 && <span>•</span>}
                              {userStorage[user.id]?.image > 0 && (
                                <span>🖼️ {formatBytes(userStorage[user.id]?.image)}</span>
                              )}
                            </span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-end space-x-2 py-4">
              <Button variant="outline" size="sm" disabled={page <= 1} asChild={page > 1}>
                {page > 1 ? <Link href={buildUsersPageHref(page - 1)}>Previous</Link> : 'Previous'}
              </Button>
              <span className="text-sm font-medium">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                asChild={page < totalPages}
              >
                {page < totalPages ? <Link href={buildUsersPageHref(page + 1)}>Next</Link> : 'Next'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
