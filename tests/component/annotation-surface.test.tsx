import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createRef, useState } from 'react';
import { AnnotationCanvas, type AnnotationCanvasHandle } from '@/components/annotation-canvas';
import { AnnotationSettings } from '@/components/annotation/settings';
import { AnnotationSurface, annotationPath } from '@/components/annotation/surface';
import type { AnnotationStroke } from '@/components/annotation/types';

const bounds = {
  left: 10,
  top: 20,
  right: 510,
  bottom: 270,
  width: 500,
  height: 250,
  x: 10,
  y: 20,
  toJSON: () => ({}),
} as DOMRect;

afterEach(() => vi.restoreAllMocks());

describe('AnnotationSurface', () => {
  it('uses one pointer, normalized points and the selected style for a completed stroke', () => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    const completed = vi.fn();
    function Harness() {
      const [active, setActive] = useState<AnnotationStroke | null>(null);
      const [strokes, setStrokes] = useState<AnnotationStroke[]>([]);
      return (
        <AnnotationSurface
          strokes={strokes}
          activeStroke={active}
          enabled
          color="#007AFF"
          width={5}
          createStroke={(point, color, width) => ({ points: [point], color, width })}
          onStrokeStart={setActive}
          onStrokeChange={setActive}
          onStrokeEnd={(stroke) => {
            completed(stroke);
            setStrokes((previous) => [...previous, stroke]);
            setActive(null);
          }}
        />
      );
    }
    render(<Harness />);
    const canvas = screen.getByLabelText('Annotation canvas');
    fireEvent.pointerDown(canvas, { clientX: 60, clientY: 45, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 260, clientY: 145, pointerId: 2 });
    fireEvent.pointerMove(canvas, { clientX: 260, clientY: 145, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 260, clientY: 145, pointerId: 1 });
    expect(completed).toHaveBeenCalledWith({
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.5 },
      ],
      color: '#007AFF',
      width: 5,
    });
    expect(canvas.querySelector('path')).toHaveAttribute('d', 'M 100 100 L 500 500');
    expect(canvas.querySelector('path')).toHaveAttribute('stroke-width', '2.5');
  });

  it('cancels an active stroke when drawing becomes disabled', () => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    const completed = vi.fn();
    const cancelled = vi.fn();
    function Harness({ enabled }: { enabled: boolean }) {
      const [active, setActive] = useState<AnnotationStroke | null>(null);
      return (
        <AnnotationSurface
          strokes={[]}
          activeStroke={active}
          enabled={enabled}
          color="#FF3B30"
          width={3}
          createStroke={(point, color, width) => ({ points: [point], color, width })}
          onStrokeStart={setActive}
          onStrokeChange={setActive}
          onStrokeEnd={completed}
          onStrokeCancel={() => {
            cancelled();
            setActive(null);
          }}
        />
      );
    }
    const { rerender } = render(<Harness enabled />);
    const canvas = screen.getByLabelText('Annotation canvas');
    fireEvent.pointerDown(canvas, { clientX: 60, clientY: 45, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 260, clientY: 145, pointerId: 1 });
    rerender(<Harness enabled={false} />);
    fireEvent.pointerUp(canvas, { clientX: 260, clientY: 145, pointerId: 1 });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    expect(canvas.querySelector('path')).toBeNull();
  });
});

