'use client';

import { memo } from 'react';
import { AlertCircle, UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { LiveDiscovery, LiveSnapshot } from '@/lib/live-review/protocol';

export interface LiveReviewBarProps {
  discovery: LiveDiscovery | null;
  provider: string | undefined;
  snapshot: LiveSnapshot | null;
  participantId: string | null;
  connection: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'blocked' | 'unavailable';
  isJoined: boolean;
  autoplayBlocked?: boolean;
  busy?: boolean;
  error?: string | null;
  onStart: () => void;
  onJoin: () => void;
  onLeave: () => void;
  onTransfer: (participantId: string) => void;
  onEnd: () => void;
  onRetryPlayback: () => void;
}

export type LiveReviewEntryControlProps = Pick<
  LiveReviewBarProps,
  'discovery' | 'provider' | 'isJoined' | 'busy' | 'error' | 'onStart' | 'onJoin'
>;

export const LiveReviewEntryControl = memo(function LiveReviewEntryControl({
  discovery,
  provider,
  isJoined,
  busy,
  error,
  onStart,
  onJoin,
}: LiveReviewEntryControlProps) {
  if (!discovery?.enabled || isJoined) return null;

  const supported = provider === 'bunny' || provider === 'r2' || !!discovery.session;
  if ((!supported || (!discovery.session && !discovery.canStart)) && !error) return null;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {supported && discovery.session ? (
        <Button
          size="sm"
          disabled={busy || !discovery.available}
          title={!discovery.available ? 'Live review is unavailable right now' : undefined}
          onClick={onJoin}
        >
          Join room
        </Button>
      ) : supported && discovery.canStart ? (
        <Button
          size="sm"
          disabled={busy || !discovery.available}
          title={!discovery.available ? 'Live review is unavailable right now' : undefined}
          onClick={onStart}
        >
          Start room
        </Button>
      ) : null}
      {error && (
        <span role="alert" title={error} className="text-destructive">
          <AlertCircle aria-hidden="true" className="h-4 w-4" />
          <span className="sr-only">{error}</span>
        </span>
      )}
    </div>
  );
});

export const LiveReviewBar = memo(function LiveReviewBar({
  discovery,
  snapshot,
  participantId,
  connection,
  isJoined,
  autoplayBlocked,
  busy,
  error,
  onLeave,
  onTransfer,
  onEnd,
  onRetryPlayback,
}: LiveReviewBarProps) {
  if (!discovery?.enabled || !isJoined) return null;

  const manager =
    snapshot?.participants.find((person) => person.id === participantId)?.isManager ?? false;
  const presenter = snapshot?.participants.find((person) => person.id === snapshot.presenterId);
  const connected = connection === 'connected';
  const active = snapshot?.status === 'active';

  return (
    <section aria-label="Live review" className="border-b bg-card px-3 py-1 text-sm">
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap">
        <strong className="hidden shrink-0 font-medium sm:block">Live review</strong>
        <span
          role="status"
          className={connected ? 'shrink-0 text-emerald-600' : 'shrink-0 text-amber-600'}
        >
          {connection === 'connected'
            ? 'Connected'
            : connection === 'reconnecting'
              ? 'Reconnecting'
              : connection === 'blocked'
                ? 'Connection lost'
                : 'Connecting'}
        </span>
        {active && (
          <span
            className="hidden max-w-48 truncate text-muted-foreground sm:block"
            title={presenter?.name}
          >
            Presenter: {presenter?.name ?? 'Waiting for presenter'}
          </span>
        )}
        {active && snapshot && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                aria-label={`Room participants, ${snapshot.participants.length}`}
              >
                <UsersRound className="mr-1 h-4 w-4" />
                {snapshot.participants.length}
                <span className="hidden sm:inline"> participants</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
              <DropdownMenuLabel>Room participants</DropdownMenuLabel>
              {snapshot.participants.map((person) => {
                const canTransfer =
                  manager &&
                  person.canComment &&
                  person.id !== snapshot.presenterId &&
                  person.status !== 'blocked';

                return (
                  <DropdownMenuItem
                    key={person.id}
                    aria-disabled={!canTransfer || !connected || busy}
                    onSelect={(event) => {
                      if (canTransfer && connected && !busy) onTransfer(person.id);
                      else event.preventDefault();
                    }}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="max-w-full truncate">
                      {person.name}
                      {person.id === participantId ? ' (you)' : ''}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {person.isManager ? 'Manager, ' : ''}
                      {person.id === snapshot.presenterId ? 'Presenter, ' : ''}
                      {person.status}
                      {canTransfer ? ', make presenter' : ''}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {autoplayBlocked && (
          <span role="alert" className="flex shrink-0 items-center gap-2">
            Browser playback needs your action.
            <Button size="sm" onClick={onRetryPlayback}>
              Enable playback
            </Button>
          </span>
        )}
        {error && (
          <span role="alert" title={error} className="max-w-48 truncate text-destructive">
            {error}
          </span>
        )}
        <Button size="sm" variant="outline" disabled={busy} onClick={onLeave}>
          Leave
        </Button>
        {manager && active && (
          <Button size="sm" variant="destructive" disabled={busy || !connected} onClick={onEnd}>
            End room
          </Button>
        )}
      </div>
    </section>
  );
});
