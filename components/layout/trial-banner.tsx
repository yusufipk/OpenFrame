import Link from 'next/link';
import type { TrialNotice } from '@/lib/billing';

function formatDate(value: Date) {
  return value.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

/**
 * The trial deadline, said once at the top of the app.
 *
 * The `ended` case is the one that matters: access stops at the trial's end date
 * but nothing is deleted for another fifteen days, and an account that is not
 * told this reads a locked workspace as lost work. So the deletion date is
 * stated as reassurance rather than as a threat.
 */
export function TrialBanner({ notice }: { notice: TrialNotice }) {
  const isEnded = notice.kind === 'ended';

  return (
    <div
      className={
        isEnded
          ? 'border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-800 dark:text-amber-300'
          : 'border-b border-primary/30 bg-primary/5 px-4 py-2 text-sm text-foreground'
      }
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          {isEnded
            ? `Your free trial ended on ${formatDate(notice.endsAt)}.`
            : `Your free trial ends on ${formatDate(notice.endsAt)}.`}
        </span>
        {notice.contentKeptUntil ? (
          <span className="text-muted-foreground">
            Nothing has been deleted. Your projects and media are kept until{' '}
            {formatDate(notice.contentKeptUntil)}.
          </span>
        ) : null}
        <Link href="/settings" className="font-medium underline underline-offset-4">
          {isEnded ? 'Subscribe to pick up where you left off' : 'See plan'}
        </Link>
      </div>
    </div>
  );
}
