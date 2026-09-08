import { format } from 'date-fns';
import { UserX } from 'lucide-react';
import { db } from '@/lib/db';
import { CANCELLATION_REASONS, getCancellationReasonLabel } from '@/lib/cancellation-reasons';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const RECENT_LIMIT = 15;

/**
 * The answers to the one question asked on the way out, newest first, with an
 * all-time tally per answer above them.
 *
 * Only in-app cancellations appear here. Someone who cancels inside the Stripe
 * portal, or whose card simply stops working, never sees the question, so the
 * tally undercounts churn and says nothing about the accounts that pay and go
 * silent. Read it as "what people said", not "why people leave".
 */
export async function CancellationReasonsCard() {
  const [recent, tally] = await Promise.all([
    db.subscriptionCancellation.findMany({
      orderBy: { createdAt: 'desc' },
      take: RECENT_LIMIT,
      select: {
        id: true,
        reason: true,
        note: true,
        periodEnd: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
    }),
    db.subscriptionCancellation.groupBy({
      by: ['reason'],
      _count: { _all: true },
    }),
  ]);

  const countByReason = new Map(tally.map((row) => [row.reason, row._count._all]));
  const total = tally.reduce((sum, row) => sum + row._count._all, 0);
  const skipped = countByReason.get(null) ?? 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">Why people cancelled</CardTitle>
        <UserX className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="space-y-4">
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">
            No in-app cancellations yet. Cancellations made in the Stripe portal do not show up
            here.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {CANCELLATION_REASONS.map((entry) => (
                <span key={entry.value} className="text-muted-foreground">
                  {entry.label}:{' '}
                  <span className="font-medium text-foreground">
                    {countByReason.get(entry.value) ?? 0}
                  </span>
                </span>
              ))}
              <span className="text-muted-foreground">
                Skipped the question: <span className="font-medium text-foreground">{skipped}</span>
              </span>
            </div>
            <ul className="divide-y">
              {recent.map((row) => (
                <li key={row.id} className="py-2 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="font-medium">
                      {row.user.name || 'Anonymous'}{' '}
                      <span className="font-normal text-xs text-muted-foreground">
                        {row.user.email}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {format(row.createdAt, 'MMM dd, yyyy')}
                      {row.periodEnd
                        ? ` · billing period ends ${format(row.periodEnd, 'MMM dd')}`
                        : ''}
                    </span>
                  </div>
                  <p className="text-muted-foreground">{getCancellationReasonLabel(row.reason)}</p>
                  {row.note ? (
                    <p className="mt-0.5 whitespace-pre-wrap break-words">{row.note}</p>
                  ) : null}
                </li>
              ))}
            </ul>
            {total > RECENT_LIMIT ? (
              <p className="text-xs text-muted-foreground">
                Showing the latest {RECENT_LIMIT} of {total}.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
