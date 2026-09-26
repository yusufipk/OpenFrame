export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface AnnotationStroke {
  points: AnnotationPoint[];
  color: string;
  width: number;
}
