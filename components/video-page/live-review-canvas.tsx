'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Pencil, Save, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover } from 'radix-ui';
import { AnnotationSurface, type AnnotationSurfaceHandle } from '@/components/annotation/surface';
import { AnnotationSettings } from '@/components/annotation/settings';
import {
  DEFAULT_ANNOTATION_COLOR,
  DEFAULT_ANNOTATION_WIDTH,
} from '@/components/annotation/palette';
export { pointInContent } from '@/components/annotation/surface';
import type { LiveStroke } from '@/lib/live-review/protocol';
import { LIVE_MAX_STROKE_POINTS } from '@/lib/live-review/protocol';

type Point = LiveStroke['points'][number];
type ContentRect = { left: number; top: number; width: number; height: number };

export interface LiveReviewCanvasProps {
  controlsContainer: HTMLElement | null;
  strokes: LiveStroke[];
  canvasEpoch: number;
  rejectedStroke?: { id: string; sequence: number } | null;
  participantId: string | null;
  canDraw: boolean;
  isPaused: boolean;
  isManager: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  onStroke: (stroke: Omit<LiveStroke, 'participantId'>, canvasEpoch: number) => void;
  onUndo: (canvasEpoch: number) => void;
  onClear: (canvasEpoch: number) => void;
  onSave: (strokes: LiveStroke[], timestamp: number) => Promise<void>;
}

