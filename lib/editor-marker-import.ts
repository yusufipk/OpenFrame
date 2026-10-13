import { NLE_FRAME_RATES } from '@/lib/nle-comment-export';

// The editor plugins send the editor's own timeline markers back as comments. These
// helpers check what they send and turn frames into the seconds a comment stores.

export const MAX_IMPORT_MARKERS = 500;
export const MAX_MARKER_COMMENT_LENGTH = 10_000;
// A field this long is no marker anyone typed, so the whole request is refused
// rather than read.
const MAX_MARKER_FIELD_LENGTH = 50_000;

export interface ImportMarker {
  startFrame: number;
  durationFrames: number;
  name: string;
  comments: string;
}

export interface ImportRequest {
  fps: string;
  markers: ImportMarker[];
}

export type ImportSkipReason = 'empty' | 'tooLong' | 'outOfRange';

function isFrame(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isField(value: unknown): value is string | undefined | null {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.length <= MAX_MARKER_FIELD_LENGTH)
  );
}

/** The request body, or an error message for a 400. */
export function parseImportRequest(body: unknown): ImportRequest | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'Expected a JSON object' };
  const { fps, markers } = body as { fps?: unknown; markers?: unknown };
  if (typeof fps !== 'string' || !(NLE_FRAME_RATES as readonly string[]).includes(fps)) {
    return { error: 'Select a supported frame rate. Use exact fractional rates.' };
  }
  if (!Array.isArray(markers) || markers.length === 0) {
    return { error: 'markers must be a non-empty array' };
  }
  if (markers.length > MAX_IMPORT_MARKERS) {
    return { error: `Send at most ${MAX_IMPORT_MARKERS} markers at a time` };
  }
  const parsed: ImportMarker[] = [];
  for (const marker of markers) {
    if (typeof marker !== 'object' || marker === null) {
      return { error: 'Every marker must be an object' };
    }
    const { startFrame, durationFrames, name, comments } = marker as Record<string, unknown>;
    if (!isFrame(startFrame)) return { error: 'startFrame must be a non-negative whole number' };
    if (durationFrames !== undefined && durationFrames !== null && !isFrame(durationFrames)) {
      return { error: 'durationFrames must be a non-negative whole number' };
    }
    if (!isField(name) || !isField(comments)) {
      return { error: 'Marker name and comments must be text' };
    }
    parsed.push({
      startFrame,
      durationFrames: durationFrames ?? 0,
      name: name ?? '',
      comments: comments ?? '',
    });
  }
  return { fps, markers: parsed };
}

/** A frame count at an exact rate such as 30000/1001, in seconds. */
export function framesToSeconds(frames: number, fps: string): number {
  const [numerator, denominator = 1] = fps.split('/').map(Number);
  return (frames * denominator) / numerator;
}

/**
 * The comment text for a marker: its name and its note, each on its own line,
 * whichever of them the editor filled in.
 */
export function markerCommentContent(marker: Pick<ImportMarker, 'name' | 'comments'>): string {
  return [marker.name, marker.comments]
    .map((part) => part.replace(/\r\n?/g, '\n').trim())
    .filter((part) => part !== '')
    .join('\n');
}

/**
 * Same start and same text is the same comment, so sending a timeline twice adds
 * nothing the second time. Milliseconds absorb the float error of frame division.
 */
export function importDedupeKey(timestamp: number, content: string): string {
  return `${Math.round(timestamp * 1000)}|${content}`;
}

export interface PlannedComment {
  index: number;
  content: string;
  timestamp: number;
  timestampEnd: number | null;
}

export interface ImportPlan {
  create: PlannedComment[];
  /** Indexes of markers whose comment is already on the version. */
  duplicates: number[];
  skipped: Record<ImportSkipReason, number>;
}

/**
 * Decides what each marker becomes. `existingKeys` holds the dedupe keys of the
 * caller's comments already on the version; `maxSeconds` is the version length,
 * or null when it is unknown.
 */
export function planMarkerImport(
  request: ImportRequest,
  existingKeys: ReadonlySet<string>,
  maxSeconds: number | null
): ImportPlan {
  const plan: ImportPlan = {
    create: [],
    duplicates: [],
    skipped: { empty: 0, tooLong: 0, outOfRange: 0 },
  };
  const seen = new Set(existingKeys);
  request.markers.forEach((marker, index) => {
    const content = markerCommentContent(marker);
    if (content === '') {
      plan.skipped.empty += 1;
      return;
    }
    if (content.length > MAX_MARKER_COMMENT_LENGTH) {
      plan.skipped.tooLong += 1;
      return;
    }
    const timestamp = framesToSeconds(marker.startFrame, request.fps);
    if (maxSeconds !== null && timestamp > maxSeconds) {
      plan.skipped.outOfRange += 1;
      return;
    }
    const key = importDedupeKey(timestamp, content);
    if (seen.has(key)) {
      plan.duplicates.push(index);
      return;
    }
    seen.add(key);
    // A marker one frame long or shorter is a point, as the player draws it.
    let timestampEnd: number | null = null;
    if (marker.durationFrames > 1) {
      timestampEnd = framesToSeconds(marker.startFrame + marker.durationFrames, request.fps);
      if (maxSeconds !== null) timestampEnd = Math.min(timestampEnd, maxSeconds);
      // Clamped down to its own start, a range is a point.
      if (timestampEnd <= timestamp) timestampEnd = null;
    }
    plan.create.push({ index, content, timestamp, timestampEnd });
  });
  return plan;
}
