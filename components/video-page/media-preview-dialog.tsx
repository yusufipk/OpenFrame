'use client';

import { useRef, useState, type ReactNode } from 'react';
import type { AnnotationCanvasHandle, AnnotationStroke } from '@/components/annotation-canvas';
import { AttachmentImagePreview } from '@/components/video-page/attachment-image-preview';
import { Volume2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { AttachmentCommentsPanel } from '@/components/video-page/attachment-comments-panel';
import {
  attachmentCommentTargetKey,
  type AttachmentCommentTarget,
} from '@/lib/attachment-comment-target';

interface MediaPreviewDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  kind: 'IMAGE' | 'AUDIO' | 'VIDEO';
  src?: string | null;
  children?: ReactNode;
  headerActions?: ReactNode;
  videoId: string;
  target: AttachmentCommentTarget | null;
  guestName?: string | null;
  onCommentsChanged: () => void;
  canDownload?: boolean;
}

export function MediaPreviewDialog({
  open,
  onClose,
  title,
  kind,
  src,
  children,
  headerActions,
  videoId,
  target,
  guestName,
  onCommentsChanged,
  canDownload = false,
}: MediaPreviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex h-[min(96dvh,1000px)] w-[min(96vw,1500px)] max-w-none flex-col overflow-hidden p-0 sm:max-w-none"
        onPointerDownOutside={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>
            {title}
          </span>
          {headerActions}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label="Close preview"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {open && (
          <MediaPreviewBody
            key={`${target ? attachmentCommentTargetKey(target) : ''}:${src ?? ''}`}
            title={title}
            kind={kind}
            src={src}
            videoId={videoId}
            target={target}
            guestName={guestName}
            onCommentsChanged={onCommentsChanged}
            canDownload={canDownload}
          >
            {children}
          </MediaPreviewBody>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MediaPreviewBody({
  title,
  kind,
  src,
  children,
  videoId,
  target,
  guestName,
  onCommentsChanged,
  canDownload,
}: Omit<MediaPreviewDialogProps, 'open' | 'onClose' | 'headerActions'>) {
  const canvasRef = useRef<AnnotationCanvasHandle>(null);
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [viewingAnnotation, setViewingAnnotation] = useState<{
    id: string;
    strokes: AnnotationStroke[];
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div
        className="flex h-[42%] min-h-[180px] min-w-0 flex-none items-center justify-center overflow-hidden bg-black/90 p-3 md:h-auto md:min-h-0 md:flex-1 md:p-4"
        inert={submitting}
      >
        {children ??
          (kind === 'IMAGE' && src ? (
            <AttachmentImagePreview
              src={src}
              title={title}
              isAnnotating={isAnnotating}
              canvasRef={canvasRef}
              viewingAnnotation={viewingAnnotation}
              onCancel={() => setIsAnnotating(false)}
              onDismiss={() => setViewingAnnotation(null)}
            />
          ) : kind === 'AUDIO' && src ? (
            <div className="flex w-full max-w-xl flex-col items-center gap-8 rounded-xl bg-background/10 px-6 py-10 text-white">
              <Volume2 className="h-12 w-12" />
              <p className="max-w-full truncate text-center text-sm">{title}</p>
              <audio
                controls
                controlsList={canDownload ? undefined : 'nodownload'}
                preload="metadata"
                src={src}
                className="w-full"
                aria-label={title}
              />
            </div>
          ) : (
            <p className="text-sm text-white/70">Preview is unavailable.</p>
          ))}
      </div>
      {target && (
        <AttachmentCommentsPanel
          key={attachmentCommentTargetKey(target)}
          videoId={videoId}
          target={target}
          guestName={guestName}
          onCommentsChanged={onCommentsChanged}
          canAnnotate={kind === 'IMAGE' && !!src}
          isAnnotating={isAnnotating}
          onStartAnnotation={() => {
            setViewingAnnotation(null);
            setIsAnnotating(true);
          }}
          getAnnotationStrokes={() => canvasRef.current?.getStrokes() ?? []}
          onAnnotationSaved={() => {
            setIsAnnotating(false);
            setViewingAnnotation(null);
          }}
          onViewAnnotation={(id, strokes) => {
            setIsAnnotating(false);
            setViewingAnnotation({ id, strokes });
          }}
          viewingAnnotationId={viewingAnnotation?.id}
          onCommentDeleted={(id) => {
            if (viewingAnnotation?.id === id) setViewingAnnotation(null);
          }}
          onSubmittingChange={setSubmitting}
        />
      )}
    </div>
  );
}
