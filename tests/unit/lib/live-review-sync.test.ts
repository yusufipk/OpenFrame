import { describe, it, expect } from 'vitest';
import type { LiveSnapshot } from '@/lib/live-review/protocol';
import {
  desiredPlaybackPosition,
  estimateServerOffset,
  playbackCorrection,
  shouldAcceptSnapshot,
} from '@/lib/live-review/sync';

function snapshot(overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    sessionId: 'room',
    videoId: 'video',
    versionId: 'version',
    status: 'active',
    revision: 5,
    controlEpoch: 2,
    presenterId: 'presenter',
    playback: { position: 12, playing: true, rate: 1.5, updatedAt: 10000 },
    participants: [],
    strokes: [],
    canvasEpoch: 0,
    serverTime: 10000,
    ...overrides,
  };
}

describe('live review synchronization', () => {
  it('rejects stale revisions and old presenter epochs', () => {
    const current = snapshot();
    expect(shouldAcceptSnapshot(current, snapshot({ revision: 4 }))).toBe(false);
    expect(shouldAcceptSnapshot(current, snapshot({ revision: 6, controlEpoch: 1 }))).toBe(false);
    expect(shouldAcceptSnapshot(current, snapshot({ revision: 6, controlEpoch: 2 }))).toBe(true);
  });

  it('projects playing media using estimated server time and clamps to duration', () => {
    expect(estimateServerOffset(1000, 1200, 1140)).toBe(40);
    expect(desiredPlaybackPosition(snapshot(), 11000, 40)).toBeCloseTo(13.56);
    expect(desiredPlaybackPosition(snapshot(), 11000, 40, 13)).toBe(13);
    expect(
      desiredPlaybackPosition(
        snapshot({ playback: { position: 12, playing: false, rate: 1.5, updatedAt: 10000 } }),
        11000,
        40
      )
    ).toBe(12);
  });

  it('seeks on large drift and gently corrects smaller drift', () => {
    expect(playbackCorrection(0.8)).toEqual({ seek: true, rateFactor: 1 });
    expect(playbackCorrection(0.3).seek).toBe(false);
    expect(playbackCorrection(0.3).rateFactor).toBeGreaterThan(1);
    expect(playbackCorrection(-0.3).rateFactor).toBeLessThan(1);
    expect(playbackCorrection(0.02)).toEqual({ seek: false, rateFactor: 1 });
  });
});
