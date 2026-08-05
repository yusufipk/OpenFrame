import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AT_RISK_SILENT_DAYS,
  conversionRates,
  getScoreboard,
  type FunnelRates,
} from '@/lib/analytics/scoreboard';
import { isProductAnalyticsEnabled } from '@/lib/feature-flags';
import { AlertTriangle, CreditCard, TrendingUp, Users } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Growth | OpenFrame',
  description: 'Acquisition funnel and retention scoreboard',
};

function formatMoney(cents: number | null, currency: string) {
  if (cents === null) return '—';
  const safeCurrency = /^[a-zA-Z]{3}$/.test(currency) ? currency.toUpperCase() : 'USD';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: safeCurrency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatWeek(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatDate(date: Date | null) {
  return date ? date.toISOString().slice(0, 10) : 'never';
}

/** A percentage with the count it was computed from, because n matters here. */
function Rate({ rate, of }: { rate: number | null; of: number }) {
  if (rate === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span>
      {Math.round(rate * 100)}%<span className="text-muted-foreground"> /{of}</span>
    </span>
  );
}

const WEEK_COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'visitors', label: 'Visitors' },
  { key: 'signups', label: 'Signup' },
  { key: 'firstVideo', label: 'Video' },
  { key: 'shareLinks', label: 'Share link' },
  { key: 'externalFeedback', label: 'Ext. feedback' },
  { key: 'trials', label: 'Trial' },
  { key: 'newPaid', label: 'New paid' },
  { key: 'canceled', label: 'Canceled' },
  { key: 'activePaid', label: 'Active paid' },
];

