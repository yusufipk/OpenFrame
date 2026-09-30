'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  WHATS_NEW_ENTRIES,
  formatWhatsNewDate,
  getLatestWhatsNewDate,
  hasUnseenWhatsNew,
} from '@/lib/whats-new';

const LAST_SEEN_KEY = 'openframe:whats-new-last-seen';
const LATEST_DATE = getLatestWhatsNewDate(WHATS_NEW_ENTRIES);

// Same-tab writes do not fire `storage`, so opening the panel notifies subscribers directly.
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function readLastSeen(): string | null {
  try {
    return window.localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

function markSeen() {
  if (!LATEST_DATE) return;
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, LATEST_DATE);
  } catch {
    // Storage disabled: the dot keeps showing, the panel still works.
  }
  listeners.forEach((listener) => listener());
}

function groupByDate(entries: typeof WHATS_NEW_ENTRIES) {
  const groups: { date: string; entries: (typeof WHATS_NEW_ENTRIES)[number][] }[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.date === entry.date) last.entries.push(entry);
    else groups.push({ date: entry.date, entries: [entry] });
  }
  return groups;
}

const GROUPS = groupByDate(WHATS_NEW_ENTRIES);

export function WhatsNewButton() {
  const [open, setOpen] = useState(false);
  // The server has no storage, so it renders without the dot and the client adds it.
  const unseen = useSyncExternalStore(
    subscribe,
    () => hasUnseenWhatsNew(readLastSeen(), LATEST_DATE),
    () => false
  );

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) markSeen();
  }, []);

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative"
              aria-label={unseen ? "What's new (new updates)" : "What's new"}
              onClick={() => handleOpenChange(true)}
            >
              <Sparkles className="h-4 w-4" />
              {unseen && (
                <span
                  aria-hidden
                  className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background"
                />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">What&apos;s new</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex max-h-[80dvh] flex-col gap-0 p-0 sm:max-w-md">
          <DialogHeader className="border-b px-5 pt-5 pb-4">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" />
              What&apos;s new
            </DialogTitle>
            <DialogDescription>Recent features and improvements in OpenFrame.</DialogDescription>
          </DialogHeader>
          <div className="overflow-y-auto px-5 py-4">
            <ol className="space-y-6">
              {GROUPS.map((group) => (
                <li key={group.date}>
                  <time
                    dateTime={group.date}
                    className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {formatWhatsNewDate(group.date)}
                  </time>
                  <ul className="mt-2 space-y-3 border-l pl-4">
                    {group.entries.map((entry) => (
                      <li key={entry.title}>
                        <h3 className="text-sm font-medium">{entry.title}</h3>
                        <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                          {entry.description}
                        </p>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
