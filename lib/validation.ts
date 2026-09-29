import type { AnnotationStroke } from '@/components/annotation/types';

/**
 * Validates that a URL uses only safe schemes (http/https)
 * Prevents javascript:, data:, and other potentially dangerous URI schemes
 */
export function isValidHttpUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// The single list of annotation shapes: the stroke type, the renderer and the toolbar all
// derive from it, so a shape cannot be drawable in the UI and then refused on save.
export const ANNOTATION_SHAPES = ['rectangle', 'ellipse', 'line', 'arrow'] as const;
export type AnnotationShape = (typeof ANNOTATION_SHAPES)[number];

export function isAnnotationShape(value: unknown): value is AnnotationShape {
  return ANNOTATION_SHAPES.some((shape) => shape === value);
}

// Matches exactly 6-digit hex colours produced by the annotation canvas (e.g. #FF3B30)
const ANNOTATION_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_STROKES = 500;
const MAX_POINTS_PER_STROKE = 2000;
const MIN_STROKE_WIDTH = 1;
const MAX_STROKE_WIDTH = 20;

/**
 * Validates and returns a safe copy of annotation stroke data.
 *
 * Accepts only an array of plain stroke objects with the exact shape created
 * by AnnotationCanvas. Rejects anything that could trigger prototype pollution
 * or carry unexpected properties into the renderer.
 *
 * Returns null when the input is absent or structurally invalid.
 */
export function validateAnnotationStrokes(data: unknown): AnnotationStroke[] | null {
  if (data === null || data === undefined) return null;
  if (!Array.isArray(data)) return null;
  if (data.length > MAX_STROKES) return null;

  const result: AnnotationStroke[] = [];

  for (const stroke of data) {
    if (stroke === null || typeof stroke !== 'object' || Array.isArray(stroke)) return null;

    const { points, color, width, shape } = stroke as Record<string, unknown>;

    if (!Array.isArray(points)) return null;
    if (points.length > MAX_POINTS_PER_STROKE) return null;

    const safePoints: { x: number; y: number }[] = [];
    for (const pt of points) {
      if (pt === null || typeof pt !== 'object' || Array.isArray(pt)) return null;
      const { x, y } = pt as Record<string, unknown>;
      if (typeof x !== 'number' || !isFinite(x)) return null;
      if (typeof y !== 'number' || !isFinite(y)) return null;
      safePoints.push({ x, y });
    }

    if (typeof color !== 'string' || !ANNOTATION_COLOR_RE.test(color)) return null;
    // isFinite as well as the bounds: both comparisons are false for NaN, so a NaN width
    // cleared the range check and reached the stored annotation JSON, where
    // JSON.stringify renders it as null. Coordinates already had this guard.
    if (
      typeof width !== 'number' ||
      !isFinite(width) ||
      width < MIN_STROKE_WIDTH ||
      width > MAX_STROKE_WIDTH
    ) {
      return null;
    }

    // A missing shape is a freehand stroke. A shape stroke is two distinct points, a start and
    // an end, so any other count is malformed and a zero-length shape would save as an
    // annotation that draws nothing. The key is only written back when present, which keeps
    // freehand records byte-for-byte what they were before shapes existed.
    if (shape === undefined) {
      result.push({ points: safePoints, color, width });
      continue;
    }
    if (!isAnnotationShape(shape) || safePoints.length !== 2) return null;
    const [start, end] = safePoints;
    if (start.x === end.x && start.y === end.y) return null;
    result.push({ points: safePoints, color, width, shape });
  }

  return result;
}

/**
 * Validates a URL and returns an error message if invalid
 */
export function validateUrl(urlString: string, fieldName: string = 'URL'): string | null {
  if (!urlString || typeof urlString !== 'string') {
    return `${fieldName} is required`;
  }

  if (!isValidHttpUrl(urlString)) {
    return `${fieldName} must be a valid HTTP or HTTPS URL`;
  }

  return null;
}

/**
 * Validates an optional URL - returns null if empty/undefined, error if invalid
 */
export function validateOptionalUrl(
  urlString: string | null | undefined,
  fieldName: string = 'URL'
): string | null {
  if (!urlString) {
    return null; // Optional URLs can be empty
  }

  return validateUrl(urlString, fieldName);
}

const SAFE_APP_RELATIVE_PATH =
  /^\/(?:api\/upload\/(?:image|audio|video)\/[0-9a-f-]{36}\.[a-z0-9]+|placeholder-video-thumbnail\.png)$/i;

export function isSafeAppRelativePath(path: string): boolean {
  if (!path.startsWith('/') || path.includes('..')) {
    return false;
  }

  return SAFE_APP_RELATIVE_PATH.test(path);
}

/**
 * Accepts optional absolute http(s) URLs or safe same-origin app paths (upload proxy, placeholders).
 */
export function validateOptionalUrlOrAppPath(
  urlString: string | null | undefined,
  fieldName: string = 'URL'
): string | null {
  if (!urlString) {
    return null;
  }

  if (isSafeAppRelativePath(urlString)) {
    return null;
  }

  return validateOptionalUrl(urlString, fieldName);
}
