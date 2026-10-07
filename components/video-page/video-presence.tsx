'use client';

import { PawPrint, Play, Users } from 'lucide-react';
import { Popover } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { VideoPresenceParticipant } from '@/lib/video-presence-types';
import type { PresenceStatus } from '@/components/video-page/hooks/use-video-presence';

const COLORS = [
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
];

function PresenceAvatar({ person }: { person: VideoPresenceParticipant }) {
  const color =
    COLORS[
      Array.from(person.id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % COLORS.length
    ];
  const initials = person.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join('');
  return (
    <span
      aria-hidden="true"
      title={person.name}
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium ring-2 ring-background',
        color
      )}
    >
      {person.isAnonymous ? <PawPrint className="size-3.5" /> : initials}
    </span>
  );
}

export function VideoPresence({
  participants,
  status,
}: {
  participants: VideoPresenceParticipant[];
  status: PresenceStatus;
}) {
  const connected = status === 'connected';
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-10 shrink-0 gap-1.5 px-2 sm:h-8"
          aria-label={
            connected ? `${participants.length} people on this video` : 'Video presence unavailable'
          }
        >
          {connected && participants.length > 0 ? (
            <span className="hidden -space-x-1.5 @[56rem]/video-header:flex">
              {participants.slice(0, 3).map((person) => (
                <PresenceAvatar key={person.id} person={person} />
              ))}
            </span>
          ) : null}
          <Users className="size-4 @[56rem]/video-header:hidden" />
          <span className="text-xs tabular-nums">{connected ? participants.length : '...'}</span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label="People on this video"
          className="z-[60] w-72 max-w-[calc(100vw-1.5rem)] rounded-lg border bg-popover p-3 text-popover-foreground shadow-md outline-none"
        >
          <h2 className="text-sm font-semibold">On this video</h2>
          {connected ? (
            <ul
              className="my-3 max-h-[min(20rem,50dvh)] space-y-3 overflow-y-auto"
              aria-label="Current viewers"
            >
              {participants.map((person) => (
                <li
                  key={person.id}
                  className="flex items-center gap-2.5"
                  data-testid="presence-person"
                >
                  <PresenceAvatar person={person} />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium">
                      {person.name}
                      {person.isSelf ? <span className="text-muted-foreground"> (you)</span> : null}
                    </p>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      {person.isPlaying ? (
                        <Play className="size-3" />
                      ) : (
                        <span className="size-1.5 rounded-full bg-emerald-500" />
                      )}
                      <span>{person.isPlaying ? 'Playing video' : 'On page'}</span>
                      {person.isAnonymous ? <span>· Anonymous</span> : null}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="my-3 text-sm text-muted-foreground" role="status">
              {status === 'connecting' ? 'Connecting...' : 'Presence is temporarily unavailable.'}
            </p>
          )}
          <p className="border-t pt-2 text-xs leading-relaxed text-muted-foreground">
            Shows open pages and player activity, not proof someone is watching. Disconnected
            viewers may take about 30 seconds to disappear.
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
