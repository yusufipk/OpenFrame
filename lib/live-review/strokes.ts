import { LIVE_MAX_STROKES, type LiveStroke } from './protocol';

export type StrokeChange = 'updated' | 'stale' | 'limit';

export function applyLiveStroke(
  strokes: LiveStroke[],
  incoming: Omit<LiveStroke, 'participantId'>,
  participantId: string
): StrokeChange {
  const existingIndex = strokes.findIndex((stroke) => stroke.id === incoming.id);
  const existing = existingIndex >= 0 ? strokes[existingIndex] : null;
  if (
    existing &&
    (existing.participantId !== participantId ||
      existing.color !== incoming.color ||
      existing.width !== incoming.width ||
      incoming.points.length < existing.points.length ||
      existing.points.some(
        (point, index) =>
          point.x !== incoming.points[index].x || point.y !== incoming.points[index].y
      ))
  )
    return 'stale';
  const total = strokes.reduce((count, stroke) => count + stroke.points.length, 0);
  if (
    (!existing && strokes.length >= LIVE_MAX_STROKES) ||
    total - (existing?.points.length ?? 0) + incoming.points.length > 2000
  )
    return 'limit';
  const next = { ...incoming, participantId };
  if (existing) strokes[existingIndex] = next;
  else strokes.push(next);
  return 'updated';
}
