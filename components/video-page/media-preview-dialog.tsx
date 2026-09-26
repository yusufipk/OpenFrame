'use client';

import { useRef, useState, type ReactNode } from 'react';
import type { AnnotationCanvasHandle, AnnotationStroke } from '@/components/annotation-canvas';
import { AttachmentImagePreview } from '@/components/video-page/attachment-image-preview';
import { NativePreviewPlayer } from '@/components/video-page/native-preview-player';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { AttachmentCommentsPanel } from '@/components/video-page/attachment-comments-panel';
import {
  attachmentCommentTargetKey,
  type AttachmentCommentTarget,
} from '@/lib/attachment-comment-target';

export interface AttachmentPlayback {
  currentTime: number | null;
  getCurrentTime: () => number | null;
  pause: () => void;
  seekTo: (seconds: number) => void;
}

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
  playback?: AttachmentPlayback;
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
  playback,
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
            playback={playback}
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
  playback,
}: Omit<MediaPreviewDialogProps, 'open' | 'onClose' | 'headerActions' | 'canDownload'>) {
  const canvasRef = useRef<AnnotationCanvasHandle>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const [nativeTime, setNativeTime] = useState<number | null>(null);
  const nativeMedia = () => mediaRef.current?.querySelector<HTMLMediaElement>('audio,video');
  const getTime = () => {
    if (playback) return playback.getCurrentTime();
    const media = nativeMedia();
    return media && media.readyState > 0 && Number.isFinite(media.currentTime)
      ? media.currentTime
      : null;
  };
  const pause = () => {
    if (playback) playback.pause();
    else nativeMedia()?.pause();
  };
  const seekTo = (seconds: number) => {
    if (playback) {
      playback.pause();
      playback.seekTo(seconds);
      return;
    }
    const media = nativeMedia();
    if (!media || media.readyState === 0) return;
    media.pause();
    media.currentTime = Math.max(
      0,
      Math.min(seconds, Number.isFinite(media.duration) ? media.duration : seconds)
    );
    setNativeTime(media.currentTime);
  };
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [viewingAnnotation, setViewingAnnotation] = useState<{
    id: string;
    strokes: AnnotationStroke[];
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
      <div
        className="flex h-[42%] min-h-[180px] min-w-0 flex-none items-center justify-center overflow-hidden bg-black md:h-auto md:min-h-0 md:flex-1"
        inert={submitting}
        ref={mediaRef}
        onLoadedMetadataCapture={() => setNativeTime(getTime())}
        onTimeUpdateCapture={() => setNativeTime(getTime())}
        onSeekedCapture={() => setNativeTime(getTime())}
        onEmptiedCapture={() => setNativeTime(null)}
      >
        {children ??
          (kind === 'IMAGE' && src ? (
            <div className="h-full w-full p-3 md:p-4">
              <AttachmentImagePreview
                src={src}
                title={title}
                isAnnotating={isAnnotating}
                canvasRef={canvasRef}
                viewingAnnotation={viewingAnnotation}
                onCancel={() => setIsAnnotating(false)}
                onDismiss={() => setViewingAnnotation(null)}
              />
            </div>
          ) : (kind === 'AUDIO' || kind === 'VIDEO') && src ? (
            <NativePreviewPlayer src={src} title={title} kind={kind} />
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
          timedMedia={kind === 'AUDIO' || kind === 'VIDEO'}
          playbackTime={playback ? playback.currentTime : nativeTime}
          getPlaybackTime={getTime}
          onPausePlayback={pause}
          onSeekTimestamp={seekTo}
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
