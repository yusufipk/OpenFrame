'use client';

import { useEffect, useState } from 'react';
import {
  Gauge,
  Minimize,
  Maximize,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  NATIVE_SPEED_OPTIONS,
  SILENT_ABOVE_SPEED,
} from '@/components/video-page/hooks/video-player-utils';
import type { BunnyQualityOption } from '@/components/video-page/types';
import { cn } from '@/lib/utils';

interface PreviewPlayerControlsProps {
  isPlaying: boolean;
  isMuted: boolean;
  currentTime: number;
  duration: number;
  playbackSpeed: number;
  onPlayPause: () => void;
  onSkip: (seconds: number) => void;
  onMute: () => void;
  onSeek: (seconds: number) => void;
  onSpeedChange: (speed: number) => void;
  onFullscreen?: () => void;
  disabled?: boolean;
  selectedQualityLabel?: string;
  selectedQualityLevel?: number;
  qualityOptions?: BunnyQualityOption[];
  onQualityChange?: (level: number) => void;
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const total = Math.floor(value);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function enterPreviewFullscreen(
  container: HTMLElement | null,
  video: HTMLVideoElement | null
) {
  if (container && document.fullscreenElement === container) {
    void document.exitFullscreen().catch(() => {});
    return;
  }
  if (container?.requestFullscreen) {
    void container.requestFullscreen().catch(() => {
      (
        video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
      )?.webkitEnterFullscreen?.();
    });
    return;
  }
  (
    video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
  )?.webkitEnterFullscreen?.();
}

export function PreviewPlayerControls({
  isPlaying,
  isMuted,
  currentTime,
  duration,
  playbackSpeed,
  onPlayPause,
  onSkip,
  onMute,
  onSeek,
  onSpeedChange,
  onFullscreen,
  disabled = false,
  selectedQualityLabel,
  selectedQualityLevel,
  qualityOptions = [],
  onQualityChange,
}: PreviewPlayerControlsProps) {
  const [fullscreenContainer, setFullscreenContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const syncFullscreen = () =>
      setFullscreenContainer(document.fullscreenElement as HTMLElement | null);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safeTime = Math.min(
    safeDuration,
    Math.max(0, Number.isFinite(currentTime) ? currentTime : 0)
  );
  const percent = safeDuration ? (safeTime / safeDuration) * 100 : 0;

  return (
    <div className="shrink-0 border-t bg-background px-3 py-2 sm:px-4">
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={disabled}
          onClick={onPlayPause}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={disabled}
          onClick={() => onSkip(-10)}
          aria-label="Back 10 seconds"
          title="Back 10s"
        >
          <SkipBack className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={disabled}
          onClick={() => onSkip(10)}
          aria-label="Forward 10 seconds"
          title="Forward 10s"
        >
          <SkipForward className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={disabled}
          onClick={onMute}
          aria-label={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </Button>
        <span className="ml-1 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          {formatTime(safeTime)} / {formatTime(safeDuration)}
        </span>
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs" disabled={disabled}>
                <Gauge className="h-3.5 w-3.5" />
                {playbackSpeed}x
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              portalContainer={fullscreenContainer ?? undefined}
              align="end"
              className="min-w-[80px]"
            >
              {NATIVE_SPEED_OPTIONS.map((speed) => (
                <DropdownMenuItem
                  key={speed}
                  onClick={() => onSpeedChange(speed)}
                  className={cn(
                    'flex items-center justify-between gap-2',
                    speed === playbackSpeed && 'font-bold text-primary'
                  )}
                >
                  {speed}x
                  {speed > SILENT_ABOVE_SPEED && (
                    <span className="text-[10px] font-normal text-muted-foreground">no audio</span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {onQualityChange && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs" disabled={disabled}>
                  Quality {selectedQualityLabel ?? 'Auto'}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                portalContainer={fullscreenContainer ?? undefined}
                align="end"
                className="min-w-[120px]"
              >
                <DropdownMenuItem
                  onClick={() => onQualityChange(-1)}
                  className={cn(selectedQualityLevel === -1 && 'font-bold text-primary')}
                >
                  Auto
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onQualityChange(-2)}
                  className={cn(selectedQualityLevel === -2 && 'font-bold text-primary')}
                >
                  Original
                </DropdownMenuItem>
                {qualityOptions.map((option) => (
                  <DropdownMenuItem
                    key={option.level}
                    onClick={() => onQualityChange(option.level)}
                    className={cn(
                      selectedQualityLevel === option.level && 'font-bold text-primary'
                    )}
                  >
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {onFullscreen && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={onFullscreen}
              aria-label={fullscreenContainer ? 'Exit fullscreen' : 'Fullscreen'}
              title={fullscreenContainer ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {fullscreenContainer ? (
                <Minimize className="h-4 w-4" />
              ) : (
                <Maximize className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
      </div>
      <div className="relative h-8 rounded bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
        <div
          className="pointer-events-none absolute inset-y-0 left-0 rounded bg-primary/30"
          style={{ width: `${percent}%` }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 w-1 rounded bg-primary"
          style={{ left: `calc(${percent}% - ${percent / 25}px)` }}
        />
        <input
          type="range"
          min={0}
          max={safeDuration || 1}
          step="any"
          value={safeTime}
          disabled={disabled || !safeDuration}
          onChange={(event) => onSeek(Number(event.currentTarget.value))}
          aria-label="Seek playback"
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
      </div>
    </div>
  );
}