describe('AnnotationCanvas shape tools', () => {
  function drag(canvas: HTMLElement, points: [number, number][]) {
    const [[startX, startY], ...rest] = points;
    fireEvent.pointerDown(canvas, { clientX: startX, clientY: startY, pointerId: 1 });
    for (const [clientX, clientY] of rest) {
      fireEvent.pointerMove(canvas, { clientX, clientY, pointerId: 1 });
    }
    const [endX, endY] = points[points.length - 1];
    fireEvent.pointerUp(canvas, { clientX: endX, clientY: endY, pointerId: 1 });
  }

  it('draws freehand by default and keeps every point', () => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    const ref = createRef<AnnotationCanvasHandle>();
    render(<AnnotationCanvas ref={ref} mode="draw" />);

    expect(screen.getByRole('button', { name: 'Freehand' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    drag(screen.getByLabelText('Annotation canvas'), [
      [60, 45],
      [160, 95],
      [260, 145],
    ]);

    expect(ref.current!.getStrokes()).toStrictEqual([
      {
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.3, y: 0.3 },
          { x: 0.5, y: 0.5 },
        ],
        color: '#FF3B30',
        width: 3,
      },
    ]);
  });

  it('stores a rectangle as its start and final corner and renders a closed box', () => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    const ref = createRef<AnnotationCanvasHandle>();
    render(<AnnotationCanvas ref={ref} mode="draw" />);

    fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));
    const canvas = screen.getByLabelText('Annotation canvas');
    drag(canvas, [
      [60, 45],
      [460, 220],
      [160, 95],
      [260, 145],
    ]);

    expect(ref.current!.getStrokes()).toEqual([
      {
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.5, y: 0.5 },
        ],
        color: '#FF3B30',
        width: 3,
        shape: 'rectangle',
      },
    ]);
    expect(canvas.querySelector('path')).toHaveAttribute(
      'd',
      'M 100 100 L 500 100 L 500 500 L 100 500 Z'
    );
  });

  it('draws an ellipse that fills the dragged box', () => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    const ref = createRef<AnnotationCanvasHandle>();
    render(<AnnotationCanvas ref={ref} mode="draw" />);

    fireEvent.click(screen.getByRole('button', { name: 'Ellipse' }));
    const canvas = screen.getByLabelText('Annotation canvas');
    drag(canvas, [
      [60, 45],
      [460, 220],
      [260, 95],
    ]);

    expect(ref.current!.getStrokes()).toEqual([
      {
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.5, y: 0.3 },
        ],
        color: '#FF3B30',
        width: 3,
        shape: 'ellipse',
      },
    ]);
    expect(canvas.querySelector('path')).toHaveAttribute(
      'd',
      'M 100 200 A 200 100 0 1 0 500 200 A 200 100 0 1 0 100 200 Z'
    );
  });

  it('draws a straight line between the two ends whatever the pointer did in between', () => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    const ref = createRef<AnnotationCanvasHandle>();
    render(<AnnotationCanvas ref={ref} mode="draw" />);

    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    const canvas = screen.getByLabelText('Annotation canvas');
    drag(canvas, [
      [60, 45],
      [400, 60],
      [260, 145],
    ]);

    expect(ref.current!.getStrokes()[0].shape).toBe('line');
    expect(canvas.querySelector('path')).toHaveAttribute('d', 'M 100 100 L 500 500');
  });

  it('keeps a perfectly horizontal line', () => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    const ref = createRef<AnnotationCanvasHandle>();
    render(<AnnotationCanvas ref={ref} mode="draw" />);

    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    drag(screen.getByLabelText('Annotation canvas'), [
      [60, 145],
      [260, 145],
    ]);

    expect(ref.current!.getStrokes()).toHaveLength(1);
  });

  it('keeps a freehand stroke that closes on its own starting point', () => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    const ref = createRef<AnnotationCanvasHandle>();
    render(<AnnotationCanvas ref={ref} mode="draw" />);

    drag(screen.getByLabelText('Annotation canvas'), [
      [60, 45],
      [260, 145],
      [60, 45],
    ]);

    expect(ref.current!.getStrokes()).toHaveLength(1);
    expect(ref.current!.getStrokes()[0].points).toHaveLength(3);
  });

  it('pins the end of a shape to the frame edge when the drag leaves the frame', () => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    const ref = createRef<AnnotationCanvasHandle>();
    render(<AnnotationCanvas ref={ref} mode="draw" />);

    fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));
    drag(screen.getByLabelText('Annotation canvas'), [
      [60, 45],
      [160, 95],
      [900, 600],
    ]);

    expect(ref.current!.getStrokes()[0].points).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 1, y: 1 },
    ]);
  });

  it('draws an arrow head corrected for the aspect ratio of the rendered frame', () => {
    // bounds is 500x250, so the surface is twice as wide as it is tall.
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    render(<AnnotationCanvas mode="draw" />);

    fireEvent.click(screen.getByRole('button', { name: 'Arrow' }));
    const canvas = screen.getByLabelText('Annotation canvas');
    drag(canvas, [
      [60, 145],
      [260, 145],
    ]);

    expect(canvas.querySelector('path')).toHaveAttribute(
      'd',
      'M 100 500 L 500 500 M 489.61 488 L 500 500 L 489.61 512'
    );
  });

  it('falls back to a square surface when the frame has no measurable height', () => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
      ...bounds,
      height: 0,
      bottom: bounds.top,
    } as DOMRect);
    render(
      <AnnotationCanvas
        mode="view"
        strokes={[
          {
            points: [
              { x: 0.1, y: 0.5 },
              { x: 0.5, y: 0.5 },
            ],
            color: '#FF3B30',
            width: 3,
            shape: 'arrow',
          },
        ]}
      />
    );

    expect(screen.getByLabelText('Annotation canvas').querySelector('path')).toHaveAttribute(
      'd',
      'M 100 500 L 500 500 M 489.61 494 L 500 500 L 489.61 506'
    );
  });

  it('drops a shape that was clicked but never dragged', () => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    const ref = createRef<AnnotationCanvasHandle>();
    render(<AnnotationCanvas ref={ref} mode="draw" />);

    fireEvent.click(screen.getByRole('button', { name: 'Arrow' }));
    const canvas = screen.getByLabelText('Annotation canvas');
    drag(canvas, [
      [60, 45],
      [60, 45],
    ]);

    expect(ref.current!.getStrokes()).toEqual([]);
    expect(canvas.querySelector('path')).toBeNull();
  });

  it('renders a rectangle loaded from a saved comment in view mode', () => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    render(
      <AnnotationCanvas
        mode="view"
        strokes={[
          {
            points: [
              { x: 0.2, y: 0.2 },
              { x: 0.4, y: 0.6 },
            ],
            color: '#007AFF',
            width: 2,
            shape: 'rectangle',
          },
        ]}
      />
    );

    expect(screen.getByLabelText('Annotation canvas').querySelector('path')).toHaveAttribute(
      'd',
      'M 200 200 L 400 200 L 400 600 L 200 600 Z'
    );
  });
});

