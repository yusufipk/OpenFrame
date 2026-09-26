'use client';

import { useRef, useState, type RefObject } from 'react';
import { AlertCircle, Loader2, Play, Pause, Volume2 } from 'lucide-react';
import {
  enterPreviewFullscreen,
  PreviewPlayerControls,
} from '@/components/video-page/preview-player-controls';

interface NativePreviewPlayerProps {
  src: string;
  title: string;
  kind: 'AUDIO' | 'VIDEO';
}

export function NativePreviewPlayer({ src, title, kind }: NativePreviewPlayerProps) {
  const mediaRef = useRef<HTMLMediaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  const togglePlayPause = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) {
      void media.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setHasError(true);
      });
    } else media.pause();
  };
  const seekTo = (seconds: number) => {
    const media = mediaRef.current;
    if (!media || !Number.isFinite(media.duration)) return;
    media.currentTime = Math.max(0, Math.min(seconds, media.duration));
    setCurrentTime(media.currentTime);
  };
  const toggleMute = () => {
    const media = mediaRef.current;
    if (!media) return;
    media.muted = !media.muted;
    setIsMuted(media.muted);
  };
  const changeSpeed = (speed: number) => {
    const media = mediaRef.current;
    if (!media) return;
    media.playbackRate = speed;
    setPlaybackSpeed(speed);
  };
  const onLoadedMetadata = (media: HTMLMediaElement) => {
    setIsReady(true);
    setHasError(false);
    setDuration(media.duration);
  };

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-black"
    >
      <div
        className="group relative flex min-h-0 flex-1 items-center justify-center bg-black"
        onClick={kind === 'VIDEO' ? togglePlayPause : undefined}
      >
        {kind === 'VIDEO' ? (
          <video
            ref={mediaRef as RefObject<HTMLVideoElement>}
            className="h-full w-full object-contain"
            src={src}
            playsInline
            preload="metadata"
            aria-label={title}
            onLoadedMetadata={(event) => onLoadedMetadata(event.currentTarget)}
            onDurationChange={(event) => setDuration(event.currentTarget.duration)}
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
            onVolumeChange={(event) => setIsMuted(event.currentTarget.muted)}
            onError={() => setHasError(true)}
          />
        ) : (
          <>
            <div className="flex max-w-full flex-col items-center gap-5 px-4 text-white">
              <Volume2 className="h-12 w-12" />
              <p className="max-w-full truncate text-center text-sm">{title}</p>
            </div>
            <audio
              ref={mediaRef as RefObject<HTMLAudioElement>}
              src={src}
              preload="metadata"
              aria-label={title}
              onLoadedMetadata={(event) => onLoadedMetadata(event.currentTarget)}
              onDurationChange={(event) => setDuration(event.currentTarget.duration)}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
              onVolumeChange={(event) => setIsMuted(event.currentTarget.muted)}
              onError={() => setHasError(true)}
            />
          </>
        )}
        {kind === 'VIDEO' && isReady && !hasError && (
          <div
            className={`pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20 transition-opacity ${isPlaying ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}
          >
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-black/60">
              {isPlaying ? (
                <Pause className="h-8 w-8 text-white" />
              ) : (
                <Play className="ml-1 h-8 w-8 text-white" />
              )}
            </div>
          </div>
        )}
        {hasError ? (
          <div
            role="alert"
            className="absolute inset-0 flex items-center justify-center gap-2 bg-black/65 px-4 text-center text-sm text-white"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            Unable to load preview.
          </div>
        ) : !isReady ? (
          <div
            role="status"
            className="absolute inset-0 flex items-center justify-center gap-2 bg-black/65 text-sm text-white"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading preview...
          </div>
        ) : null}
      </div>
      <PreviewPlayerControls
        isPlaying={isPlaying}
        isMuted={isMuted}
        currentTime={currentTime}
        duration={duration}
        playbackSpeed={playbackSpeed}
        onPlayPause={togglePlayPause}
        onSkip={(seconds) => seekTo((mediaRef.current?.currentTime ?? 0) + seconds)}
        onMute={toggleMute}
        onSeek={seekTo}
        onSpeedChange={changeSpeed}
        onFullscreen={
          kind === 'VIDEO'
            ? () =>
                enterPreviewFullscreen(
                  containerRef.current,
                  mediaRef.current as HTMLVideoElement | null
                )
            : undefined
        }
        disabled={!isReady || hasError}
      />
    </div>
  );
}