export default async function AdminGrowthPage() {
  const session = await auth();
  if (!session?.user?.isAdmin) {
    redirect('/');
  }

  if (!isProductAnalyticsEnabled()) {
    return (
      <div className="flex-1 space-y-4 px-4 md:px-8">
        <h2 className="text-3xl font-bold tracking-tight">Growth</h2>
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Acquisition tracking is off on this deployment. Set{' '}
            <code className="font-mono">OPENFRAME_ENABLE_ANALYTICS=true</code> to start recording
            the funnel. Nothing is collected until you do, and nothing is ever sent anywhere but
            this instance&apos;s own database.
          </CardContent>
        </Card>
      </div>
    );
  }

  const scoreboard = await getScoreboard();
  const latest = scoreboard.weeks[scoreboard.weeks.length - 1];
  const window = scoreboard.weeks.reduce(
    (sum, week) => ({
      visitors: sum.visitors + week.visitors,
      signups: sum.signups + week.signups,
      firstVideo: sum.firstVideo + week.firstVideo,
      shareLinks: sum.shareLinks + week.shareLinks,
      externalFeedback: sum.externalFeedback + week.externalFeedback,
      trials: sum.trials + week.trials,
      newPaid: sum.newPaid + week.newPaid,
    }),
    {
      visitors: 0,
      signups: 0,
      firstVideo: 0,
      shareLinks: 0,
      externalFeedback: 0,
      trials: 0,
      newPaid: 0,
    }
  );
  const overall: FunnelRates = conversionRates(window);

  return (
    <div className="flex-1 space-y-4 px-4 md:px-8">
      <div className="flex items-center justify-between space-y-2">
        <h2 className="text-3xl font-bold tracking-tight">Growth</h2>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active paid</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{scoreboard.currentActivePaid ?? '—'}</div>
            <p className="text-xs text-muted-foreground">from Stripe, right now</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">MRR</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatMoney(scoreboard.currentMrrCents, scoreboard.currency)}
            </div>
            <p className="text-xs text-muted-foreground">from Stripe, right now</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Visitors this week</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{latest?.visitors ?? 0}</div>
            <p className="text-xs text-muted-foreground">
              {latest ? `week of ${formatWeek(latest.weekStart)}` : 'no data yet'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">At risk</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{scoreboard.atRisk.length}</div>
            <p className="text-xs text-muted-foreground">
              paid, silent for {AT_RISK_SILENT_DAYS}+ days
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Weekly funnel</CardTitle>
          <p className="text-sm text-muted-foreground">
            Weeks start Monday, UTC. Active paid is the running net of subscriptions started minus
            canceled, so it can drift from the Stripe figure above; the difference is the drift.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Week</th>
                {WEEK_COLUMNS.map((column) => (
                  <th key={column.key} className="py-2 pr-4 text-right font-medium">
                    {column.label}
                  </th>
                ))}
                <th className="py-2 pr-4 text-right font-medium">MRR</th>
              </tr>
            </thead>
            <tbody>
              {scoreboard.weeks.map((week) => (
                <tr key={week.weekStart.toISOString()} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-mono text-xs">{formatWeek(week.weekStart)}</td>
                  {WEEK_COLUMNS.map((column) => (
                    <td key={column.key} className="py-2 pr-4 text-right tabular-nums">
                      {week[column.key as keyof typeof week] as number}
                    </td>
                  ))}
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatMoney(week.mrrCents, scoreboard.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where it narrows</CardTitle>
          <p className="text-sm text-muted-foreground">
            Every step over the whole {scoreboard.weeks.length}-week window, with the denominator
            beside it. The lowest rate is the step to work on.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5 text-sm">
          <div>
            <div className="text-muted-foreground">Visitor to signup</div>
            <div className="text-lg font-semibold">
              <Rate rate={overall.visitorToSignup} of={window.visitors} />
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Signup to first video</div>
            <div className="text-lg font-semibold">
              <Rate rate={overall.signupToFirstVideo} of={window.signups} />
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Video to share link</div>
            <div className="text-lg font-semibold">
              <Rate rate={overall.firstVideoToShare} of={window.firstVideo} />
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Share to outside feedback</div>
            <div className="text-lg font-semibold">
              <Rate rate={overall.shareToFeedback} of={window.shareLinks} />
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Trial to paid</div>
            <div className="text-lg font-semibold">
              <Rate rate={overall.trialToPaid} of={window.trials} />
            </div>
          </div>
        </CardContent>
      </Card>

      {scoreboard.cohorts ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Card-first against cardless trial</CardTitle>
            <p className="text-sm text-muted-foreground">
              Accounts created in the {scoreboard.cohorts.windowDays} days either side of{' '}
              {formatDate(scoreboard.cohorts.cutover)}, each given{' '}
              {scoreboard.cohorts.observationDays} days from signup to convert. The rate to read is
              signup to paid: dropping the card requirement multiplies trials, so trial to paid can
              fall while more people pay.
            </p>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Cohort</th>
                  <th className="py-2 pr-4 font-medium">Window</th>
                  <th className="py-2 pr-4 text-right font-medium">Signup</th>
                  <th className="py-2 pr-4 text-right font-medium">Trial</th>
                  <th className="py-2 pr-4 text-right font-medium">Paid</th>
                  <th className="py-2 pr-4 text-right font-medium">Signup to paid</th>
                  <th className="py-2 pr-4 text-right font-medium">Trial to paid</th>
                </tr>
              </thead>
              <tbody>
                {scoreboard.cohorts.rows.map((row) => (
                  <tr key={row.cohort} className="border-b last:border-0">
                    <td className="py-2 pr-4">
                      {row.cohort === 'CARDLESS' ? 'cardless' : 'card first'}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                      {formatDate(row.windowStart)} to {formatDate(row.windowEnd)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.signups}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.trials}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.paid}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      <Rate
                        rate={row.signups > 0 ? row.paid / row.signups : null}
                        of={row.signups}
                      />
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      <Rate rate={row.trials > 0 ? row.paid / row.trials : null} of={row.trials} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {scoreboard.cohorts.windowDays === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Nothing to compare yet. The first cardless signups reach the end of their{' '}
                {scoreboard.cohorts.observationDays}-day window {scoreboard.cohorts.observationDays}{' '}
                days after the switchover.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By source</CardTitle>
          <p className="text-sm text-muted-foreground">
            Rolling {scoreboard.channelWindowDays} days rather than one week: a weekly per-source
            cell holds single digits at this volume, and a percentage computed from three visits
            reads exactly as confidently as one computed from three hundred.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Source</th>
                <th className="py-2 pr-4 text-right font-medium">Visitors</th>
                <th className="py-2 pr-4 text-right font-medium">Signup</th>
                <th className="py-2 pr-4 text-right font-medium">Trial</th>
                <th className="py-2 pr-4 text-right font-medium">Paid</th>
                <th className="py-2 pr-4 text-right font-medium">Visitor to signup</th>
              </tr>
            </thead>
            <tbody>
              {scoreboard.channels.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-muted-foreground">
                    Nothing recorded in this window yet.
                  </td>
                </tr>
              )}
              {scoreboard.channels.map((row) => (
                <tr key={row.channel} className="border-b last:border-0">
                  <td className="py-2 pr-4">{row.channel.toLowerCase()}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{row.visitors}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{row.signups}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{row.trials}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{row.paid}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    <Rate
                      rate={row.visitors > 0 ? row.signups / row.visitors : null}
                      of={row.visitors}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Paid accounts</CardTitle>
          <p className="text-sm text-muted-foreground">
            Value events are videos, share links, outside feedback, approvals and projects. Rows
            marked at risk have produced none for {AT_RISK_SILENT_DAYS} days.
            {scoreboard.paidAccountsTruncated && (
              <>
                {' '}
                Quietest {scoreboard.paidAccountLimit} only; there are more paid accounts than this
                table shows.
              </>
            )}
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Account</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Source</th>
                <th className="py-2 pr-4 text-right font-medium">7d</th>
                <th className="py-2 pr-4 text-right font-medium">30d</th>
                <th className="py-2 pr-4 font-medium">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {scoreboard.paidAccounts.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-muted-foreground">
                    No active or trialing accounts.
                  </td>
                </tr>
              )}
              {scoreboard.paidAccounts.map((account) => {
                const atRisk = scoreboard.atRisk.some((row) => row.userId === account.userId);
                return (
                  <tr key={account.userId} className="border-b last:border-0">
                    <td className="py-2 pr-4">
                      {account.name || account.email || account.userId}
                      {atRisk && (
                        <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                          at risk
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {account.status.toLowerCase()}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {account.channel?.toLowerCase() ?? '—'}
                      {account.selfReported && account.selfReported !== account.channel && (
                        <span className="text-xs">
                          {' '}
                          (said {account.selfReported.toLowerCase()})
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{account.valueEvents7}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{account.valueEvents30}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                      {formatDate(account.lastValueEventAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
