'use client';

import { memo, type RefObject } from 'react';
import {
  AlertCircle,
  Clock,
  Gauge,
  Maximize,
  MessageSquare,
  MessageSquareOff,
  Minimize,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  AnnotationCanvas,
  type AnnotationCanvasHandle,
  type AnnotationStroke,
} from '@/components/annotation-canvas';
import type { BunnyQualityOption, CommentMarker } from '@/components/video-page/types';

interface PlayerCoreProps {
  activeVersionId: string | null;
  activeProviderId: string | undefined;
  embedUrl: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  bunnyViewportRef: RefObject<HTMLDivElement | null>;
  timelineRef: RefObject<HTMLDivElement | null>;
  videoContainerRef: RefObject<HTMLDivElement | null>;
  isFullscreenMode: boolean;
  cursorIdle: boolean;
  isPlaying: boolean;
  handlePlayPause: () => void;
  handleVideoMouseMove: () => void;
  handleVideoMouseLeave: () => void;
  isBunnyPortraitSource: boolean;
  bunnyPortraitFrameWidth: number;
  showBunnyProcessingOverlay: boolean;
  showBunnyErrorOverlay: boolean;
  showResumePrompt: boolean;
  savedProgress: number | null;
  formatTime: (value: number) => string;
  handleResumeFromSaved: () => void;
  handleDismissResume: () => void;
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
  currentTime: number;
  duration: number;
  handleSkip: (seconds: number) => void;
  handleMuteToggle: () => void;
  isMuted: boolean;
  selectedQualityLabel: string;
  selectedQualityLevel: number;
  qualityOptions: BunnyQualityOption[];
  handleQualityChange: (level: number) => void;
  playbackSpeed: number;
  speedOptions: number[];
  handleSpeedChange: (speed: number) => void;
  toggleFullscreen: () => void;
  showComments: boolean;
  setShowComments: (value: boolean) => void;
  setIsMobileCommentsOpen: (value: boolean) => void;
  handleTimelineMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  handleTimelineMouseMove: (e: React.MouseEvent<HTMLDivElement>) => void;
  handleSeekToTimestamp: (timestamp: number, annotation?: string | null) => void;
  commentMarkers: CommentMarker[];
}