describe('annotationPath', () => {
  const arrow = {
    points: [
      { x: 0.1, y: 0.5 },
      { x: 0.5, y: 0.5 },
    ],
    color: '#FF3B30',
    width: 3,
    shape: 'arrow' as const,
  };

  it('puts a 30 degree head on the end of an arrow on a square surface', () => {
    expect(annotationPath(arrow, 1)).toBe(
      'M 100 500 L 500 500 M 489.61 494 L 500 500 L 489.61 506'
    );
  });

  // The viewBox stretches to the surface, so on a surface twice as wide as it is tall the head
  // has to span twice the vertical viewBox units to look the same on screen.
  it('corrects the arrow head for the aspect ratio of the surface', () => {
    expect(annotationPath(arrow, 0.5)).toBe(
      'M 100 500 L 500 500 M 489.61 488 L 500 500 L 489.61 512'
    );
  });

  it('draws a stroke with an unrecognised shape as freehand rather than as an arrow', () => {
    const unknown = { ...arrow, shape: 'triangle' } as unknown as typeof arrow;
    expect(annotationPath(unknown)).toBe('M 100 500 L 500 500');
  });

  it('corrects the angle of a diagonal arrow head for the aspect ratio', () => {
    const diagonal = {
      ...arrow,
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.3 },
      ],
    };
    expect(annotationPath(diagonal, 0.5)).toBe(
      'M 100 100 L 500 300 M 491.37 283.32 L 500 300 L 488.46 306.6'
    );
  });

  it('grows the arrow head with the stroke width', () => {
    expect(annotationPath({ ...arrow, width: 5 }, 1)).toBe(
      'M 100 500 L 500 500 M 482.68 490 L 500 500 L 482.68 510'
    );
  });

  it('caps the head of a short arrow at half its length', () => {
    const short = {
      ...arrow,
      points: [
        { x: 0.1, y: 0.5 },
        { x: 0.11, y: 0.5 },
      ],
    };
    expect(annotationPath(short, 1)).toBe(
      'M 100 500 L 110 500 M 105.67 497.5 L 110 500 L 105.67 502.5'
    );
  });

  it('draws an ellipse flattened by a straight vertical drag as a line', () => {
    const flat = {
      ...arrow,
      shape: 'ellipse' as const,
      points: [
        { x: 0.3, y: 0.1 },
        { x: 0.3, y: 0.6 },
      ],
    };
    expect(annotationPath(flat as unknown as typeof arrow, 1)).toBe('M 300 100 L 300 600');
  });

  it('draws a zero-length arrow as a bare line rather than a head with no direction', () => {
    const point = { x: 0.1, y: 0.5 };
    expect(annotationPath({ ...arrow, points: [point, point] }, 1)).toBe('M 100 500 L 100 500');
  });

  it('reads a stroke with no shape as freehand, the way records saved before shapes do', () => {
    expect(annotationPath({ ...arrow, shape: undefined })).toBe('M 100 500 L 500 500');
  });
});

