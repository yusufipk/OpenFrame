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

export function annotationPath(stroke: AnnotationStroke): string {
  return stroke.points
    .map((point, index) => `${index ? 'L' : 'M'} ${point.x * 1000} ${point.y * 1000}`)
    .join(' ');
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
  const [surfaceWidth, setSurfaceWidth] = useState(ANNOTATION_REFERENCE_WIDTH);

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
    const measure = () =>
      setSurfaceWidth(svg.getBoundingClientRect().width || ANNOTATION_REFERENCE_WIDTH);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const pointFromEvent = (event: PointerEvent<SVGSVGElement>) =>
    pointInContent(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());

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
    if (maxPoints !== undefined && previous.points.length >= maxPoints) return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    const stroke = { ...previous, points: [...previous.points, point] } as T;
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
    if (enabled && stroke.points.length >= 2) onStrokeEnd(stroke);
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
          d={annotationPath(stroke)}
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