export const PlayerCore = memo(function PlayerCore({
  activeVersionId,
  activeProviderId,
  embedUrl,
  videoRef,
  iframeRef,
  bunnyViewportRef,
  timelineRef,
  videoContainerRef,
  isFullscreenMode,
  cursorIdle,
  isPlaying,
  handlePlayPause,
  handleVideoMouseMove,
  handleVideoMouseLeave,
  isBunnyPortraitSource,
  bunnyPortraitFrameWidth,
  showBunnyProcessingOverlay,
  showBunnyErrorOverlay,
  showResumePrompt,
  savedProgress,
  formatTime,
  handleResumeFromSaved,
  handleDismissResume,
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
  currentTime,
  duration,
  handleSkip,
  handleMuteToggle,
  isMuted,
  selectedQualityLabel,
  selectedQualityLevel,
  qualityOptions,
  handleQualityChange,
  playbackSpeed,
  speedOptions,
  handleSpeedChange,
  toggleFullscreen,
  showComments,
  setShowComments,
  setIsMobileCommentsOpen,
  handleTimelineMouseDown,
  handleTimelineMouseMove,
  handleSeekToTimestamp,
  commentMarkers,
}: PlayerCoreProps) {
  return (
    <>
      <div
        ref={videoContainerRef}
        className={cn(
          'flex-1 bg-black flex items-center justify-center relative cursor-pointer group min-h-0',
          isFullscreenMode && 'absolute inset-0',
          cursorIdle && isPlaying && 'cursor-none'
        )}
        onClick={handlePlayPause}
        onMouseMove={handleVideoMouseMove}
        onMouseLeave={handleVideoMouseLeave}
      >
        <div className={cn('relative w-full h-full', isFullscreenMode && 'absolute inset-0')}>
          {activeProviderId === 'bunny' ? (
            <div
              ref={bunnyViewportRef}
              className="absolute inset-0 flex items-center justify-center bg-black"
            >
              <div
                className={cn(
                  'relative flex items-center justify-center bg-black',
                  isBunnyPortraitSource ? 'h-full overflow-hidden' : 'w-full h-full'
                )}
                style={
                  isBunnyPortraitSource && bunnyPortraitFrameWidth > 0
                    ? { width: `${bunnyPortraitFrameWidth}px` }
                    : undefined
                }
              >
                <video
                  key={activeVersionId}
                  ref={videoRef}
                  className="w-full h-full object-contain border-0 bg-black"
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    objectPosition: 'center',
                    backgroundColor: 'black',
                  }}
                  preload="metadata"
                  playsInline
                />
              </div>
            </div>
          ) : (
            <iframe
              key={activeVersionId}
              ref={iframeRef}
              src={embedUrl}
              width="100%"
              height="100%"
              className="absolute inset-0 w-full h-full border-0"
              referrerPolicy="origin-when-cross-origin"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          )}

          <div
            className={cn(
              'absolute inset-0 flex items-center justify-center bg-black/20 transition-opacity duration-300',
              (showBunnyProcessingOverlay || showBunnyErrorOverlay) &&
                'opacity-0 pointer-events-none',
              isPlaying
                ? cursorIdle
                  ? 'opacity-0'
                  : 'opacity-0 group-hover:opacity-100'
                : 'opacity-100'
            )}
          >
            <div className="w-16 h-16 rounded-full bg-black/60 flex items-center justify-center relative z-10">
              {isPlaying ? (
                <Pause className="h-8 w-8 text-white relative right-[-1px]" />
              ) : (
                <Play className="h-8 w-8 text-white relative left-[2px]" />
              )}
            </div>
          </div>

          {showBunnyProcessingOverlay && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65">
              <div className="max-w-sm rounded-md border bg-background/95 px-4 py-3 text-center shadow-lg">
                <div className="mb-2 flex items-center justify-center gap-2 text-sm font-medium">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Video Is Processing
                </div>
                <p className="text-xs text-muted-foreground">
                  This video is still processing. We&apos;ll keep retrying every few seconds.
                </p>
              </div>
            </div>
          )}

          {showBunnyErrorOverlay && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65">
              <div className="max-w-sm rounded-md border bg-background/95 px-4 py-3 text-center shadow-lg">
                <div className="mb-2 flex items-center justify-center gap-2 text-sm font-medium">
                  <AlertCircle className="h-4 w-4 text-destructive" />
                  Unable To Load Video
                </div>
                <p className="text-xs text-muted-foreground">
                  The Bunny stream is unavailable right now. Please refresh this page in a moment.
                </p>
              </div>
            </div>
          )}

          {showResumePrompt && savedProgress !== null && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-10">
              <div className="bg-background/95 backdrop-blur-sm rounded-lg p-4 shadow-lg max-w-sm mx-4">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                    <Clock className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">Continue watching?</p>
                    <p className="text-xs text-muted-foreground">
                      Resume from {formatTime(savedProgress)}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="default"
                    onClick={handleResumeFromSaved}
                    className="flex-1"
                  >
                    <Play className="h-4 w-4 mr-1" />
                    Resume
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleDismissResume}
                    className="flex-1"
                  >
                    Start over
                  </Button>
                </div>
              </div>
            </div>
          )}

          {isAnnotating && (
            <AnnotationCanvas
              ref={annotationCanvasRef}
              mode="draw"
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
              strokes={editAnnotationInitialStrokes}
              onConfirm={(strokes) => {
                setEditAnnotationData(JSON.stringify(strokes));
                setIsEditingAnnotation(false);
              }}
              onCancel={() => {
                setIsEditingAnnotation(false);
              }}
            />
          )}
        </div>
      </div>

      <div
        className={cn(
          'shrink-0 px-4 py-2 bg-background border-t',
          isFullscreenMode
            ? 'absolute bottom-0 left-0 right-0 z-50 transition-opacity duration-300'
            : '',
          isFullscreenMode && cursorIdle && isPlaying && 'opacity-0 pointer-events-none'
        )}
      >
        <div className="flex items-center gap-1 mb-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handlePlayPause}>
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => handleSkip(-10)}
            title="Back 10s"
          >
            <SkipBack className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => handleSkip(10)}
            title="Forward 10s"
          >
            <SkipForward className="h-4 w-4" />
          </Button>

          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleMuteToggle}>
            {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>

          <span className="text-xs text-muted-foreground ml-1 tabular-nums">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <div className="ml-auto flex items-center">
            {activeProviderId === 'bunny' && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs">
                    Quality {selectedQualityLabel}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[120px]">
                  <DropdownMenuItem
                    onClick={() => handleQualityChange(-1)}
                    className={cn(selectedQualityLevel === -1 && 'font-bold text-primary')}
                  >
                    Auto
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleQualityChange(-2)}
                    className={cn(selectedQualityLevel === -2 && 'font-bold text-primary')}
                  >
                    Original
                  </DropdownMenuItem>
                  {qualityOptions.length > 0 && <DropdownMenuSeparator />}
                  {qualityOptions.map((option) => (
                    <DropdownMenuItem
                      key={option.level}
                      onClick={() => handleQualityChange(option.level)}
                      className={cn(
                        option.level === selectedQualityLevel && 'font-bold text-primary'
                      )}
                    >
                      {option.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs">
                  <Gauge className="h-3.5 w-3.5" />
                  {playbackSpeed === 1 ? '1x' : `${playbackSpeed}x`}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[80px]">
                {speedOptions.map((speed) => (
                  <DropdownMenuItem
                    key={speed}
                    onClick={() => handleSpeedChange(speed)}
                    className={cn(speed === playbackSpeed && 'font-bold text-primary')}
                  >
                    {speed}x
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={toggleFullscreen}
              title={isFullscreenMode ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
            >
              {isFullscreenMode ? (
                <Minimize className="h-4 w-4" />
              ) : (
                <Maximize className="h-4 w-4" />
              )}
            </Button>

            {isFullscreenMode ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setShowComments(!showComments)}
                title={showComments ? 'Hide comments' : 'Show comments'}
              >
                {showComments ? (
                  <MessageSquareOff className="h-4 w-4" />
                ) : (
                  <MessageSquare className="h-4 w-4" />
                )}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 lg:hidden"
                onClick={() => setIsMobileCommentsOpen(true)}
                title="Show comments"
              >
                <MessageSquare className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        <div
          ref={timelineRef}
          className="relative h-8 bg-muted rounded cursor-pointer select-none"
          onMouseDown={handleTimelineMouseDown}
          onMouseMove={handleTimelineMouseMove}
        >
          <div
            className="absolute left-0 top-0 h-full bg-primary/30 rounded pointer-events-none"
            style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
          />

          <div
            className="absolute top-0 h-full w-1 bg-primary rounded pointer-events-none"
            style={{ left: `calc(${duration > 0 ? (currentTime / duration) * 100 : 0}% - 2px)` }}
          />

          {commentMarkers.map((comment) => (
            <button
              key={comment.id}
              onClick={(e) => {
                e.stopPropagation();
                handleSeekToTimestamp(comment.timestamp, comment.annotationData);
              }}
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full transition-transform hover:scale-150 z-10"
              style={{
                left: `calc(${duration > 0 ? (comment.timestamp / duration) * 100 : 0}% - 6px)`,
                backgroundColor: comment.color,
              }}
              title={`${formatTime(comment.timestamp)}${comment.preview}`}
            />
          ))}
        </div>
      </div>
    </>
  );
});