describe('AnnotationSurface maxPoints', () => {
  it('stops adding freehand points at the cap', () => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    const completed = vi.fn();
    function Harness() {
      const [active, setActive] = useState<AnnotationStroke | null>(null);
      return (
        <AnnotationSurface
          strokes={[]}
          activeStroke={active}
          enabled
          color="#FF3B30"
          width={3}
          maxPoints={3}
          createStroke={(point, color, width) => ({ points: [point], color, width })}
          onStrokeStart={setActive}
          onStrokeChange={setActive}
          onStrokeEnd={completed}
        />
      );
    }
    render(<Harness />);
    const canvas = screen.getByLabelText('Annotation canvas');
    fireEvent.pointerDown(canvas, { clientX: 60, clientY: 45, pointerId: 1 });
    for (const clientX of [110, 160, 210, 260, 310]) {
      fireEvent.pointerMove(canvas, { clientX, clientY: 45, pointerId: 1 });
    }
    fireEvent.pointerUp(canvas, { clientX: 310, clientY: 45, pointerId: 1 });

    expect(completed.mock.calls[0][0].points).toHaveLength(3);
  });

  it('keeps moving the end of a shape even when the cap is lower than two', () => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    const completed = vi.fn();
    function Harness() {
      const [active, setActive] = useState<AnnotationStroke | null>(null);
      return (
        <AnnotationSurface
          strokes={[]}
          activeStroke={active}
          enabled
          color="#FF3B30"
          width={3}
          maxPoints={1}
          createStroke={(point, color, width) => ({ points: [point], color, width, shape: 'line' })}
          onStrokeStart={setActive}
          onStrokeChange={setActive}
          onStrokeEnd={completed}
        />
      );
    }
    render(<Harness />);
    const canvas = screen.getByLabelText('Annotation canvas');
    fireEvent.pointerDown(canvas, { clientX: 60, clientY: 45, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 260, clientY: 145, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 260, clientY: 145, pointerId: 1 });

    expect(completed.mock.calls[0][0].points).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.5 },
    ]);
  });
});

describe('AnnotationSettings', () => {
  it('exposes the shared palette and clamps width at its limits', () => {
    const onColorChange = vi.fn();
    const onWidthChange = vi.fn();
    const { rerender } = render(
      <AnnotationSettings
        color="#FF3B30"
        width={10}
        onColorChange={onColorChange}
        onWidthChange={onWidthChange}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Blue' }));
    expect(onColorChange).toHaveBeenCalledWith('#007AFF');
    expect(screen.getByRole('button', { name: 'Increase stroke width' })).toBeDisabled();
    rerender(
      <AnnotationSettings
        color="#007AFF"
        width={1}
        onColorChange={onColorChange}
        onWidthChange={onWidthChange}
      />
    );
    expect(screen.getByRole('button', { name: 'Blue' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Decrease stroke width' })).toBeDisabled();
  });
});
