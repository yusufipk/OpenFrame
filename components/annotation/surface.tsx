'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { isAnnotationShape } from '@/lib/validation';
import { ANNOTATION_REFERENCE_WIDTH } from './palette';
import type { AnnotationPoint, AnnotationStroke } from './types';

export function pointInContent(
  clientX: number,
  clientY: number,
  bounds: DOMRect
): AnnotationPoint | null {
  if (
    !bounds.width ||
    !bounds.height ||
    clientX < bounds.left ||
    clientX > bounds.right ||
    clientY < bounds.top ||
    clientY > bounds.bottom
  )
    return null;
  return { x: (clientX - bounds.left) / bounds.width, y: (clientY - bounds.top) / bounds.height };
}

const ARROW_HEAD_ANGLE = Math.PI / 6;

function scaled(value: number): number {
  return Math.round(value * 1000 * 100) / 100;
}

/**
 * The SVG path for a stroke in the 1000x1000 viewBox. `aspect` is the surface's height over
 * its width: the viewBox is stretched to the surface, so an arrow head computed in
 * normalized coordinates alone would come out squashed on a 16:9 frame.
 */
export function annotationPath(stroke: AnnotationStroke, aspect = 1): string {
  const [start, end] = stroke.points;
  // Only a known shape branches; anything else draws as the freehand polyline it is.
  if (isAnnotationShape(stroke.shape) && start && end) {
    const x0 = scaled(start.x);
    const y0 = scaled(start.y);
    const x1 = scaled(end.x);
    const y1 = scaled(end.y);
    if (stroke.shape === 'rectangle') {
      return `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1} L ${x0} ${y1} Z`;
    }
    if (stroke.shape === 'ellipse') {
      // The ellipse fills the dragged box, drawn as two half arcs from its left to its right
      // edge and back. The viewBox stretch keeps it an ellipse on any surface.
      const round = (value: number) => Math.round(value * 100) / 100;
      const cx = round((x0 + x1) / 2);
      const cy = round((y0 + y1) / 2);
      const rx = round(Math.abs(x1 - x0) / 2);
      const ry = round(Math.abs(y1 - y0) / 2);
      // A flat box has no ellipse in it, and SVG drops an arc whose ends meet, so a straight
      // vertical drag would save a shape nobody can see. Draw it as the line it collapsed to.
      if (!rx || !ry) return `M ${x0} ${y0} L ${x1} ${y1}`;
      const left = round(cx - rx);
      const right = round(cx + rx);
      return `M ${left} ${cy} A ${rx} ${ry} 0 1 0 ${right} ${cy} A ${rx} ${ry} 0 1 0 ${left} ${cy} Z`;
    }
    const line = `M ${x0} ${y0} L ${x1} ${y1}`;
    if (stroke.shape === 'line') return line;
    // Work in units of surface width on both axes so the head keeps its angles, then map the
    // vertical back. The head grows with the stroke width, which is also relative to width.
    const dx = end.x - start.x;
    const dy = (end.y - start.y) * aspect;
    const length = Math.hypot(dx, dy);
    if (!length) return line;
    const headLength = Math.min(Math.max(12, stroke.width * 4) / 1000, length / 2);
    const angle = Math.atan2(dy, dx);
    const barb = (side: number) => {
      const theta = angle + Math.PI + side * ARROW_HEAD_ANGLE;
      return `${scaled(end.x + headLength * Math.cos(theta))} ${scaled(end.y + (headLength * Math.sin(theta)) / aspect)}`;
    };
    return `${line} M ${barb(1)} L ${x1} ${y1} L ${barb(-1)}`;
  }
  return stroke.points
    .map((point, index) => `${index ? 'L' : 'M'} ${point.x * 1000} ${point.y * 1000}`)
    .join(' ');
}

function isDrawable(stroke: AnnotationStroke): boolean {
  if (stroke.points.length < 2) return false;
  if (!isAnnotationShape(stroke.shape)) return true;
  const [start, end] = stroke.points;
  return start.x !== end.x || start.y !== end.y;
}

export interface AnnotationSurfaceHandle {
  cancelActive: () => void;
}

export interface AnnotationSurfaceProps<T extends AnnotationStroke> {
  strokes: readonly T[];
  activeStroke: T | null;
  enabled: boolean;
  color: string;
  width: number;
  createStroke: (point: AnnotationPoint, color: string, width: number) => T;
  onStrokeStart: (stroke: T) => void;
  onStrokeChange: (stroke: T) => void;
  onStrokeEnd: (stroke: T) => void;
  onStrokeCancel?: () => void;
  maxPoints?: number;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  onClick?: (event: MouseEvent<SVGSVGElement>) => void;
}

