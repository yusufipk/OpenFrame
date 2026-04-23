import { Metadata } from 'next';
import Link from 'next/link';
import { FeedbackEntryType, FeedbackStatus } from '@prisma/client';
import { format } from 'date-fns';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { DeleteFeedbackButton } from '@/components/admin/delete-feedback-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type SortBy =
  | 'submittedAt'
  | 'type'
  | 'status'
  | 'rating'
  | 'user'
  | 'allowShowcase'
  | 'showOnLanding';
type SortDirection = 'asc' | 'desc';
type TypeFilter = 'ALL' | FeedbackEntryType;
type StatusFilter = 'ALL' | FeedbackStatus;
type AdminFeedbackEntry = {
  id: string;
  type: FeedbackEntryType;
  category: string | null;
  title: string;
  message: string;
  screenshotUrl: string | null;
  screenshots: Array<{ id: string; url: string }>;
  rating: number | null;
  status: FeedbackStatus;
  allowShowcase: boolean;
  showOnLanding: boolean;
  createdAt: Date;
  user: { id: string; name: string | null; email: string | null };
};

function parseSortBy(value: string | undefined): SortBy {
  const accepted: SortBy[] = [
    'submittedAt',
    'type',
    'status',
    'rating',
    'user',
    'allowShowcase',
    'showOnLanding',
  ];
  return accepted.includes(value as SortBy) ? (value as SortBy) : 'submittedAt';
}

function parseSortDirection(value: string | undefined): SortDirection {
  return value === 'asc' || value === 'desc' ? value : 'desc';
}

function parseTypeFilter(value: string | undefined): TypeFilter {
  if (value === FeedbackEntryType.FEEDBACK || value === FeedbackEntryType.REVIEW) return value;
  return 'ALL';
}

