import type { LiveDrawingDelta, LiveSnapshot, LiveStroke } from './protocol';

export type DeltaResult =
  | { status: 'applied'; snapshot: LiveSnapshot }
  | { status: 'stale' | 'resync' };

export function applyDrawingDelta(
  current: LiveSnapshot | null,
  delta: LiveDrawingDelta
): DeltaResult {
  if (!current) return { status: 'resync' };
  if (delta.sessionId !== current.sessionId || delta.versionId !== current.versionId)
    return { status: 'stale' };
  if (
    !Number.isSafeInteger(delta.revision) ||
    !Number.isSafeInteger(delta.baseRevision) ||
    !Number.isSafeInteger(delta.canvasEpoch) ||
    !Number.isFinite(delta.serverTime)
  )
    return { status: 'resync' };
  if (delta.revision <= current.revision) return { status: 'stale' };
  if (
    delta.canvasEpoch !== current.canvasEpoch ||
    delta.baseRevision !== current.revision ||
    delta.revision !== delta.baseRevision + 1
  )
    return { status: 'resync' };

  let strokes: LiveStroke[];
  if (delta.type === 'stroke-remove') {
    if (typeof delta.strokeId !== 'string') return { status: 'resync' };
    const index = current.strokes.findIndex((stroke) => stroke.id === delta.strokeId);
    if (index < 0) return { status: 'resync' };
    strokes = current.strokes.filter((stroke) => stroke.id !== delta.strokeId);
  } else {
    if (
      !delta.stroke ||
      typeof delta.stroke.id !== 'string' ||
      typeof delta.stroke.participantId !== 'string' ||
      typeof delta.stroke.color !== 'string' ||
      !Number.isFinite(delta.stroke.width) ||
      !Number.isSafeInteger(delta.fromIndex) ||
      !Array.isArray(delta.points) ||
      !delta.points.every(
        (point) =>
          point &&
          Number.isFinite(point.x) &&
          Number.isFinite(point.y) &&
          point.x >= 0 &&
          point.x <= 1 &&
          point.y >= 0 &&
          point.y <= 1
      )
    )
      return { status: 'resync' };
    const index = current.strokes.findIndex((stroke) => stroke.id === delta.stroke.id);
    if (index < 0) {
      if (delta.fromIndex !== 0 || delta.points.length === 0) return { status: 'resync' };
      strokes = [...current.strokes, { ...delta.stroke, points: delta.points }];
    } else {
      const existing = current.strokes[index];
      if (
        delta.fromIndex !== existing.points.length ||
        existing.participantId !== delta.stroke.participantId ||
        existing.color !== delta.stroke.color ||
        existing.width !== delta.stroke.width ||
        delta.points.length === 0
      )
        return { status: 'resync' };
      strokes = current.strokes.map((stroke, position) =>
        position === index ? { ...stroke, points: [...stroke.points, ...delta.points] } : stroke
      );
    }
  }

  return {
    status: 'applied',
    snapshot: { ...current, strokes, revision: delta.revision, serverTime: delta.serverTime },
  };
}