function AnnotationSurfaceInner<T extends AnnotationStroke>(
  {
    strokes,
    activeStroke,
    enabled,
    color,
    width,
    createStroke,
    onStrokeStart,
    onStrokeChange,
    onStrokeEnd,
    onStrokeCancel,
    maxPoints,
    className,
    style,
    ariaLabel = 'Annotation canvas',
    onClick,
  }: AnnotationSurfaceProps<T>,
  ref: React.ForwardedRef<AnnotationSurfaceHandle>
) {
  const svgRef = useRef<SVGSVGElement>(null);
  const activeRef = useRef<T | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const [surfaceSize, setSurfaceSize] = useState({
    width: ANNOTATION_REFERENCE_WIDTH,
    height: ANNOTATION_REFERENCE_WIDTH,
  });
  const surfaceWidth = surfaceSize.width;
  const aspect = surfaceSize.height / surfaceSize.width;

  const cancelActive = () => {
    const svg = svgRef.current;
    const pointerId = pointerIdRef.current;
    const hadActive = activeRef.current !== null;
    activeRef.current = null;
    pointerIdRef.current = null;
    if (svg && pointerId !== null && svg.hasPointerCapture(pointerId)) {
      svg.releasePointerCapture(pointerId);
    }
    if (hadActive) onStrokeCancel?.();
  };

  useImperativeHandle(ref, () => ({ cancelActive }));

  useEffect(() => {
    if (!enabled || (activeRef.current && !activeStroke)) cancelActive();
  });

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const { width, height } = svg.getBoundingClientRect();
      setSurfaceSize(
        width && height
          ? { width, height }
          : { width: ANNOTATION_REFERENCE_WIDTH, height: ANNOTATION_REFERENCE_WIDTH }
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const pointFromEvent = (event: PointerEvent<SVGSVGElement>) =>
    pointInContent(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());

  const clampedPointFromEvent = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return pointInContent(
      Math.min(Math.max(event.clientX, bounds.left), bounds.right),
      Math.min(Math.max(event.clientY, bounds.top), bounds.bottom),
      bounds
    );
  };

  const start = (event: PointerEvent<SVGSVGElement>) => {
    if (!enabled || activeRef.current || (event.pointerType === 'mouse' && event.button !== 0))
      return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke = createStroke(point, color, width);
    activeRef.current = stroke;
    pointerIdRef.current = event.pointerId;
    onStrokeStart(stroke);
  };

  const move = (event: PointerEvent<SVGSVGElement>) => {
    const previous = activeRef.current;
    if (!enabled || !previous || pointerIdRef.current !== event.pointerId) return;
    const shape = isAnnotationShape(previous.shape);
    if (!shape && maxPoints !== undefined && previous.points.length >= maxPoints) return;
    // A shape's end follows the pointer past the edge, pinned to it, so a fast drag out of the
    // frame still reaches the edge instead of stopping at the last in-bounds sample.
    const point = shape ? clampedPointFromEvent(event) : pointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    // A shape follows the pointer from its anchor, so only the end point moves.
    const points = shape ? [previous.points[0], point] : [...previous.points, point];
    const stroke = { ...previous, points } as T;
    activeRef.current = stroke;
    onStrokeChange(stroke);
  };

  const finish = (event: PointerEvent<SVGSVGElement>) => {
    const stroke = activeRef.current;
    if (!stroke || pointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    activeRef.current = null;
    pointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (enabled && isDrawable(stroke)) onStrokeEnd(stroke);
    else onStrokeCancel?.();
  };

  const cancel = (event: PointerEvent<SVGSVGElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    cancelActive();
  };

  return (
    <svg
      ref={svgRef}
      aria-label={ariaLabel}
      className={className}
      style={style}
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onClick={onClick}
    >
      {[...strokes, ...(activeStroke ? [activeStroke] : [])].map((stroke, index) => (
        <path
          key={'id' in stroke && typeof stroke.id === 'string' ? stroke.id : index}
          d={annotationPath(stroke, aspect)}
          fill="none"
          stroke={stroke.color}
          strokeWidth={(stroke.width * surfaceWidth) / ANNOTATION_REFERENCE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      ))}
    </svg>
  );
}

export const AnnotationSurface = forwardRef(AnnotationSurfaceInner) as <T extends AnnotationStroke>(
  props: AnnotationSurfaceProps<T> & { ref?: React.Ref<AnnotationSurfaceHandle> }
) => React.ReactElement;
