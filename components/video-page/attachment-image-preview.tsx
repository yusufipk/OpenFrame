'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  AnnotationCanvas,
  type AnnotationCanvasHandle,
  type AnnotationStroke,
} from '@/components/annotation-canvas';

interface AttachmentImagePreviewProps {
  src: string;
  title: string;
  isAnnotating: boolean;
  canvasRef: RefObject<AnnotationCanvasHandle | null>;
  viewingAnnotation: { id: string; strokes: AnnotationStroke[] } | null;
  onCancel: () => void;
  onDismiss: () => void;
}

export function AttachmentImagePreview({
  src,
  title,
  isAnnotating,
  canvasRef,
  viewingAnnotation,
  onCancel,
  onDismiss,
}: AttachmentImagePreviewProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [image, setImage] = useState({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale =
    image.width && image.height
      ? Math.min(1, viewport.width / image.width, viewport.height / image.height)
      : 0;

  return (
    <div
      ref={viewportRef}
      className="relative flex h-full w-full min-h-0 items-center justify-center"
    >
      {failed ? (
        <p role="alert" className="text-sm text-white/70">
          Unable to load image
        </p>
      ) : (
        <div
          className="relative shrink-0"
          style={{ width: image.width * scale, height: image.height * scale }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={title}
            draggable={false}
            className="block h-full w-full select-none"
            onLoad={(event) =>
              setImage({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setFailed(true)}
          />
          {scale > 0 && isAnnotating && (
            <AnnotationCanvas
              ref={canvasRef}
              mode="draw"
              toolbarContainer={toolbar}
              onCancel={onCancel}
            />
          )}
          {scale > 0 && !isAnnotating && viewingAnnotation && (
            <AnnotationCanvas
              key={viewingAnnotation.id}
              mode="view"
              strokes={viewingAnnotation.strokes}
              onDismiss={onDismiss}
            />
          )}
        </div>
      )}
      <div ref={setToolbar} className="pointer-events-none absolute inset-0 z-[80]" />
    </div>
  );
}