function parseStatusFilter(value: string | undefined): StatusFilter {
  const accepted: FeedbackStatus[] = ['NEW', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RESOLVED'];
  if (accepted.includes(value as FeedbackStatus)) return value as FeedbackStatus;
  return 'ALL';
}

function getSortIndicator(
  column: SortBy,
  activeSortBy: SortBy,
  activeSortDirection: SortDirection
): string {
  if (column !== activeSortBy) return '↕';
  return activeSortDirection === 'asc' ? '↑' : '↓';
}

function getOrderBy(sortBy: SortBy, sortDirection: SortDirection): unknown {
  const createdAtTieBreaker = { createdAt: 'desc' as const };

  if (sortBy === 'submittedAt') {
    return [{ createdAt: sortDirection }];
  }
  if (sortBy === 'type') {
    return [{ type: sortDirection }, createdAtTieBreaker];
  }
  if (sortBy === 'status') {
    return [{ status: sortDirection }, createdAtTieBreaker];
  }
  if (sortBy === 'rating') {
    return [{ rating: sortDirection }, createdAtTieBreaker];
  }
  if (sortBy === 'allowShowcase') {
    return [{ allowShowcase: sortDirection }, createdAtTieBreaker];
  }
  if (sortBy === 'showOnLanding') {
    return [{ showOnLanding: sortDirection }, createdAtTieBreaker];
  }

  return [
    { user: { name: sortDirection } },
    { user: { email: sortDirection } },
    createdAtTieBreaker,
  ];
}

export const metadata: Metadata = {
  title: 'Feedback | Admin',
};

export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    sortBy?: string;
    sortDirection?: string;
    type?: string;
    status?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.isAdmin) {
    redirect('/');
  }

  const params = await searchParams;
  const rawPage = Number(params.page);
  const requestedPage = Number.isFinite(rawPage) ? Math.min(Math.max(1, rawPage), 500) : 1;
  const pageSize = 20;
  const sortBy = parseSortBy(params.sortBy);
  const sortDirection = parseSortDirection(params.sortDirection);
  const typeFilter = parseTypeFilter(params.type);
  const statusFilter = parseStatusFilter(params.status);

  const where = {
    ...(typeFilter !== 'ALL' ? { type: typeFilter } : {}),
    ...(statusFilter !== 'ALL' ? { status: statusFilter } : {}),
  };
  const orderBy = getOrderBy(sortBy, sortDirection);

  const userFeedbackDelegate = (
    db as unknown as {
      userFeedback?: {
        count: (args?: unknown) => Promise<number>;
        findMany: (args?: unknown) => Promise<AdminFeedbackEntry[]>;
      };
    }
  ).userFeedback;

  let totalEntries = 0;
  let page = requestedPage;
  let entries: AdminFeedbackEntry[] = [];

  if (userFeedbackDelegate) {
    try {
      totalEntries = await userFeedbackDelegate.count({ where });
      const totalPages = Math.max(1, Math.ceil(totalEntries / pageSize));
      page = Math.min(requestedPage, totalPages);
      const skip = (page - 1) * pageSize;
      entries = await userFeedbackDelegate.findMany({
        where,
        skip,
        take: pageSize,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          screenshots: {
            select: {
              id: true,
              url: true,
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('Unknown field `screenshots`')) {
        try {
          totalEntries = await userFeedbackDelegate.count({ where });
          const totalPages = Math.max(1, Math.ceil(totalEntries / pageSize));
          page = Math.min(requestedPage, totalPages);
          const skip = (page - 1) * pageSize;
          const fallbackEntries = (await userFeedbackDelegate.findMany({
            where,
            skip,
            take: pageSize,
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
            orderBy,
          })) as Array<
            Omit<AdminFeedbackEntry, 'screenshots'> & {
              screenshots?: Array<{ id: string; url: string }>;
            }
          >;

          entries = fallbackEntries.map((entry) => ({
            id: entry.id,
            type: entry.type,
            category: entry.category,
            title: entry.title,
            message: entry.message,
            screenshotUrl: entry.screenshotUrl,
            screenshots: Array.isArray(entry.screenshots) ? entry.screenshots : [],
            rating: entry.rating,
            status: entry.status,
            allowShowcase: entry.allowShowcase,
            showOnLanding: entry.showOnLanding,
            createdAt: entry.createdAt,
            user: entry.user,
          }));
        } catch (fallbackError) {
          console.error('Failed to fetch feedback entries (fallback):', fallbackError);
        }
      } else {
        console.error('Failed to fetch feedback entries:', error);
      }
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalEntries / pageSize));
  const paginatedEntries = entries;

  const buildPageHref = (
    targetPage: number,
    targetSortBy: SortBy = sortBy,
    targetSortDirection: SortDirection = sortDirection,
    targetType: TypeFilter = typeFilter,
    targetStatus: StatusFilter = statusFilter
  ): string => {
    const next = new URLSearchParams({
      page: String(targetPage),
      sortBy: targetSortBy,
      sortDirection: targetSortDirection,
      type: targetType,
      status: targetStatus,
    });
    return `/admin/feedback?${next.toString()}`;
  };

  const buildSortHref = (column: SortBy): string => {
    const nextDirection: SortDirection =
      column === sortBy
        ? sortDirection === 'asc'
          ? 'desc'
          : 'asc'
        : column === 'user'
          ? 'asc'
          : 'desc';
    return buildPageHref(1, column, nextDirection);
  };

  const buildFilterHref = (targetType: TypeFilter, targetStatus: StatusFilter): string =>
    buildPageHref(1, sortBy, sortDirection, targetType, targetStatus);

  return (
    <div className="flex-1 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-3xl font-bold tracking-tight">Feedback & Reviews</h2>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant={typeFilter === 'ALL' ? 'default' : 'outline'} size="sm" asChild>
          <Link href={buildFilterHref('ALL', statusFilter)}>All Types</Link>
        </Button>
        <Button variant={typeFilter === 'FEEDBACK' ? 'default' : 'outline'} size="sm" asChild>
          <Link href={buildFilterHref('FEEDBACK', statusFilter)}>Feedback</Link>
        </Button>
        <Button variant={typeFilter === 'REVIEW' ? 'default' : 'outline'} size="sm" asChild>
          <Link href={buildFilterHref('REVIEW', statusFilter)}>Reviews</Link>
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant={statusFilter === 'ALL' ? 'default' : 'outline'} size="sm" asChild>
          <Link href={buildFilterHref(typeFilter, 'ALL')}>All Statuses</Link>
        </Button>
        {(['NEW', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RESOLVED'] as const).map((status) => (
          <Button
            key={status}
            variant={statusFilter === status ? 'default' : 'outline'}
            size="sm"
            asChild
          >
            <Link href={buildFilterHref(typeFilter, status)}>{status.replace('_', ' ')}</Link>
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Submissions</CardTitle>
          <CardDescription>{totalEntries} submission(s) found.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Link
                      href={buildSortHref('submittedAt')}
                      className="inline-flex items-center gap-1 hover:underline"
                    >
                      Submitted
                      <span className="text-xs">
                        {getSortIndicator('submittedAt', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
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
                  <TableHead>
                    <Link
                      href={buildSortHref('type')}
                      className="inline-flex items-center gap-1 hover:underline"
                    >
                      Type
                      <span className="text-xs">
                        {getSortIndicator('type', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead className="text-center">Screenshot</TableHead>
                  <TableHead className="text-center">
                    <Link
                      href={buildSortHref('rating')}
                      className="inline-flex items-center justify-center gap-1 hover:underline"
                    >
                      Rating
                      <span className="text-xs">
                        {getSortIndicator('rating', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-center">
                    <Link
                      href={buildSortHref('status')}
                      className="inline-flex items-center justify-center gap-1 hover:underline"
                    >
                      Status
                      <span className="text-xs">
                        {getSortIndicator('status', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-center">
                    <Link
                      href={buildSortHref('allowShowcase')}
                      className="inline-flex items-center justify-center gap-1 hover:underline"
                    >
                      Consent
                      <span className="text-xs">
                        {getSortIndicator('allowShowcase', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-center">
                    <Link
                      href={buildSortHref('showOnLanding')}
                      className="inline-flex items-center justify-center gap-1 hover:underline"
                    >
                      Landing
                      <span className="text-xs">
                        {getSortIndicator('showOnLanding', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedEntries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="h-24 text-center">
                      No submissions found.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedEntries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {format(new Date(entry.createdAt), 'MMM dd, yyyy HH:mm')}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{entry.user.name || 'Anonymous'}</span>
                          <span className="text-xs text-muted-foreground">{entry.user.email}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge variant="outline">
                            {entry.type === 'FEEDBACK' ? 'Feedback' : 'Review'}
                          </Badge>
                          {entry.category && (
                            <Badge variant="secondary" className="w-fit">
                              {entry.category}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">{entry.title}</TableCell>
                      <TableCell className="max-w-[320px] truncate text-sm text-muted-foreground">
                        {entry.message}
                      </TableCell>
                      <TableCell className="text-center">
                        {entry.screenshots.length > 0 || entry.screenshotUrl ? (
                          <Link href={`/admin/feedback/${entry.id}`} className="text-xs underline">
                            {entry.screenshots.length || (entry.screenshotUrl ? 1 : 0)} image
                            {(entry.screenshots.length || (entry.screenshotUrl ? 1 : 0)) > 1
                              ? 's'
                              : ''}
                          </Link>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell className="text-center">{entry.rating ?? '-'}</TableCell>
                      <TableCell className="text-center">
                        <Badge variant="outline">{entry.status}</Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        {entry.allowShowcase ? 'Yes' : 'No'}
                      </TableCell>
                      <TableCell className="text-center">
                        {entry.showOnLanding ? 'Yes' : 'No'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button variant="outline" size="sm" asChild>
                            <Link href={`/admin/feedback/${entry.id}`}>Open</Link>
                          </Button>
                          <DeleteFeedbackButton
                            feedbackId={entry.id}
                            feedbackTitle={entry.title}
                            size="sm"
                            variant="outline"
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-end gap-2 py-4">
              <Button variant="outline" size="sm" disabled={page <= 1} asChild={page > 1}>
                {page > 1 ? <Link href={buildPageHref(page - 1)}>Previous</Link> : 'Previous'}
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
                {page < totalPages ? <Link href={buildPageHref(page + 1)}>Next</Link> : 'Next'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
