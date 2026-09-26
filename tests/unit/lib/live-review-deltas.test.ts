import { describe, expect, it } from 'vitest';
import { applyDrawingDelta } from '@/lib/live-review/deltas';
import type { LiveDrawingDelta, LiveSnapshot } from '@/lib/live-review/protocol';

const first = { x: 0.1, y: 0.2 };
const second = { x: 0.3, y: 0.4 };
const stroke = { id: 's1', participantId: 'p1', color: '#ff0000', width: 2 };

function room(overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    sessionId: 'room',
    videoId: 'video',
    versionId: 'version',
    status: 'active',
    revision: 4,
    controlEpoch: 1,
    presenterId: null,
    playback: { position: 0, playing: false, rate: 1, updatedAt: 100 },
    participants: [],
    strokes: [],
    canvasEpoch: 2,
    serverTime: 100,
    ...overrides,
  };
}

function append(
  overrides: Partial<Extract<LiveDrawingDelta, { type: 'stroke-delta' }>> = {}
): LiveDrawingDelta {
  return {
    type: 'stroke-delta',
    sessionId: 'room',
    versionId: 'version',
    canvasEpoch: 2,
    baseRevision: 4,
    revision: 5,
    serverTime: 101,
    stroke,
    fromIndex: 0,
    points: [first],
    ...overrides,
  };
}

describe('applyDrawingDelta', () => {
  it('adds a stroke and appends only the new points without changing the previous snapshot', () => {
    const original = room();
    const added = applyDrawingDelta(original, append());
    expect(added.status).toBe('applied');
    if (added.status !== 'applied') return;
    expect(added.snapshot.strokes).toEqual([{ ...stroke, points: [first] }]);
    const appended = applyDrawingDelta(
      added.snapshot,
      append({ baseRevision: 5, revision: 6, fromIndex: 1, points: [second] })
    );
    expect(appended.status).toBe('applied');
    if (appended.status !== 'applied') return;
    expect(appended.snapshot.strokes[0].points).toEqual([first, second]);
    expect(added.snapshot.strokes[0].points).toEqual([first]);
    expect(original.strokes).toEqual([]);
    expect(appended.snapshot.revision).toBe(6);
  });

  it('removes the named stroke after undo', () => {
    const current = room({ strokes: [{ ...stroke, points: [first] }] });
    const removed = applyDrawingDelta(current, {
      type: 'stroke-remove',
      sessionId: 'room',
      versionId: 'version',
      canvasEpoch: 2,
      baseRevision: 4,
      revision: 5,
      serverTime: 102,
      strokeId: 's1',
    });
    expect(removed).toMatchObject({ status: 'applied', snapshot: { strokes: [], revision: 5 } });
    expect(current.strokes).toHaveLength(1);
  });

  it('ignores duplicate, old epoch, and wrong room messages', () => {
    const current = room();
    expect(applyDrawingDelta(current, append({ revision: 4 }))).toEqual({ status: 'stale' });
    expect(applyDrawingDelta(current, append({ canvasEpoch: 1, revision: 4 }))).toEqual({
      status: 'stale',
    });
    expect(applyDrawingDelta(current, append({ sessionId: 'another' }))).toEqual({
      status: 'stale',
    });
    expect(applyDrawingDelta(current, append({ versionId: 'another' }))).toEqual({
      status: 'stale',
    });
  });

  it('requests recovery on a revision gap, new epoch, or missing point prefix', () => {
    const current = room({ strokes: [{ ...stroke, points: [first] }] });
    expect(applyDrawingDelta(current, append({ baseRevision: 5, revision: 6 }))).toEqual({
      status: 'resync',
    });
    expect(applyDrawingDelta(current, append({ canvasEpoch: 3 }))).toEqual({ status: 'resync' });
    expect(applyDrawingDelta(current, append({ canvasEpoch: 1 }))).toEqual({ status: 'resync' });
    expect(applyDrawingDelta(current, append({ fromIndex: 2, points: [second] }))).toEqual({
      status: 'resync',
    });
    expect(applyDrawingDelta(current, append({ fromIndex: 1, points: [{ x: 2, y: 0 }] }))).toEqual({
      status: 'resync',
    });
    expect(
      applyDrawingDelta(
        current,
        append({ stroke: { ...stroke, color: '#00ff00' }, fromIndex: 1, points: [second] })
      )
    ).toEqual({ status: 'resync' });
    expect(applyDrawingDelta(null, append())).toEqual({ status: 'resync' });
  });
});
