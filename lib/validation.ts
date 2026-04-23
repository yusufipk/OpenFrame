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
export function validateAnnotationStrokes(
  data: unknown
): { points: { x: number; y: number }[]; color: string; width: number }[] | null {
  if (data === null || data === undefined) return null;
  if (!Array.isArray(data)) return null;
  if (data.length > MAX_STROKES) return null;

  const result: { points: { x: number; y: number }[]; color: string; width: number }[] = [];

  for (const stroke of data) {
    if (stroke === null || typeof stroke !== 'object' || Array.isArray(stroke)) return null;

    const { points, color, width } = stroke as Record<string, unknown>;

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
    if (typeof width !== 'number' || width < MIN_STROKE_WIDTH || width > MAX_STROKE_WIDTH)
      return null;

    result.push({ points: safePoints, color, width });
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
