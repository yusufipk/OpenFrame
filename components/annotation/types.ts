import type { AnnotationShape } from '@/lib/validation';

export type { AnnotationShape };

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface AnnotationStroke {
  /** A shape stroke stores exactly two points: where the drag started and where it ended. */
  points: AnnotationPoint[];
  color: string;
  width: number;
  /** Absent means a freehand stroke, which is also how every record saved before shapes reads. */
  shape?: AnnotationShape;
}
