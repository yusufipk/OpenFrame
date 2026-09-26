'use client';

import { memo, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Maximize, MessageSquare, MessageSquareOff, Minimize, ZoomIn, ZoomOut } from 'lucide-react';
import {
  AnnotationCanvas,
  type AnnotationCanvasHandle,
  type AnnotationStroke,
} from '@/components/annotation-canvas';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ImageReviewPlayerProps {
  versionId: string;
  src: string;
  title: string;
  isFullscreenMode: boolean;
  toggleFullscreen: () => void;
  showComments: boolean;
  setShowComments: (value: boolean) => void;
  setIsMobileCommentsOpen: (value: boolean) => void;
  isAnnotating: boolean;
  annotationCanvasRef: RefObject<AnnotationCanvasHandle | null>;
  setAnnotationStrokes: (strokes: AnnotationStroke[] | null) => void;
  setIsAnnotating: (value: boolean) => void;
  setViewingAnnotation: (strokes: AnnotationStroke[] | null) => void;
  viewingAnnotation: AnnotationStroke[] | null;
  isEditingAnnotation: boolean;
  editAnnotationCanvasRef: RefObject<AnnotationCanvasHandle | null>;
  editAnnotationInitialStrokes?: AnnotationStroke[];
  setEditAnnotationData: (value: string | null | undefined) => void;
  setIsEditingAnnotation: (value: boolean) => void;
}

export const ImageReviewPlayer = memo(function ImageReviewPlayer({
  versionId,
  src,
  title,
  isFullscreenMode,
  toggleFullscreen,
  showComments,
  setShowComments,
  setIsMobileCommentsOpen,
  isAnnotating,
  annotationCanvasRef,
  setAnnotationStrokes,
  setIsAnnotating,
  setViewingAnnotation,
  viewingAnnotation,
  isEditingAnnotation,
  editAnnotationCanvasRef,
  editAnnotationInitialStrokes,
  setEditAnnotationData,
  setIsEditingAnnotation,
}: ImageReviewPlayerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const draggedRef = useRef(false);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [loadError, setLoadError] = useState(false);
  const [annotationToolbarContainer, setAnnotationToolbarContainer] =
    useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () =>
      setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const fitScale =
    imageSize.width > 0 && imageSize.height > 0 && viewportSize.width > 0 && viewportSize.height > 0
      ? Math.min(1, viewportSize.width / imageSize.width, viewportSize.height / imageSize.height)
      : 1;
  const scale = zoom === 'fit' ? fitScale : zoom;
  const stageWidth = imageSize.width * fitScale;
  const stageHeight = imageSize.height * fitScale;
  const stageZoom = fitScale > 0 ? scale / fitScale : 1;

  const setZoomAndCenter = useCallback((next: 'fit' | number) => {
    setZoom(next);
    setPan({ x: 0, y: 0 });
  }, []);

  const changeZoom = useCallback(
    (direction: -1 | 1) => {
      const current = zoom === 'fit' ? fitScale : zoom;
      const steps = [fitScale, 0.5, 1, 2, 4]
        .filter((value, index, all) => value >= fitScale && all.indexOf(value) === index)
        .sort((a, b) => a - b);
      const next =
        direction > 0
          ? (steps.find((value) => value > current + 0.001) ?? steps[steps.length - 1])
          : ([...steps].reverse().find((value) => value < current - 0.001) ?? steps[0]);
      setZoomAndCenter(next === fitScale ? 'fit' : next);
    },
    [fitScale, setZoomAndCenter, zoom]
  );

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    if (
      Math.abs(event.clientX - dragRef.current.x) + Math.abs(event.clientY - dragRef.current.y) >
      3
    ) {
      draggedRef.current = true;
    }
    setPan({
      x: dragRef.current.offsetX + event.clientX - dragRef.current.x,
      y: dragRef.current.offsetY + event.clientY - dragRef.current.y,
    });
  };

  const stopDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <>
      <div
        ref={viewportRef}
        className={cn(
          'relative flex-1 min-h-0 overflow-hidden bg-black touch-none',
          isFullscreenMode && 'absolute inset-0'
        )}
        data-testid="image-review-viewport"
        onClickCapture={(event) => {
          if (!draggedRef.current) return;
          draggedRef.current = false;
          event.stopPropagation();
        }}
        onPointerDown={(event) => {
          if (isAnnotating || isEditingAnnotation || scale <= fitScale || event.button !== 0)
            return;
          if ((event.target as HTMLElement).closest('button')) return;
          draggedRef.current = false;
          dragRef.current = { x: event.clientX, y: event.clientY, offsetX: pan.x, offsetY: pan.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        {loadError ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white">
            Unable to load image
          </div>
        ) : (
          <div
            className="absolute left-1/2 top-1/2 origin-center"
            style={{
              width: stageWidth || undefined,
              height: stageHeight || undefined,
              transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${stageZoom})`,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={versionId}
              src={src}
              alt={title}
              draggable={false}
              className="block h-full w-full select-none"
              onLoad={(event) => {
                setImageSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
                setLoadError(false);
              }}
              onError={() => setLoadError(true)}
            />
            {isAnnotating && (
              <AnnotationCanvas
                ref={annotationCanvasRef}
                mode="draw"
                toolbarContainer={annotationToolbarContainer}
                onConfirm={(strokes) => {
                  setAnnotationStrokes(strokes);
                  setIsAnnotating(false);
                }}
                onCancel={() => {
                  setIsAnnotating(false);
                  setAnnotationStrokes(null);
                }}
              />
            )}
            {viewingAnnotation && !isAnnotating && !isEditingAnnotation && (
              <AnnotationCanvas
                mode="view"
                strokes={viewingAnnotation}
                onDismiss={() => setViewingAnnotation(null)}
              />
            )}
            {isEditingAnnotation && (
              <AnnotationCanvas
                ref={editAnnotationCanvasRef}
                mode="draw"
                toolbarContainer={annotationToolbarContainer}
                strokes={editAnnotationInitialStrokes}
                onConfirm={(strokes) => {
                  setEditAnnotationData(JSON.stringify(strokes));
                  setIsEditingAnnotation(false);
                }}
                onCancel={() => setIsEditingAnnotation(false)}
              />
            )}
          </div>
        )}
        <div
          ref={setAnnotationToolbarContainer}
          data-testid="image-annotation-toolbar-layer"
          className="pointer-events-none absolute inset-0 z-[80]"
        />
      </div>
      <div
        className={cn(
          'shrink-0 flex items-center gap-1 border-t bg-background px-4 py-2',
          isFullscreenMode && 'absolute bottom-0 left-0 right-0 z-50'
        )}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setZoomAndCenter('fit')}
          aria-label="Fit image"
        >
          Fit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setZoomAndCenter(1)}
          aria-label="Show image at 100%"
        >
          100%
        </Button>
        <Button variant="ghost" size="icon" onClick={() => changeZoom(-1)} aria-label="Zoom out">
          <ZoomOut className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => changeZoom(1)} aria-label="Zoom in">
          <ZoomIn className="h-4 w-4" />
        </Button>
        <span className="ml-1 text-xs tabular-nums text-muted-foreground">
          {Math.round(scale * 100)}%
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleFullscreen}
            title={isFullscreenMode ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreenMode ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setShowComments(!showComments);
              setIsMobileCommentsOpen(!showComments);
            }}
            title={showComments ? 'Hide comments' : 'Show comments'}
          >
            {showComments ? (
              <MessageSquareOff className="h-4 w-4" />
            ) : (
              <MessageSquare className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </>
  );
});
