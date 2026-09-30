'use client';

import { forwardRef, useCallback, useImperativeHandle, useState } from 'react';
import { createPortal } from 'react-dom';
import { Circle, MoveUpRight, Pencil, Slash, Square, Trash2, Undo2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DEFAULT_ANNOTATION_COLOR,
  DEFAULT_ANNOTATION_WIDTH,
} from '@/components/annotation/palette';
import { AnnotationSettings } from '@/components/annotation/settings';
import { AnnotationSurface } from '@/components/annotation/surface';
import { ANNOTATION_SHAPES } from '@/lib/validation';
import type {
  AnnotationPoint,
  AnnotationShape,
  AnnotationStroke,
} from '@/components/annotation/types';

export type { AnnotationStroke } from '@/components/annotation/types';

type AnnotationTool = 'freehand' | AnnotationShape;

// A Record keyed by the shape type, so a shape added to ANNOTATION_SHAPES fails to compile
// until it has a button here.
const SHAPE_TOOLS: Record<AnnotationShape, { label: string; icon: typeof Pencil }> = {
  rectangle: { label: 'Rectangle', icon: Square },
  ellipse: { label: 'Ellipse', icon: Circle },
  line: { label: 'Line', icon: Slash },
  arrow: { label: 'Arrow', icon: MoveUpRight },
};

const ANNOTATION_TOOLS: { tool: AnnotationTool; label: string; icon: typeof Pencil }[] = [
  { tool: 'freehand', label: 'Freehand', icon: Pencil },
  ...ANNOTATION_SHAPES.map((shape) => ({ tool: shape, ...SHAPE_TOOLS[shape] })),
];

export interface AnnotationCanvasHandle {
  getStrokes: () => AnnotationStroke[];
}

interface AnnotationCanvasProps {
  mode: 'draw' | 'view';
  strokes?: AnnotationStroke[];
  onConfirm?: (strokes: AnnotationStroke[]) => void;
  onCancel?: () => void;
  onDismiss?: () => void;
  toolbarContainer?: HTMLElement | null;
  /**
   * `overlay` floats the toolbar over the top of the frame. `inline` lays it out as a
   * full-width strip, for a container outside the frame: on a phone the player is too
   * small to draw on with a toolbar covering it.
   */
  toolbarPlacement?: 'overlay' | 'inline';
}

export const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(
  function AnnotationCanvas(
    {
      mode,
      strokes: initialStrokes,
      onConfirm,
      onCancel,
      onDismiss,
      toolbarContainer,
      toolbarPlacement = 'overlay',
    },
    ref
  ) {
    const [strokes, setStrokes] = useState<AnnotationStroke[]>(initialStrokes || []);
    const [activeStroke, setActiveStroke] = useState<AnnotationStroke | null>(null);
    const [color, setColor] = useState<string>(DEFAULT_ANNOTATION_COLOR);
    const [width, setWidth] = useState(DEFAULT_ANNOTATION_WIDTH);
    const [tool, setTool] = useState<AnnotationTool>('freehand');
    void onConfirm;

    useImperativeHandle(ref, () => ({ getStrokes: () => strokes }), [strokes]);

    const createStroke = useCallback(
      (point: AnnotationPoint, strokeColor: string, strokeWidth: number): AnnotationStroke =>
        tool === 'freehand'
          ? { points: [point], color: strokeColor, width: strokeWidth }
          : { points: [point], color: strokeColor, width: strokeWidth, shape: tool },
      [tool]
    );

    const finishStroke = useCallback((stroke: AnnotationStroke) => {
      setStrokes((previous) => [...previous, stroke]);
      setActiveStroke(null);
    }, []);

    const cancelStroke = useCallback(() => setActiveStroke(null), []);

    if (mode === 'view') {
      return (
        <div
          className="absolute inset-0 z-[60] cursor-pointer"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss?.();
          }}
          title="Click to dismiss annotation"
        >
          <AnnotationSurface
            strokes={strokes}
            activeStroke={null}
            enabled={false}
            color={color}
            width={width}
            createStroke={createStroke}
            onStrokeStart={setActiveStroke}
            onStrokeChange={setActiveStroke}
            onStrokeEnd={finishStroke}
            className="w-full h-full pointer-events-none"
          />
        </div>
      );
    }

    const toolbar = (
      <div
        className={
          toolbarPlacement === 'inline'
            ? 'pointer-events-auto flex w-full items-center justify-center flex-wrap gap-x-2 gap-y-2 border-b bg-background px-3 py-2'
            : 'pointer-events-auto absolute top-3 left-1/2 -translate-x-1/2 flex items-center justify-center flex-wrap gap-x-2 gap-y-2 w-[calc(100%-24px)] max-w-fit bg-background/90 backdrop-blur-sm rounded-lg px-3 py-2 shadow-lg border z-[70]'
        }
      >
        <div className="flex items-center gap-1" role="group" aria-label="Drawing tool">
          {ANNOTATION_TOOLS.map(({ tool: option, label, icon: Icon }) => (
            <Button
              key={option}
              type="button"
              variant={tool === option ? 'secondary' : 'ghost'}
              size="icon"
              className="h-7 w-7"
              onClick={() => setTool(option)}
              title={label}
              aria-label={label}
              aria-pressed={tool === option}
            >
              <Icon className="h-4 w-4" />
            </Button>
          ))}
        </div>
        <div className="hidden sm:block w-px h-6 bg-border mx-1" />
        <AnnotationSettings
          color={color}
          width={width}
          onColorChange={setColor}
          onWidthChange={setWidth}
        />
        <div className="hidden sm:block w-px h-6 bg-border mx-1" />
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setStrokes((previous) => previous.slice(0, -1))}
            disabled={strokes.length === 0}
            title="Undo"
            aria-label="Undo"
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:bg-destructive/10"
            onClick={() => setStrokes([])}
            disabled={strokes.length === 0}
            title="Clear all"
            aria-label="Clear all"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
        <div className="hidden sm:block w-px h-6 bg-border mx-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onCancel}
          title="Close annotation tool"
          aria-label="Close annotation tool"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    );

    return (
      <div className="absolute inset-0 z-[60]" onClick={(event) => event.stopPropagation()}>
        <AnnotationSurface
          strokes={strokes}
          activeStroke={activeStroke}
          enabled
          color={color}
          width={width}
          createStroke={createStroke}
          onStrokeStart={setActiveStroke}
          onStrokeChange={setActiveStroke}
          onStrokeEnd={finishStroke}
          onStrokeCancel={cancelStroke}
          className="w-full h-full touch-none cursor-crosshair"
        />
        {toolbarContainer === undefined
          ? toolbar
          : toolbarContainer
            ? createPortal(toolbar, toolbarContainer)
            : null}
      </div>
    );
  }
);
