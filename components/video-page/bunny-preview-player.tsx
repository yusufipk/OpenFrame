'use client';
/* eslint-disable react-hooks/set-state-in-effect */

import {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import Hls, { type Level } from 'hls.js';
import { Loader2, Pause, Play } from 'lucide-react';
import {
  enterPreviewFullscreen,
  PreviewPlayerControls,
} from '@/components/video-page/preview-player-controls';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import type { BunnyPlaybackState, BunnyQualityOption } from '@/components/video-page/types';

import {
  AttachmentVideoAnnotationContext,
  AttachmentVideoFrame,
} from '@/components/video-page/attachment-video-frame';

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

function formatBunnyQualityLabel(
  level: { height?: number; bitrate?: number },
  index: number
): string {
  if (typeof level.height === 'number' && level.height > 0) {
    return `${level.height}p`;
  }
  if (typeof level.bitrate === 'number' && level.bitrate > 0) {
    return `${Math.round(level.bitrate / 1000)} kbps`;
  }
  return `Level ${index + 1}`;
}

export const BunnyPreviewPlayer = forwardRef<BunnyPreviewPlayerHandle, BunnyPreviewPlayerProps>(
  function BunnyPreviewPlayer({ providerVideoId, isProcessing, onReadyToPlay }, ref) {
    const annotation = useContext(AttachmentVideoAnnotationContext);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
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
    const bunnyCdnHostname = useMemo(() => resolvePublicBunnyCdnHostname(), []);

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
      let sourceMode: 'hls' | 'original' =
        bunnySourcePreference === 'original' ? 'original' : 'hls';
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
          try {
            hlsRef.current.destroy();
          } catch {
            /* ignore */
          }
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
        videoEl
          .play()
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
          const knownDuration =
            Number.isFinite(videoEl.duration) && videoEl.duration > 0
              ? videoEl.duration
              : cachedDuration;
          const targetTime =
            knownDuration > 0
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
        if (
          Number.isFinite(videoEl.duration) &&
          videoEl.duration > 0 &&
          videoEl.duration !== cachedDuration
        ) {
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
        setQualityOptions(
          levels.map((level, index) => ({
            level: index,
            label: formatBunnyQualityLabel(level, index),
          }))
        );
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
          const isManifestLoadFailure =
            data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
            data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT;
          const hasProcessingLikeStatus =
            responseCode === undefined ||
            responseCode === 0 ||
            responseCode === 403 ||
            responseCode === 404 ||
            responseCode === 423 ||
            responseCode === 429 ||
            responseCode === 503;
          const isLikelyProcessing = isManifestLoadFailure && hasProcessingLikeStatus;
          const isNetworkPreMetadataProcessing =
            data.type === Hls.ErrorTypes.NETWORK_ERROR &&
            hasProcessingLikeStatus &&
            videoEl.readyState < HTMLMediaElement.HAVE_METADATA;
          const isUnknownPreMetadataProcessing =
            !data.details && !data.type && videoEl.readyState < HTMLMediaElement.HAVE_METADATA;

          if (
            isLikelyProcessing ||
            isNetworkPreMetadataProcessing ||
            isUnknownPreMetadataProcessing
          ) {
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
          try {
            hlsRef.current.destroy();
          } catch {
            /* ignore */
          }
          hlsRef.current = null;
        }
        videoEl.removeAttribute('src');
        videoEl.load();
      };
    }, [notifyReadyToPlay, originalUrl, playlistUrl, bunnySourcePreference, providerVideoId]);

    const seekTo = (seconds: number) => {
      const video = videoRef.current;
      if (!video || !duration) return;
      video.currentTime = Math.min(duration, Math.max(0, seconds));
      setCurrentTime(video.currentTime);
    };

    const togglePlayPause = useCallback(() => {
      const video = videoRef.current;
      if (!video || !isReady) return;
      if (video.paused) void video.play();
      else video.pause();
    }, [isReady]);

    const seekBy = useCallback(
      (seconds: number) => {
        const video = videoRef.current;
        if (!video || !isReady || !duration) return;
        video.currentTime = Math.min(duration, Math.max(0, (video.currentTime || 0) + seconds));
        setCurrentTime(video.currentTime);
      },
      [duration, isReady]
    );

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

    const handleQualityChange = useCallback(
      (level: number) => {
        const shouldCaptureSourceSwitch =
          (level === -2 && bunnySourcePreference !== 'original') ||
          (level !== -2 && bunnySourcePreference === 'original');
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
      },
      [bunnySourcePreference]
    );

    useImperativeHandle(
      ref,
      () => ({
        togglePlayPause,
        seekBy,
        toggleMute,
      }),
      [seekBy, toggleMute, togglePlayPause]
    );

    const showProcessingOverlay = bunnyPlaybackState !== 'error' && !isReady;
    const showErrorOverlay = bunnyPlaybackState === 'error';
    const loadingLabel =
      isProcessing || bunnyPlaybackState === 'processing' ? 'Processing...' : 'Loading...';

    const selectedQualityLabel = useMemo(() => {
      if (selectedQualityLevel === -2) return 'Original';
      if (selectedQualityLevel === -1) return 'Auto';
      return (
        qualityOptions.find((option) => option.level === selectedQualityLevel)?.label ?? 'Auto'
      );
    }, [qualityOptions, selectedQualityLevel]);

    return (
      <div
        ref={containerRef}
        className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-black"
      >
        <AttachmentVideoFrame
          className="group relative flex min-h-0 flex-1 cursor-pointer items-center justify-center bg-black"
          onClick={togglePlayPause}
        >
          <video
            ref={videoRef}
            className="w-full h-full object-contain bg-black"
            playsInline
            preload="metadata"
          />

          {isReady && !annotation?.isAnnotating && !annotation?.viewingAnnotation && (
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
              <p className="text-xs text-white/85">
                Unable to load Bunny preview. Please try again in a moment.
              </p>
            </div>
          )}
        </AttachmentVideoFrame>

        <PreviewPlayerControls
          isPlaying={isPlaying}
          isMuted={isMuted}
          currentTime={currentTime}
          duration={duration}
          playbackSpeed={playbackSpeed}
          onPlayPause={togglePlayPause}
          onSkip={seekBy}
          onMute={toggleMute}
          onSeek={seekTo}
          onSpeedChange={handleSpeedChange}
          selectedQualityLabel={selectedQualityLabel}
          selectedQualityLevel={selectedQualityLevel}
          qualityOptions={qualityOptions}
          onQualityChange={handleQualityChange}
          onFullscreen={
            annotation?.isAnnotating
              ? undefined
              : () => enterPreviewFullscreen(containerRef.current, videoRef.current)
          }
          disabled={!isReady || annotation?.isAnnotating}
        />
      </div>
    );
  }
);
