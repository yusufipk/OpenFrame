import Image from 'next/image';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { format } from 'date-fns';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { DeleteFeedbackButton } from '@/components/admin/delete-feedback-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default async function AdminFeedbackDetailPage({
  params,
}: {
  params: Promise<{ feedbackId: string }>;
}) {
  const session = await auth();
  if (!session?.user?.isAdmin) {
    redirect('/');
  }

  const { feedbackId } = await params;
  const userFeedbackDelegate = (
    db as unknown as {
      userFeedback?: {
        findUnique: (args?: unknown) => Promise<{
          id: string;
          type: string;
          category: string | null;
          status: string;
          rating: number | null;
          title: string;
          message: string;
          screenshotUrl: string | null;
          createdAt: Date;
          user: { name: string | null; email: string | null };
          screenshots: Array<{ id: string; url: string }>;
        } | null>;
      };
    }
  ).userFeedback;

  let entry = null as Awaited<
    ReturnType<NonNullable<typeof userFeedbackDelegate>['findUnique']>
  > | null;
  if (userFeedbackDelegate) {
    try {
      entry = await userFeedbackDelegate.findUnique({
        where: { id: feedbackId },
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('Unknown field `screenshots`')) {
        entry = (await userFeedbackDelegate.findUnique({
          where: { id: feedbackId },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        })) as typeof entry;

        if (entry && !Array.isArray(entry.screenshots)) {
          entry = {
            ...entry,
            screenshots: [],
          };
        }
      } else {
        throw error;
      }
    }
  }

  if (!entry) {
    notFound();
  }

  const screenshotItems =
    entry.screenshots.length > 0
      ? entry.screenshots
      : entry.screenshotUrl
        ? [{ id: `${entry.id}-legacy`, url: entry.screenshotUrl }]
        : [];
  const submittedAtText = format(new Date(entry.createdAt), 'MMM dd, yyyy HH:mm');
  const submitterName = entry.user.name || 'there';
  const feedbackTypeLabel = entry.type.toLowerCase();
  const quotedMessage = entry.message
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const mailtoHref = entry.user.email
    ? `mailto:${entry.user.email}?subject=${encodeURIComponent(
        `[OpenFrame ${entry.type}] Re: ${entry.title}`
      )}&body=${encodeURIComponent(
        `Hi ${submitterName},\n\nThanks for your ${feedbackTypeLabel}.\n\n` +
          `I reviewed your submission:\n` +
          `Title: ${entry.title}\n` +
          `Submitted: ${submittedAtText}\n\n` +
          `Your message:\n${quotedMessage}\n\n`
      )}`
    : null;

  return (
    <div className="flex-1 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-3xl font-bold tracking-tight">Feedback Detail</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href="/admin/feedback">Back to list</Link>
          </Button>
          <DeleteFeedbackButton
            feedbackId={entry.id}
            feedbackTitle={entry.title}
            redirectTo="/admin/feedback"
            variant="destructive"
            size="sm"
          />
        </div>
      </div>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{entry.type}</Badge>
            {entry.category && <Badge variant="secondary">{entry.category}</Badge>}
            <Badge variant="outline">{entry.status}</Badge>
            {entry.rating && <Badge variant="outline">Rating: {entry.rating}/5</Badge>}
          </div>
          <CardTitle className="text-xl">{entry.title}</CardTitle>
          <div className="text-sm text-muted-foreground">
            Submitted by {entry.user.name || 'Anonymous'} (
            {entry.user.email && mailtoHref ? (
              <a href={mailtoHref} className="underline hover:text-foreground">
                {entry.user.email}
              </a>
            ) : (
              'No email'
            )}
            ) on {submittedAtText}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold uppercase text-muted-foreground">Message</h3>
            <div className="whitespace-pre-wrap rounded-md border p-4 text-sm leading-relaxed">
              {entry.message}
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold uppercase text-muted-foreground">
              Screenshots ({screenshotItems.length})
            </h3>
            {screenshotItems.length === 0 ? (
              <div className="rounded-md border p-4 text-sm text-muted-foreground">
                No screenshots attached.
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {screenshotItems.map((screenshot, index) => (
                  <a
                    key={screenshot.id}
                    href={screenshot.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border p-2 transition-colors hover:bg-accent/30"
                  >
                    <Image
                      src={screenshot.url}
                      alt={`Screenshot ${index + 1}`}
                      width={1000}
                      height={600}
                      className="h-52 w-full rounded-sm object-contain"
                    />
                    <p className="mt-2 text-xs text-muted-foreground">Open full size</p>
                  </a>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
