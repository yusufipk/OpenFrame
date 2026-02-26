'use client';
/* eslint-disable react-hooks/set-state-in-effect */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import Hls, { type Level } from 'hls.js';
import { ChevronDown, Loader2, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { BunnyPlaybackState, BunnyQualityOption } from '@/components/video-page/types';

interface BunnyPreviewPlayerProps {
  providerVideoId: string | null;
  isProcessing: boolean;
  onReadyToPlay?: () => void;
}

export interface BunnyPreviewPlayerHandle {
  togglePlayPause: () => void;
  seekBy: (seconds: number) => void;
  toggleMute: () => void;
}

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

function resolveBunnyCdnHostname(): string | null {
  const configured = process.env.NEXT_PUBLIC_BUNNY_CDN_URL;
  if (!configured) return null;
  try {
    const parsed = new URL(configured);
    return parsed.hostname || null;
  } catch {
    return configured.replace(/^https?:\/\//, '').replace(/\/+$/, '') || null;
  }
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const total = Math.floor(value);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatBunnyQualityLabel(level: { height?: number; bitrate?: number }, index: number): string {
  if (typeof level.height === 'number' && level.height > 0) {
    return `${level.height}p`;
  }
  if (typeof level.bitrate === 'number' && level.bitrate > 0) {
    return `${Math.round(level.bitrate / 1000)} kbps`;
  }
  return `Level ${index + 1}`;
}

export const BunnyPreviewPlayer = forwardRef<BunnyPreviewPlayerHandle, BunnyPreviewPlayerProps>(function BunnyPreviewPlayer({ providerVideoId, isProcessing, onReadyToPlay }, ref) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingHlsQualityRef = useRef<number | null>(null);
  const onReadyToPlayRef = useRef(onReadyToPlay);
  const hasNotifiedReadyRef = useRef(false);
  const playbackSpeedRef = useRef(1);
  const sourceSwitchResumeRef = useRef<{ time: number; wasPlaying: boolean } | null>(null);
  const previousProviderVideoIdRef = useRef<string | null>(null);

  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [qualityOptions, setQualityOptions] = useState<BunnyQualityOption[]>([]);
  const [selectedQualityLevel, setSelectedQualityLevel] = useState<number>(-1);
  const [bunnySourcePreference, setBunnySourcePreference] = useState<'auto' | 'original'>('auto');
  const [bunnyPlaybackState, setBunnyPlaybackState] = useState<BunnyPlaybackState>('none');
  const bunnyCdnHostname = useMemo(() => resolveBunnyCdnHostname(), []);

  const playlistUrl = useMemo(() => {
    if (!providerVideoId || !bunnyCdnHostname) return null;
    return `https://${bunnyCdnHostname}/${providerVideoId}/playlist.m3u8`;
  }, [bunnyCdnHostname, providerVideoId]);
  const originalUrl = useMemo(() => {
    if (!providerVideoId || !bunnyCdnHostname) return null;
    return `https://${bunnyCdnHostname}/${providerVideoId}/original`;
  }, [bunnyCdnHostname, providerVideoId]);

  useEffect(() => {
    onReadyToPlayRef.current = onReadyToPlay;
  }, [onReadyToPlay]);

  useEffect(() => {
    hasNotifiedReadyRef.current = false;
  }, [providerVideoId]);

  const notifyReadyToPlay = useCallback(() => {
    if (hasNotifiedReadyRef.current) return;
    hasNotifiedReadyRef.current = true;
    onReadyToPlayRef.current?.();
  }, []);

  useEffect(() => {
    playbackSpeedRef.current = playbackSpeed;
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);

  useEffect(() => {
    const videoEl = videoRef.current;
    const sourceKey = providerVideoId ?? null;
    const sourceChanged = previousProviderVideoIdRef.current !== sourceKey;
    previousProviderVideoIdRef.current = sourceKey;

    if (!videoEl || !playlistUrl) {
      setIsReady(false);
      setIsPlaying(false);
      setIsMuted(false);
      setCurrentTime(0);
      setDuration(0);
      setQualityOptions((prev) => (sourceChanged ? [] : prev));
      setSelectedQualityLevel(-1);
      setBunnyPlaybackState('error');
      return;
    }

    let cachedDuration = 0;
    let destroyed = false;
    let retryAttempt = 0;
    let usingHlsJs = false;
    let hlsInstance: Hls | null = null;
    let sourceMode: 'hls' | 'original' = bunnySourcePreference === 'original' ? 'original' : 'hls';
    let attemptedAutoplay = false;

    setIsReady(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setIsMuted(videoEl.muted);
    setSelectedQualityLevel(bunnySourcePreference === 'original' ? -2 : -1);
    setQualityOptions((prev) => (sourceChanged ? [] : prev));
    setBunnyPlaybackState('none');

    const clearRetryTimer = () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const scheduleRetry = (retryFn: () => void) => {
      clearRetryTimer();
      retryTimerRef.current = setTimeout(() => {
        if (!destroyed) {
          retryFn();
        }
      }, 3000);
    };

    const getRetryUrl = (baseUrl: string) => {
      retryAttempt += 1;
      const separator = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${separator}retry=${Date.now()}-${retryAttempt}`;
    };

    const retryNativeLoad = () => {
      videoEl.src = getRetryUrl(playlistUrl);
      videoEl.load();
    };

    const retryOriginalLoad = () => {
      if (!originalUrl) return;
      videoEl.src = getRetryUrl(originalUrl);
      videoEl.load();
    };

    const retryHlsLoad = () => {
      if (destroyed || !hlsInstance) return;
      const retryUrl = getRetryUrl(playlistUrl);
      try {
        hlsInstance.stopLoad();
      } catch {
        // ignore stop-load failures and continue with a fresh loadSource
      }
      hlsInstance.loadSource(retryUrl);
      hlsInstance.startLoad(-1);
    };

    const activateOriginalFallback = (): boolean => {
      if (!originalUrl) return false;
      sourceMode = 'original';
      usingHlsJs = false;
      clearRetryTimer();
      if (hlsRef.current) {
        try { hlsRef.current.destroy(); } catch { /* ignore */ }
        hlsRef.current = null;
      }
      hlsInstance = null;
      setSelectedQualityLevel(-2);
      setBunnyPlaybackState('processing');
      setIsReady(false);
      retryOriginalLoad();
      return true;
    };

    const syncDuration = () => {
      if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
        cachedDuration = videoEl.duration;
        setDuration(videoEl.duration);
      }
    };

    const attemptAutoplay = () => {
      if (attemptedAutoplay) return;
      attemptedAutoplay = true;
      videoEl.play()
        .then(() => {
          notifyReadyToPlay();
        })
        .catch(() => {
          // Autoplay can fail due to browser policy. User can still start playback manually.
        });
    };

    const onLoadedMetadata = () => {
      if (destroyed) return;
      clearRetryTimer();
      videoEl.playbackRate = playbackSpeedRef.current;
      if (sourceMode === 'original') {
        setSelectedQualityLevel(-2);
      }
      setBunnyPlaybackState(sourceMode === 'original' ? 'processing' : 'none');
      setIsReady(true);
      const resumeState = sourceSwitchResumeRef.current;
      if (resumeState) {
        const knownDuration = Number.isFinite(videoEl.duration) && videoEl.duration > 0
          ? videoEl.duration
          : cachedDuration;
        const targetTime = knownDuration > 0
          ? Math.min(Math.max(0, resumeState.time), Math.max(0, knownDuration - 0.01))
          : Math.max(0, resumeState.time);
        videoEl.currentTime = targetTime;
        setCurrentTime(targetTime);
        sourceSwitchResumeRef.current = null;
        if (resumeState.wasPlaying) {
          videoEl.play().catch(() => {
            // Ignore policy and transient resume-play errors in preview modal.
          });
        }
      }
      syncDuration();
      attemptAutoplay();
    };

    const onCanPlay = () => {
      if (destroyed) return;
      notifyReadyToPlay();
    };

    const onPlay = () => {
      if (destroyed) return;
      setIsPlaying(true);
      if (sourceMode !== 'original') {
        setBunnyPlaybackState('none');
      }
      syncDuration();
      notifyReadyToPlay();
    };

    const onPause = () => {
      if (destroyed) return;
      setIsPlaying(false);
    };

    const onEnded = () => {
      if (destroyed) return;
      setIsPlaying(false);
    };

    const onTimeUpdate = () => {
      if (destroyed) return;
      setCurrentTime(videoEl.currentTime || 0);
      if (Number.isFinite(videoEl.duration) && videoEl.duration > 0 && videoEl.duration !== cachedDuration) {
        cachedDuration = videoEl.duration;
        setDuration(videoEl.duration);
      }
    };

    const onVideoError = () => {
      if (destroyed) return;
      if (usingHlsJs) return;
      if (videoEl.readyState >= HTMLMediaElement.HAVE_METADATA) {
        setBunnyPlaybackState('error');
        return;
      }
      if (sourceMode === 'hls') {
        if (activateOriginalFallback()) return;
        setIsReady(false);
        setBunnyPlaybackState('processing');
        scheduleRetry(retryNativeLoad);
        return;
      }
      setIsReady(false);
      setBunnyPlaybackState('processing');
      scheduleRetry(retryOriginalLoad);
    };

    const configureHlsLevels = (levels: Level[]) => {
      setQualityOptions(levels.map((level, index) => ({
        level: index,
        label: formatBunnyQualityLabel(level, index),
      })));
      const pendingQuality = pendingHlsQualityRef.current;
      pendingHlsQualityRef.current = null;

      if (pendingQuality === null || pendingQuality === -1) {
        if (hlsInstance) {
          hlsInstance.currentLevel = -1;
          hlsInstance.nextLevel = -1;
        }
        setSelectedQualityLevel(-1);
        return;
      }

      if (pendingQuality >= 0 && pendingQuality < levels.length && hlsInstance) {
        hlsInstance.currentLevel = pendingQuality;
        hlsInstance.nextLevel = pendingQuality;
        setSelectedQualityLevel(pendingQuality);
        return;
      }

      setSelectedQualityLevel(-1);
    };

    videoEl.addEventListener('loadedmetadata', onLoadedMetadata);
    videoEl.addEventListener('canplay', onCanPlay);
    videoEl.addEventListener('play', onPlay);
    videoEl.addEventListener('pause', onPause);
    videoEl.addEventListener('ended', onEnded);
    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('error', onVideoError);

    if (sourceMode === 'original' && originalUrl) {
      retryOriginalLoad();
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      sourceMode = 'hls';
      videoEl.src = playlistUrl;
      videoEl.load();
    } else if (Hls.isSupported()) {
      sourceMode = 'hls';
      usingHlsJs = true;
      const hls = new Hls();
      hlsInstance = hls;
      hlsRef.current = hls;
      hls.attachMedia(videoEl);

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        if (!destroyed) {
          hls.loadSource(playlistUrl);
        }
      });

      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        if (destroyed) return;
        clearRetryTimer();
        setBunnyPlaybackState('none');
        configureHlsLevels(data.levels);
        setIsReady(true);
        syncDuration();
        attemptAutoplay();
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (destroyed) return;
        const responseCode = (data as { response?: { code?: number } }).response?.code;
        const isManifestLoadFailure = data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
          || data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT;
        const hasProcessingLikeStatus = responseCode === undefined
          || responseCode === 0
          || responseCode === 403
          || responseCode === 404
          || responseCode === 423
          || responseCode === 429
          || responseCode === 503;
        const isLikelyProcessing = isManifestLoadFailure
          && hasProcessingLikeStatus;
        const isNetworkPreMetadataProcessing = data.type === Hls.ErrorTypes.NETWORK_ERROR
          && hasProcessingLikeStatus
          && videoEl.readyState < HTMLMediaElement.HAVE_METADATA;
        const isUnknownPreMetadataProcessing = !data.details
          && !data.type
          && videoEl.readyState < HTMLMediaElement.HAVE_METADATA;

        if (isLikelyProcessing || isNetworkPreMetadataProcessing || isUnknownPreMetadataProcessing) {
          if (activateOriginalFallback()) {
            return;
          }
          setIsReady(false);
          setBunnyPlaybackState('processing');
          scheduleRetry(retryHlsLoad);
          return;
        }

        if (data.fatal) {
          setBunnyPlaybackState('error');
          console.error('Fatal Bunny preview HLS error:', data);
        }
      });
    } else {
      setBunnyPlaybackState('error');
      console.error('HLS is not supported in this browser.');
    }

    return () => {
      destroyed = true;
      clearRetryTimer();
      videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
      videoEl.removeEventListener('canplay', onCanPlay);
      videoEl.removeEventListener('play', onPlay);
      videoEl.removeEventListener('pause', onPause);
      videoEl.removeEventListener('ended', onEnded);
      videoEl.removeEventListener('timeupdate', onTimeUpdate);
      videoEl.removeEventListener('error', onVideoError);
      if (hlsRef.current) {
        try { hlsRef.current.destroy(); } catch { /* ignore */ }
        hlsRef.current = null;
      }
      videoEl.removeAttribute('src');
      videoEl.load();
    };
  }, [notifyReadyToPlay, originalUrl, playlistUrl, bunnySourcePreference, providerVideoId]);

  const seekTo = (event: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    video.currentTime = ratio * duration;
    setCurrentTime(video.currentTime);
  };

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video || !isReady) return;
    if (video.paused) void video.play();
    else video.pause();
  }, [isReady]);

  const seekBy = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video || !isReady || !duration) return;
    video.currentTime = Math.min(duration, Math.max(0, (video.currentTime || 0) + seconds));
    setCurrentTime(video.currentTime);
  }, [duration, isReady]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !video.muted;
    video.muted = nextMuted;
    setIsMuted(nextMuted);
  }, []);

  const handleSpeedChange = useCallback((speed: number) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
  }, []);

  const handleQualityChange = useCallback((level: number) => {
    const shouldCaptureSourceSwitch = (
      (level === -2 && bunnySourcePreference !== 'original')
      || (level !== -2 && bunnySourcePreference === 'original')
    );
    if (shouldCaptureSourceSwitch) {
      const current = videoRef.current?.currentTime ?? 0;
      sourceSwitchResumeRef.current = {
        time: Number.isFinite(current) ? Math.max(0, current) : 0,
        wasPlaying: !!videoRef.current && !videoRef.current.paused,
      };
    }

    if (level === -2) {
      pendingHlsQualityRef.current = null;
      setBunnySourcePreference('original');
      setSelectedQualityLevel(-2);
      return;
    }

    pendingHlsQualityRef.current = level;
    setBunnySourcePreference('auto');

    const hls = hlsRef.current;
    if (!hls) {
      setSelectedQualityLevel(level === -1 ? -1 : level);
      return;
    }

    if (level === -1) {
      hls.currentLevel = -1;
      hls.nextLevel = -1;
      setSelectedQualityLevel(-1);
      return;
    }

    hls.currentLevel = level;
    hls.nextLevel = level;
    setSelectedQualityLevel(level);
  }, [bunnySourcePreference]);

  useImperativeHandle(ref, () => ({
    togglePlayPause,
    seekBy,
    toggleMute,
  }), [seekBy, toggleMute, togglePlayPause]);

  const showProcessingOverlay = bunnyPlaybackState !== 'error' && !isReady;
  const showErrorOverlay = bunnyPlaybackState === 'error';
  const loadingLabel = isProcessing || bunnyPlaybackState === 'processing'
    ? 'Processing...'
    : 'Loading...';

  const selectedQualityLabel = useMemo(() => {
    if (selectedQualityLevel === -2) return 'Original';
    if (selectedQualityLevel === -1) return 'Auto';
    return qualityOptions.find((option) => option.level === selectedQualityLevel)?.label ?? 'Auto';
  }, [qualityOptions, selectedQualityLevel]);

  return (
    <div className="w-full h-full rounded-md border overflow-hidden bg-black flex flex-col">
      <div className="relative flex-1 min-h-0 flex items-center justify-center bg-black" onClick={togglePlayPause}>
        <video ref={videoRef} className="w-full h-full object-contain bg-black" playsInline preload="metadata" />

        {showProcessingOverlay && (
          <div className="absolute inset-0 bg-black/65 flex items-center justify-center">
            <div className="flex items-center gap-2 text-white text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              {loadingLabel}
            </div>
          </div>
        )}

        {showErrorOverlay && (
          <div className="absolute inset-0 bg-black/65 flex items-center justify-center">
            <p className="text-xs text-white/85">Unable to load Bunny preview. Please try again in a moment.</p>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-white/10 bg-black/70 px-2 py-1.5">
        <div className="flex items-center gap-1.5 mb-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-white hover:text-white"
            disabled={!isReady}
            onClick={togglePlayPause}
          >
            {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-white hover:text-white"
            disabled={!isReady}
            onClick={toggleMute}
          >
            {isMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </Button>
          <span className="text-[11px] text-white/80 tabular-nums ml-1">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <div className="ml-auto flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px] text-white hover:text-white"
                  disabled={!isReady}
                >
                  {playbackSpeed}x
                  <ChevronDown className="h-3 w-3 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {SPEED_OPTIONS.map((speed) => (
                  <DropdownMenuItem key={speed} onClick={() => handleSpeedChange(speed)}>
                    {speed}x {speed === playbackSpeed ? '(Current)' : ''}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px] text-white hover:text-white"
                  disabled={!isReady}
                >
                  {selectedQualityLabel}
                  <ChevronDown className="h-3 w-3 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => handleQualityChange(-1)}>
                  Auto {selectedQualityLevel === -1 ? '(Current)' : ''}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleQualityChange(-2)}>
                  Original {selectedQualityLevel === -2 ? '(Current)' : ''}
                </DropdownMenuItem>
                {qualityOptions.map((option) => (
                  <DropdownMenuItem key={option.level} onClick={() => handleQualityChange(option.level)}>
                    {option.label} {option.level === selectedQualityLevel ? '(Current)' : ''}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div
          className={cn(
            'relative h-6 rounded bg-white/10 select-none',
            isReady ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'
          )}
          onClick={seekTo}
        >
          <div
            className="absolute left-0 top-0 h-full rounded bg-cyan-500/40 pointer-events-none"
            style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
          />
          <div
            className="absolute top-0 h-full w-1 rounded bg-cyan-400 pointer-events-none"
            style={{ left: `calc(${duration > 0 ? (currentTime / duration) * 100 : 0}% - 2px)` }}
          />
        </div>
      </div>
    </div>
  );
});
