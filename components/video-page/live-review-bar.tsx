'use client';

import { memo } from 'react';
import { Button } from '@/components/ui/button';
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

export const LiveReviewBar = memo(function LiveReviewBar({
  discovery,
  provider,
  snapshot,
  participantId,
  connection,
  isJoined,
  autoplayBlocked,
  busy,
  error,
  onStart,
  onJoin,
  onLeave,
  onTransfer,
  onEnd,
  onRetryPlayback,
}: LiveReviewBarProps) {
  if (!discovery?.enabled) return null;

  const supported = provider === 'bunny' || provider === 'r2' || !!discovery.session;
  const manager =
    snapshot?.participants.find((person) => person.id === participantId)?.isManager ?? false;
  const presenter = snapshot?.participants.find((person) => person.id === snapshot.presenterId);
  const connected = connection === 'connected';
  const active = snapshot?.status === 'active';

  return (
    <section
      aria-label="Live review"
      className="rounded-lg border bg-card px-3 py-2 text-sm shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="font-medium">Live review</strong>
        {!supported ? (
          <span className="text-muted-foreground">
            Live review is available for uploaded videos. YouTube playback cannot join this room.
          </span>
        ) : !discovery.available ? (
          <span role="status" className="text-muted-foreground">
            Live review is unavailable right now.
          </span>
        ) : !isJoined ? (
          <>
            {discovery.session && (
              <span className="text-muted-foreground">A room is open for this video.</span>
            )}
            {discovery.session ? (
              <Button size="sm" disabled={busy} onClick={onJoin}>
                Join room
              </Button>
            ) : discovery.canStart ? (
              <Button size="sm" disabled={busy} onClick={onStart}>
                Start room
              </Button>
            ) : (
              <span className="text-muted-foreground">No room is open for this version.</span>
            )}
          </>
        ) : (
          <>
            <span role="status" className={connected ? 'text-emerald-600' : 'text-amber-600'}>
              {connection === 'connected'
                ? 'Connected'
                : connection === 'reconnecting'
                  ? 'Reconnecting'
                  : connection === 'blocked'
                    ? 'Connection lost'
                    : 'Connecting'}
            </span>
            {active && (
              <span className="min-w-0 break-all text-muted-foreground">
                Presenter: {presenter?.name ?? 'Waiting for presenter'}
              </span>
            )}
            <span className="text-muted-foreground">
              {snapshot?.participants.length ?? 0} participants
            </span>
            <Button size="sm" variant="outline" disabled={busy} onClick={onLeave}>
              Leave
            </Button>
            {manager && active && (
              <Button size="sm" variant="destructive" disabled={busy || !connected} onClick={onEnd}>
                End room
              </Button>
            )}
          </>
        )}
      </div>
      {isJoined && active && snapshot && (
        <ul aria-label="Room participants" className="mt-2 flex flex-wrap gap-2">
          {snapshot.participants.map((person) => (
            <li
              key={person.id}
              className="flex max-w-full flex-wrap items-center gap-1 rounded-md border px-2 py-1"
            >
              <span className="min-w-0 break-all">
                {person.name}
                {person.id === participantId ? ' (you)' : ''}
              </span>
              {person.isManager && <span className="text-muted-foreground">Manager</span>}
              {person.id === snapshot.presenterId && (
                <span className="text-muted-foreground">Presenter</span>
              )}
              <span className="text-muted-foreground">{person.status}</span>
              {manager &&
                person.canComment &&
                person.id !== snapshot.presenterId &&
                person.status !== 'blocked' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!connected || busy}
                    onClick={() => onTransfer(person.id)}
                  >
                    Make presenter
                  </Button>
                )}
            </li>
          ))}
        </ul>
      )}
      {autoplayBlocked && isJoined && (
        <div role="alert" className="mt-2 flex items-center gap-2">
          <span>Browser playback needs your action.</span>
          <Button size="sm" onClick={onRetryPlayback}>
            Enable playback
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
    </section>
  );
});