/** Bounds of the image inside an object-fit: contain video element. */
export function getVideoContentRect(
  video: HTMLVideoElement,
  container: HTMLElement
): ContentRect | null {
  const videoBox = video.getBoundingClientRect();
  const containerBox = container.getBoundingClientRect();
  if (!video.videoWidth || !video.videoHeight || !videoBox.width || !videoBox.height) return null;
  const scale = Math.min(videoBox.width / video.videoWidth, videoBox.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  return {
    left: videoBox.left - containerBox.left + (videoBox.width - width) / 2,
    top: videoBox.top - containerBox.top + (videoBox.height - height) / 2,
    width,
    height,
  };
}

const EMIT_INTERVAL_MS = 50;

export function LiveReviewCanvas({
  controlsContainer,
  strokes,
  canvasEpoch,
  rejectedStroke,
  participantId,
  canDraw,
  isPaused,
  isManager,
  videoRef,
  onStroke,
  onUndo,
  onClear,
  onSave,
}: LiveReviewCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<AnnotationSurfaceHandle>(null);
  const [color, setColor] = useState<string>(DEFAULT_ANNOTATION_COLOR);
  const [width, setWidth] = useState(DEFAULT_ANNOTATION_WIDTH);
  const [contentRect, setContentRect] = useState<ContentRect | null>(null);
  const [active, setActive] = useState<LiveStroke | null>(null);
  const activeRef = useRef<LiveStroke | null>(null);
  const [pending, setPending] = useState<LiveStroke[]>([]);
  const [strokeMode, setStrokeMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const lastEmitRef = useRef(0);
  const epochRef = useRef(canvasEpoch);
  const rejectedIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (!container || !video) return;
    const measure = () => setContentRect(getVideoContentRect(video, container));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(video);
    video.addEventListener('loadedmetadata', measure);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      video.removeEventListener('loadedmetadata', measure);
      window.removeEventListener('resize', measure);
    };
  }, [videoRef]);

  useEffect(() => {
    if (epochRef.current !== canvasEpoch) {
      epochRef.current = canvasEpoch;
      rejectedIdsRef.current.clear();
      surfaceRef.current?.cancelActive();
      activeRef.current = null;
      setActive(null);
      setPending([]);
      setSaveError(null);
      setSavedFingerprint(null);
    }
  }, [canvasEpoch]);

  useEffect(() => {
    if (!rejectedStroke) return;
    rejectedIdsRef.current.add(rejectedStroke.id);
    if (activeRef.current?.id === rejectedStroke.id) {
      surfaceRef.current?.cancelActive();
      activeRef.current = null;
      setActive(null);
    }
    setPending((previous) => previous.filter((stroke) => stroke.id !== rejectedStroke.id));
    setSaveError('The latest stroke update was rejected. Check the shared drawing before saving.');
  }, [rejectedStroke]);

  useEffect(() => {
    if (!strokes.length) return;
    const acknowledged = new Set(strokes.map((stroke) => stroke.id));
    setPending((previous) => previous.filter((stroke) => !acknowledged.has(stroke.id)));
  }, [strokes]);

  useEffect(() => {
    if (!canDraw || !isPaused || !strokeMode) {
      surfaceRef.current?.cancelActive();
      activeRef.current = null;
      setActive(null);
    }
  }, [canDraw, isPaused, strokeMode]);

  useEffect(() => {
    if (!controlsContainer) setStrokeMode(false);
  }, [controlsContainer]);

  // Server snapshots acknowledge local strokes by id. Keep only strokes still awaiting an echo.
  const visible = useMemo(() => {
    const acknowledged = new Set(strokes.map((stroke) => stroke.id));
    return [...strokes, ...pending.filter((stroke) => !acknowledged.has(stroke.id))];
  }, [strokes, pending]);
  const ownStrokes = visible.filter((stroke) => stroke.participantId === participantId);
  const fingerprint = ownStrokes.map((stroke) => `${stroke.id}:${stroke.points.length}`).join('|');
  const alreadySaved = fingerprint.length > 0 && savedFingerprint === fingerprint;
  const editable = canDraw && isPaused && !!participantId && !!contentRect;
  const drawable = editable && strokeMode && !!controlsContainer;

  const emit = useCallback(
    (stroke: LiveStroke) => {
      onStroke(
        { id: stroke.id, points: stroke.points, color: stroke.color, width: stroke.width },
        epochRef.current
      );
      lastEmitRef.current = performance.now();
    },
    [onStroke]
  );

  const createStroke = (point: Point, strokeColor: string, strokeWidth: number): LiveStroke => ({
    id: crypto.randomUUID(),
    participantId: participantId!,
    points: [point],
    color: strokeColor,
    width: strokeWidth,
  });
  const start = (stroke: LiveStroke) => {
    activeRef.current = stroke;
    setActive(stroke);
    lastEmitRef.current = 0;
  };
  const move = (stroke: LiveStroke) => {
    if (!drawable || rejectedIdsRef.current.has(stroke.id)) return;
    activeRef.current = stroke;
    setActive(stroke);
    if (performance.now() - lastEmitRef.current >= EMIT_INTERVAL_MS) emit(stroke);
  };
  const finish = (stroke: LiveStroke) => {
    activeRef.current = null;
    setActive(null);
    if (!drawable || rejectedIdsRef.current.has(stroke.id)) return;
    setPending((previous) => [...previous, stroke]);
    emit(stroke);
  };

  const undo = () => {
    if (!editable || !ownStrokes.length) return;
    const lastId = ownStrokes[ownStrokes.length - 1].id;
    setPending((previous) => previous.filter((stroke) => stroke.id !== lastId));
    onUndo(canvasEpoch);
  };

  const save = async () => {
    if (!editable || !ownStrokes.length || !videoRef.current || saving || alreadySaved) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(ownStrokes, videoRef.current.currentTime);
      setSavedFingerprint(fingerprint);
    } catch {
      setSaveError('Could not save the drawing. Your live strokes are still here.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-30 pointer-events-none"
      aria-label="Live review drawing"
    >
      {contentRect && (
        <AnnotationSurface<LiveStroke>
          ref={surfaceRef}
          strokes={active ? visible.filter((stroke) => stroke.id !== active.id) : visible}
          activeStroke={active}
          enabled={drawable}
          color={color}
          width={width}
          maxPoints={LIVE_MAX_STROKE_POINTS}
          createStroke={createStroke}
          onStrokeStart={start}
          onStrokeChange={move}
          onStrokeEnd={finish}
          onStrokeCancel={() => {
            activeRef.current = null;
            setActive(null);
          }}
          ariaLabel="Shared drawing canvas"
          className={
            drawable
              ? 'absolute touch-none cursor-crosshair pointer-events-auto'
              : 'absolute pointer-events-none'
          }
          style={{
            left: contentRect.left,
            top: contentRect.top,
            width: contentRect.width,
            height: contentRect.height,
          }}
          onClick={(event) => event.stopPropagation()}
        />
      )}
      {controlsContainer &&
        createPortal(
          <div
            className="flex flex-wrap items-center gap-0.5"
            onClick={(event) => event.stopPropagation()}
          >
            <Button
              size="sm"
              variant={strokeMode ? 'secondary' : 'ghost'}
              className="h-7 gap-1 px-1.5 text-xs"
              aria-pressed={strokeMode}
              disabled={!editable}
              onClick={() => setStrokeMode((previous) => !previous)}
              title={isPaused ? 'Draw on the shared frame' : 'Pause playback to draw'}
            >
              <Pencil className="h-3.5 w-3.5" />
              Stroke Mode
            </Button>
            <Popover.Root>
              <Popover.Trigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-6"
                  disabled={!editable}
                  aria-label="Drawing options"
                  title="Drawing options"
                >
                  <ChevronDown className="h-3.5 w-3.5" style={{ color }} />
                </Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  side="top"
                  align="end"
                  sideOffset={6}
                  aria-label="Drawing options"
                  className="z-[80] max-w-[calc(100vw-24px)] w-64 border bg-popover text-popover-foreground p-3 shadow-md"
                  onClick={(event) => event.stopPropagation()}
                >
                  <AnnotationSettings
                    color={color}
                    width={width}
                    onColorChange={setColor}
                    onWidthChange={setWidth}
                  />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-6"
              aria-label="Undo my stroke"
              title="Undo my stroke"
              disabled={!editable || !ownStrokes.length}
              onClick={undo}
            >
              <Undo2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-6"
              aria-label={alreadySaved ? 'Saved as comment' : 'Save drawing as comment'}
              title={
                alreadySaved
                  ? 'Saved as comment'
                  : 'Save drawing as comment. Unsaved drawings clear when playback moves or the room ends.'
              }
              disabled={!editable || !ownStrokes.length || saving || alreadySaved}
              onClick={save}
            >
              {alreadySaved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            </Button>
            {isManager && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-6"
                aria-label="Clear drawings"
                title="Clear drawings"
                disabled={!isPaused || !visible.length}
                onClick={() => onClear(canvasEpoch)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {saveError && (
              <span role="alert" className="w-full text-xs text-destructive">
                {saveError}
              </span>
            )}
          </div>,
          controlsContainer
        )}
    </div>
  );
}
