'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AnnotationCanvas,
  type AnnotationCanvasHandle,
  type AnnotationStroke,
} from '@/components/annotation-canvas';

interface VideoAnnotationState {
  isAnnotating: boolean;
  setCanvas: (handle: AnnotationCanvasHandle | null) => void;
  viewingAnnotation: { id: string; strokes: AnnotationStroke[] } | null;
  onCancel: () => void;
  onDismiss: () => void;
}

export const AttachmentVideoAnnotationContext = createContext<VideoAnnotationState | null>(null);

export function AttachmentVideoFrame({
  children,
  className,
  onClick,
  embedded = false,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  embedded?: boolean;
}) {
  const annotation = useContext(AttachmentVideoAnnotationContext);
  const rootRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const video = root.querySelector('video');
      // A fixed embed aspect ratio keeps normalized drawings aligned through resizing.
      const width = embedded ? 16 : (video?.videoWidth ?? 0);
      const height = embedded ? 9 : (video?.videoHeight ?? 0);
      if (!width || !height) {
        setFrame({ width: 0, height: 0 });
        return;
      }
      const scale = Math.min(root.clientWidth / width, root.clientHeight / height);
      setFrame({ width: width * scale, height: height * scale });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    root.addEventListener('loadedmetadata', measure, true);
    root.addEventListener('resize', measure, true);
    return () => {
      observer.disconnect();
      root.removeEventListener('loadedmetadata', measure, true);
      root.removeEventListener('resize', measure, true);
    };
  }, [embedded]);

  const frameStyle = { width: frame.width, height: frame.height };
  return (
    <div
      ref={rootRef}
      className={className}
      onClick={annotation?.isAnnotating ? undefined : onClick}
    >
      {embedded ? (
        <div className="relative shrink-0" style={frameStyle} inert={annotation?.isAnnotating}>
          {children}
        </div>
      ) : (
        children
      )}
      {annotation &&
        frame.width > 0 &&
        frame.height > 0 &&
        (annotation.isAnnotating || annotation.viewingAnnotation) && (
          <div
            className="absolute left-1/2 top-1/2 z-[60] -translate-x-1/2 -translate-y-1/2"
            style={frameStyle}
            onClick={(event) => event.stopPropagation()}
          >
            {annotation.isAnnotating ? (
              <AnnotationCanvas
                ref={(handle) => annotation.setCanvas(handle)}
                mode="draw"
                toolbarContainer={toolbar}
                onCancel={annotation.onCancel}
              />
            ) : (
              annotation.viewingAnnotation && (
                <AnnotationCanvas
                  key={annotation.viewingAnnotation.id}
                  mode="view"
                  strokes={annotation.viewingAnnotation.strokes}
                  onDismiss={annotation.onDismiss}
                />
              )
            )}
          </div>
        )}
      <div
        ref={setToolbar}
        className="pointer-events-none absolute inset-0 z-[80]"
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}
