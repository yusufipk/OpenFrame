import type { LiveSnapshot } from '@/lib/live-review/protocol';

export function shouldAcceptSnapshot(
  current: LiveSnapshot | null,
  incoming: LiveSnapshot
): boolean {
  if (!current || current.sessionId !== incoming.sessionId) return true;
  if (incoming.controlEpoch < current.controlEpoch) return false;
  return incoming.revision > current.revision;
}

export function estimateServerOffset(
  sentAt: number,
  receivedAt: number,
  serverTime: number
): number {
  return serverTime - (sentAt + receivedAt) / 2;
}

export function desiredPlaybackPosition(
  snapshot: LiveSnapshot,
  clientNow: number,
  serverOffset: number,
  duration = Number.POSITIVE_INFINITY
): number {
  const elapsed = snapshot.playback.playing
    ? Math.max(0, (clientNow + serverOffset - snapshot.playback.updatedAt) / 1000)
    : 0;
  const position = snapshot.playback.position + elapsed * snapshot.playback.rate;
  return Math.min(Math.max(0, position), duration);
}

export function playbackCorrection(driftSeconds: number): { seek: boolean; rateFactor: number } {
  if (Math.abs(driftSeconds) >= 0.75) return { seek: true, rateFactor: 1 };
  if (Math.abs(driftSeconds) < 0.08) return { seek: false, rateFactor: 1 };
  return { seek: false, rateFactor: Math.max(0.94, Math.min(1.06, 1 + driftSeconds * 0.16)) };
}
