import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { AnnotationSettings } from '@/components/annotation/settings';
import { AnnotationSurface } from '@/components/annotation/surface';
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
