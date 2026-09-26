'use client';

import { forwardRef, useCallback, useImperativeHandle, useState } from 'react';
import { Trash2, Undo2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DEFAULT_ANNOTATION_COLOR,
  DEFAULT_ANNOTATION_WIDTH,
} from '@/components/annotation/palette';
import { AnnotationSettings } from '@/components/annotation/settings';
import { AnnotationSurface } from '@/components/annotation/surface';
import type { AnnotationPoint, AnnotationStroke } from '@/components/annotation/types';

export type { AnnotationStroke } from '@/components/annotation/types';

export interface AnnotationCanvasHandle {
  getStrokes: () => AnnotationStroke[];
}

interface AnnotationCanvasProps {
  mode: 'draw' | 'view';
  strokes?: AnnotationStroke[];
  onConfirm?: (strokes: AnnotationStroke[]) => void;
  onCancel?: () => void;
  onDismiss?: () => void;
}

export const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(
  function AnnotationCanvas(
    { mode, strokes: initialStrokes, onConfirm, onCancel, onDismiss },
    ref
  ) {
    const [strokes, setStrokes] = useState<AnnotationStroke[]>(initialStrokes || []);
    const [activeStroke, setActiveStroke] = useState<AnnotationStroke | null>(null);
    const [color, setColor] = useState<string>(DEFAULT_ANNOTATION_COLOR);
    const [width, setWidth] = useState(DEFAULT_ANNOTATION_WIDTH);
    void onConfirm;

    useImperativeHandle(ref, () => ({ getStrokes: () => strokes }), [strokes]);

    const createStroke = useCallback(
      (point: AnnotationPoint, strokeColor: string, strokeWidth: number): AnnotationStroke => ({
        points: [point],
        color: strokeColor,
        width: strokeWidth,
      }),
      []
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
        <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center justify-center flex-wrap gap-x-2 gap-y-2 w-[calc(100%-24px)] max-w-fit bg-background/90 backdrop-blur-sm rounded-lg px-3 py-2 shadow-lg border z-[70]">
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
      </div>
    );
  }
);
