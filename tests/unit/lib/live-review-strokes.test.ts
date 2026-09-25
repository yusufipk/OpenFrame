import { describe, expect, it } from 'vitest';
import { applyLiveStroke } from '@/lib/live-review/strokes';
import type { LiveStroke } from '@/lib/live-review/protocol';

const point = (x: number) => ({ x, y: 0.5 });
const incoming = (points: number[]) => ({
  id: 'stroke-1',
  color: '#ff0000',
  width: 2,
  points: points.map(point),
});

describe('live review cumulative strokes', () => {
  it('replaces an owned stroke as points arrive and preserves the drawn path', () => {
    const strokes: LiveStroke[] = [];
    expect(applyLiveStroke(strokes, incoming([0.1, 0.2]), 'first')).toBe('updated');
    expect(applyLiveStroke(strokes, incoming([0.1, 0.2, 0.3]), 'first')).toBe('updated');
    expect(strokes).toHaveLength(1);
    expect(strokes[0].points).toEqual([point(0.1), point(0.2), point(0.3)]);
  });

  it('rejects overwriting another participant and rewriting old points', () => {
    const strokes: LiveStroke[] = [];
    applyLiveStroke(strokes, incoming([0.1, 0.2]), 'first');
    expect(applyLiveStroke(strokes, incoming([0.1, 0.2, 0.3]), 'second')).toBe('stale');
    expect(applyLiveStroke(strokes, incoming([0.1, 0.9, 0.3]), 'first')).toBe('stale');
    expect(strokes[0].points).toEqual([point(0.1), point(0.2)]);
  });
});
