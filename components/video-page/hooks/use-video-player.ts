'use client';
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import Hls, { type Level } from 'hls.js';
import { toast } from 'sonner';
import type { AnnotationStroke } from '@/components/annotation-canvas';
import type {
  BunnyPlaybackState,
  BunnyQualityOption,
  PlayerAdapter,
  Version,
} from '@/components/video-page/types';
import { validateAnnotationStrokes } from '@/lib/validation';

interface UseVideoPlayerParams {
  activeVersion: Version | undefined;
  activeVersionId: string | null;
  activeProviderId: string | undefined;
  embedUrl: string;
  canInitializePlayer: boolean;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  bunnyViewportRef: RefObject<HTMLDivElement | null>;
  timelineRef: RefObject<HTMLDivElement | null>;
  hlsRef: RefObject<Hls | null>;
  playerRef: RefObject<YT.Player | PlayerAdapter | null>;
  formatBunnyQualityLabel: (level: { height?: number; bitrate?: number }, index: number) => string;
  speedOptions: number[];
  scheduleWatchProgressSaveRef: RefObject<
    (input: { progress: number; duration?: number; immediate?: boolean; force?: boolean }) => void
  >;
  setViewingAnnotation: (strokes: AnnotationStroke[] | null) => void;
}

export function useVideoPlayer({
  activeVersion,
  activeVersionId,
  activeProviderId,
  embedUrl,
  canInitializePlayer,
  iframeRef,
  videoRef,
  bunnyViewportRef,
  timelineRef,
  hlsRef,
  playerRef,
  formatBunnyQualityLabel,
  speedOptions,
  scheduleWatchProgressSaveRef,
  setViewingAnnotation,
}: UseVideoPlayerParams) {
  const [isApiLoaded, setIsApiLoaded] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [bunnyPlaybackState, setBunnyPlaybackState] = useState<BunnyPlaybackState>('none');
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isFrameMode, setIsFrameMode] = useState(false);
  const [estimatedFrameRate, setEstimatedFrameRate] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [qualityOptions, setQualityOptions] = useState<BunnyQualityOption[]>([]);
  const [selectedQualityLevel, setSelectedQualityLevel] = useState<number>(-1);
  const [bunnySourcePreference, setBunnySourcePreference] = useState<'auto' | 'original'>('auto');
  const pendingHlsQualityRef = useRef<number | null>(null);
  const bunnySourceSwitchResumeRef = useRef<{ time: number; wasPlaying: boolean } | null>(null);
  const previousVersionKeyRef = useRef<string | null>(null);
  const [isBunnyPortraitSource, setIsBunnyPortraitSource] = useState(false);
  const [bunnyPortraitFrameWidth, setBunnyPortraitFrameWidth] = useState<number>(0);
  const [cursorIdle, setCursorIdle] = useState(false);
  const cursorIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bunnyRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bunnyFrameCallbackIdRef = useRef<number | null>(null);
  const bunnyFrameSampleRef = useRef<{ mediaTime: number; presentedFrames: number } | null>(null);
  const [isFullscreenMode, setIsFullscreenMode] = useState(false);
  const [showComments, setShowComments] = useState(true);
  const [isMobileCommentsOpen, setIsMobileCommentsOpen] = useState(false);

  const frameStepSeconds = useMemo(() => {
    if (estimatedFrameRate && Number.isFinite(estimatedFrameRate) && estimatedFrameRate > 0) {
      return 1 / estimatedFrameRate;
    }
    return 1;
  }, [estimatedFrameRate]);

  const frameStepLabel = useMemo(() => {
    if (estimatedFrameRate && Number.isFinite(estimatedFrameRate) && estimatedFrameRate > 0) {
      return '1f';
    }
    return '1s';
  }, [estimatedFrameRate]);

  const stopBunnyFrameTracking = useCallback(() => {
    const videoEl = videoRef.current;
    const callbackId = bunnyFrameCallbackIdRef.current;
    if (videoEl && callbackId !== null && typeof videoEl.cancelVideoFrameCallback === 'function') {
      videoEl.cancelVideoFrameCallback(callbackId);
    }
    bunnyFrameCallbackIdRef.current = null;
    bunnyFrameSampleRef.current = null;
  }, [videoRef]);

  const startBunnyFrameTracking = useCallback(() => {
    const videoEl = videoRef.current;
    if (!videoEl || typeof videoEl.requestVideoFrameCallback !== 'function') return;

    stopBunnyFrameTracking();

    const trackFrameRate = (
      _now: number,
      metadata: { mediaTime: number; presentedFrames: number }
    ) => {
      const previousSample = bunnyFrameSampleRef.current;
      bunnyFrameSampleRef.current = {
        mediaTime: metadata.mediaTime,
        presentedFrames: metadata.presentedFrames,
      };

      if (previousSample) {
        const deltaFrames = metadata.presentedFrames - previousSample.presentedFrames;
        const deltaTime = metadata.mediaTime - previousSample.mediaTime;
        if (deltaFrames > 0 && deltaTime > 0) {
          const nextFrameRate = deltaFrames / deltaTime;
          if (Number.isFinite(nextFrameRate) && nextFrameRate >= 12 && nextFrameRate <= 120) {
            setEstimatedFrameRate(nextFrameRate);
          }
        }
      }

      bunnyFrameCallbackIdRef.current = videoEl.requestVideoFrameCallback(trackFrameRate);
    };

    bunnyFrameCallbackIdRef.current = videoEl.requestVideoFrameCallback(trackFrameRate);
  }, [stopBunnyFrameTracking, videoRef]);

  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  useEffect(() => {
    const viewportEl = bunnyViewportRef.current;
    if (!viewportEl || typeof ResizeObserver === 'undefined') return;

    const updateFrameWidth = () => {
      const viewportWidth = viewportEl.clientWidth;
      const viewportHeight = viewportEl.clientHeight;
      if (viewportWidth <= 0 || viewportHeight <= 0) return;
      setBunnyPortraitFrameWidth(Math.min(viewportWidth, viewportHeight * (9 / 16)));
    };

    updateFrameWidth();
    const observer = new ResizeObserver(updateFrameWidth);
    observer.observe(viewportEl);
    return () => observer.disconnect();
  }, [activeVersionId, bunnyViewportRef]);

  const handleVideoMouseMove = useCallback(() => {
    setCursorIdle(false);
    if (cursorIdleTimerRef.current) clearTimeout(cursorIdleTimerRef.current);

    const shouldHideControls = isFullscreenMode;

    if (isPlaying || shouldHideControls) {
      cursorIdleTimerRef.current = setTimeout(() => {
        setCursorIdle(true);
      }, 1000);
    }
  }, [isFullscreenMode, isPlaying]);

  const handleVideoMouseLeave = useCallback(() => {
    if (cursorIdleTimerRef.current) clearTimeout(cursorIdleTimerRef.current);
    setCursorIdle(false);
  }, []);

  useEffect(() => {
    return () => {
      if (cursorIdleTimerRef.current) clearTimeout(cursorIdleTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (isApiLoaded) return;

    if (window.YT) {
      setIsApiLoaded(true);
      return;
    }

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);

    window.onYouTubeIframeAPIReady = () => {
      setIsApiLoaded(true);
    };
  }, [isApiLoaded]);

  useEffect(() => {
    if (!canInitializePlayer) return;
    if (!activeProviderId) return;
    const isYoutube = activeProviderId === 'youtube';
    const isBunny = activeProviderId === 'bunny';

    if (isYoutube && !isApiLoaded) return;
    if (!isYoutube && !isBunny) return;

    const currentVersionKey = `${activeProviderId ?? 'none'}:${activeVersionId ?? 'none'}`;
    const versionChanged = previousVersionKeyRef.current !== currentVersionKey;
    previousVersionKeyRef.current = currentVersionKey;

    setIsReady(false);
    setBunnyPlaybackState('none');
    setCurrentTime(0);
    setVideoDuration(0);
    setIsPlaying(false);
    setIsMuted(false);
    setEstimatedFrameRate(null);
    setPlaybackSpeed(1);
    setQualityOptions((prev) => (versionChanged ? [] : prev));
    setSelectedQualityLevel(bunnySourcePreference === 'original' ? -2 : -1);
    setIsBunnyPortraitSource(false);

    if (playerRef.current) {
      try {
        playerRef.current.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
    }
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch {
        /* ignore */
      }
      hlsRef.current = null;
    }
    if (bunnyRetryTimerRef.current) {
      clearTimeout(bunnyRetryTimerRef.current);
      bunnyRetryTimerRef.current = null;
    }
    stopBunnyFrameTracking();

    const initPlayer = () => {
      if (isYoutube) {
        if (!iframeRef.current) return;
        playerRef.current = new YT.Player(iframeRef.current, {
          events: {
            onReady: (event: YT.PlayerEvent) => {
              setIsReady(true);
              const dur = event.target.getDuration();
              if (dur > 0) setVideoDuration(dur);
            },
            onStateChange: (event: YT.OnStateChangeEvent) => {
              setIsPlaying(event.data === YT.PlayerState.PLAYING);

              if (event.data === YT.PlayerState.PAUSED) {
                const playerCurrentTime = playerRef.current?.getCurrentTime?.() || 0;
                const playerDuration = playerRef.current?.getDuration?.() || 0;
                scheduleWatchProgressSaveRef.current({
                  progress: playerCurrentTime,
                  duration: playerDuration,
                  immediate: true,
                  force: true,
                });
              }

              if (event.data === YT.PlayerState.PLAYING) {
                const dur = event.target.getDuration();
                if (dur > 0) setVideoDuration(dur);
              }
            },
          },
        });
      } else if (isBunny) {
        const videoEl = videoRef.current;
        if (!videoEl) return;

        const bunnyOriginalUrl = embedUrl.includes('/playlist.m3u8')
          ? embedUrl.replace('/playlist.m3u8', '/original')
          : '';

        let cachedDuration = 0;
        let destroyed = false;
        let retryAttempt = 0;
        let usingHlsJs = false;
        let hlsInstance: Hls | null = null;
        let sourceMode: 'hls' | 'original' =
          bunnySourcePreference === 'original' ? 'original' : 'hls';
        const clearRetryTimer = () => {
          if (bunnyRetryTimerRef.current) {
            clearTimeout(bunnyRetryTimerRef.current);
            bunnyRetryTimerRef.current = null;
          }
        };
        const scheduleRetry = (retryFn: () => void) => {
          clearRetryTimer();
          bunnyRetryTimerRef.current = setTimeout(() => {
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
          videoEl.src = getRetryUrl(embedUrl);
          videoEl.load();
        };
        const retryOriginalLoad = () => {
          if (!bunnyOriginalUrl) return;
          videoEl.src = getRetryUrl(bunnyOriginalUrl);
          videoEl.load();
        };
        const retryHlsLoad = () => {
          if (destroyed || !hlsInstance) return;
          const retryUrl = getRetryUrl(embedUrl);
          try {
            hlsInstance.stopLoad();
          } catch {
            // ignore stop-load failures and continue with a fresh loadSource
          }
          hlsInstance.loadSource(retryUrl);
          hlsInstance.startLoad(-1);
        };
        const activateOriginalFallback = (): boolean => {
          if (!bunnyOriginalUrl) return false;
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
            setVideoDuration(videoEl.duration);
          }
        };

        const saveProgress = () => {
          const current = videoEl.currentTime || 0;
          const duration =
            Number.isFinite(videoEl.duration) && videoEl.duration > 0
              ? videoEl.duration
              : cachedDuration;
          scheduleWatchProgressSaveRef.current({
            progress: current,
            duration,
            immediate: true,
            force: true,
          });
        };

        const onLoadedMetadata = () => {
          if (destroyed) return;
          clearRetryTimer();
          if (sourceMode === 'original') {
            setSelectedQualityLevel(-2);
          }
          setBunnyPlaybackState(sourceMode === 'original' ? 'processing' : 'none');
          if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
            setIsBunnyPortraitSource(videoEl.videoHeight > videoEl.videoWidth);
          }
          setIsReady(true);
          const resumeState = bunnySourceSwitchResumeRef.current;
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
            bunnySourceSwitchResumeRef.current = null;
            if (resumeState.wasPlaying) {
              videoEl
                .play()
                .catch((err) =>
                  console.error('Error resuming Bunny video after source switch:', err)
                );
            }
          }
          syncDuration();
          if (!videoEl.paused) {
            startBunnyFrameTracking();
          }
        };

        const onPlay = () => {
          setIsPlaying(true);
          if (sourceMode !== 'original') {
            setBunnyPlaybackState('none');
          }
          syncDuration();
          startBunnyFrameTracking();
        };

        const onPause = () => {
          setIsPlaying(false);
          stopBunnyFrameTracking();
          saveProgress();
        };

        const onEnded = () => {
          setIsPlaying(false);
          stopBunnyFrameTracking();
          saveProgress();
        };

        const onTimeUpdate = () => {
          if (!isDraggingRef.current) {
            setCurrentTime(videoEl.currentTime || 0);
          }
          if (
            Number.isFinite(videoEl.duration) &&
            videoEl.duration > 0 &&
            videoEl.duration !== cachedDuration
          ) {
            cachedDuration = videoEl.duration;
            setVideoDuration(videoEl.duration);
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

        videoEl.addEventListener('loadedmetadata', onLoadedMetadata);
        videoEl.addEventListener('play', onPlay);
        videoEl.addEventListener('pause', onPause);
        videoEl.addEventListener('ended', onEnded);
        videoEl.addEventListener('timeupdate', onTimeUpdate);
        videoEl.addEventListener('error', onVideoError);

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

        if (sourceMode === 'original' && bunnyOriginalUrl) {
          retryOriginalLoad();
        } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          sourceMode = 'hls';
          videoEl.src = embedUrl;
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
              hls.loadSource(embedUrl);
            }
          });

          hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
            if (destroyed) return;
            clearRetryTimer();
            setBunnyPlaybackState('none');
            configureHlsLevels(data.levels);
            setIsReady(true);
            syncDuration();
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
              console.error('Fatal HLS error:', data);
            }
          });
        } else {
          setBunnyPlaybackState('error');
          console.error('HLS is not supported in this browser.');
        }

        playerRef.current = {
          playVideo: () => {
            videoEl.play().catch((err) => console.error('Error playing Bunny video:', err));
          },
          pauseVideo: () => videoEl.pause(),
          seekTo: (time: number) => {
            videoEl.currentTime = time;
          },
          mute: () => {
            videoEl.muted = true;
          },
          unMute: () => {
            videoEl.muted = false;
          },
          isMuted: () => videoEl.muted,
          getCurrentTime: () => videoEl.currentTime || 0,
          getDuration: () => {
            if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) return videoEl.duration;
            return cachedDuration;
          },
          getPlayerState: () =>
            videoEl.paused
              ? (window.YT?.PlayerState?.PAUSED ?? 2)
              : (window.YT?.PlayerState?.PLAYING ?? 1),
          setPlaybackRate: (rate: number) => {
            videoEl.playbackRate = rate;
          },
          destroy: () => {
            destroyed = true;
            clearRetryTimer();
            stopBunnyFrameTracking();
            videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
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
          },
        };
      }
    };

    const timeout = setTimeout(() => {
      if (isYoutube) {
        if (window.YT?.Player) {
          initPlayer();
        } else {
          window.onYouTubeIframeAPIReady = initPlayer;
        }
      } else if (isBunny) {
        initPlayer();
      }
    }, 100);

    return () => {
      clearTimeout(timeout);
      if (isYoutube) {
        window.onYouTubeIframeAPIReady = undefined;
      }
      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch {
          /* ignore */
        }
        playerRef.current = null;
      }
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch {
          /* ignore */
        }
        hlsRef.current = null;
      }
      if (bunnyRetryTimerRef.current) {
        clearTimeout(bunnyRetryTimerRef.current);
        bunnyRetryTimerRef.current = null;
      }
      stopBunnyFrameTracking();
    };
  }, [
    activeProviderId,
    activeVersionId,
    embedUrl,
    isApiLoaded,
    canInitializePlayer,
    formatBunnyQualityLabel,
    bunnySourcePreference,
    hlsRef,
    iframeRef,
    playerRef,
    scheduleWatchProgressSaveRef,
    startBunnyFrameTracking,
    stopBunnyFrameTracking,
    videoRef,
  ]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement
        .requestFullscreen()
        .then(() => {
          setIsFullscreenMode(true);
          setShowComments(false);
        })
        .catch((err) => {
          console.error('Fullscreen failed:', err);
          toast.error('Unable to enter fullscreen mode');
        });
    } else {
      document
        .exitFullscreen()
        .then(() => {
          setIsFullscreenMode(false);
          setShowComments(true);
        })
        .catch((err) => {
          console.error('Exit fullscreen failed:', err);
          toast.error('Unable to exit fullscreen mode');
        });
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isCurrentlyFullscreen = !!document.fullscreenElement;
      setIsFullscreenMode(isCurrentlyFullscreen);
      if (isCurrentlyFullscreen) {
        setShowComments(false);
      } else {
        setShowComments(true);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!isReady || !playerRef.current) return;

    const interval = setInterval(() => {
      if (!isDragging && playerRef.current) {
        if (playerRef.current.getCurrentTime) {
          setCurrentTime(playerRef.current.getCurrentTime());
        }
      }
    }, 250);

    return () => clearInterval(interval);
  }, [isReady, isDragging, activeVersion?.providerId, playerRef]);

  const duration = useMemo(() => {
    return videoDuration || activeVersion?.duration || 0;
  }, [videoDuration, activeVersion?.duration]);

  const resolveSkipAmount = useCallback(
    (seconds: number) => {
      if (!isFrameMode) return seconds;
      const direction = seconds === 0 ? 1 : Math.sign(seconds);
      return frameStepSeconds * direction;
    },
    [frameStepSeconds, isFrameMode]
  );

  const handleFrameModeToggle = useCallback(() => {
    setIsFrameMode((prev) => !prev);
  }, []);

  const handlePlayPause = useCallback(() => {
    if (!playerRef.current) return;
    if (isPlaying) {
      playerRef.current.pauseVideo();
    } else {
      playerRef.current.playVideo();
    }
  }, [isPlaying, playerRef]);

  const handleSeekToTimestamp = useCallback(
    (
      timestamp: number,
      annotation?: string | null,
      options?: { pauseAfterSeek?: boolean; timestampEnd?: number | null }
    ) => {
      setCurrentTime(timestamp);
      if (playerRef.current?.seekTo) {
        const playerState = playerRef.current.getPlayerState?.();
        const ytPlayingState = window.YT?.PlayerState?.PLAYING ?? 1;
        const ytBufferingState = window.YT?.PlayerState?.BUFFERING ?? 3;
        const wasPlayingBeforeSeek =
          typeof playerState === 'number'
            ? playerState === ytPlayingState || playerState === ytBufferingState
            : isPlaying;
        const hasRangeEnd = options?.timestampEnd !== undefined && options.timestampEnd !== null;
        const shouldPauseAfterSeek = options?.pauseAfterSeek || hasRangeEnd;

        playerRef.current.seekTo(timestamp, true);
        if (shouldPauseAfterSeek) {
          playerRef.current.pauseVideo();
        } else if (wasPlayingBeforeSeek) {
          playerRef.current.playVideo();
        } else {
          playerRef.current.pauseVideo();
        }
      }
      if (annotation) {
        try {
          const parsed = JSON.parse(annotation);
          const safe = validateAnnotationStrokes(parsed);
          setViewingAnnotation(safe as AnnotationStroke[] | null);
        } catch {
          setViewingAnnotation(null);
        }
      } else {
        setViewingAnnotation(null);
      }
    },
    [isPlaying, playerRef, setViewingAnnotation]
  );

  const handleMuteToggle = useCallback(() => {
    if (!playerRef.current) return;
    if (isMuted) {
      playerRef.current.unMute();
    } else {
      playerRef.current.mute();
    }
    setIsMuted(!isMuted);
  }, [isMuted, playerRef]);

  const handleSkip = useCallback(
    (seconds: number) => {
      const newTime = Math.max(0, Math.min(duration, currentTime + resolveSkipAmount(seconds)));
      handleSeekToTimestamp(newTime);
    },
    [currentTime, duration, handleSeekToTimestamp, resolveSkipAmount]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('[data-slot="dialog-content"]')) {
        return;
      }

      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      switch (e.code) {
        case 'Space':
        case 'KeyK':
          e.preventDefault();
          if (playerRef.current) {
            if (isPlaying) {
              playerRef.current.pauseVideo();
            } else {
              playerRef.current.playVideo();
            }
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          handleSkip(-5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          handleSkip(5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          {
            const currentIndex = speedOptions.indexOf(playbackSpeed);
            if (currentIndex < speedOptions.length - 1) {
              const newSpeed = speedOptions[currentIndex + 1];
              setPlaybackSpeed(newSpeed);
              playerRef.current?.setPlaybackRate(newSpeed);
            }
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          {
            const currentIndex = speedOptions.indexOf(playbackSpeed);
            if (currentIndex > 0) {
              const newSpeed = speedOptions[currentIndex - 1];
              setPlaybackSpeed(newSpeed);
              playerRef.current?.setPlaybackRate(newSpeed);
            }
          }
          break;
        case 'Comma':
          if (e.shiftKey) {
            e.preventDefault();
            const currentIndex = speedOptions.indexOf(playbackSpeed);
            if (currentIndex > 0) {
              const newSpeed = speedOptions[currentIndex - 1];
              setPlaybackSpeed(newSpeed);
              playerRef.current?.setPlaybackRate(newSpeed);
            }
          }
          break;
        case 'Period':
          if (e.shiftKey) {
            e.preventDefault();
            const currentIndex = speedOptions.indexOf(playbackSpeed);
            if (currentIndex < speedOptions.length - 1) {
              const newSpeed = speedOptions[currentIndex + 1];
              setPlaybackSpeed(newSpeed);
              playerRef.current?.setPlaybackRate(newSpeed);
            }
          }
          break;
        case 'KeyM':
          e.preventDefault();
          if (playerRef.current) {
            if (isMuted) {
              playerRef.current.unMute();
            } else {
              playerRef.current.mute();
            }
            setIsMuted(!isMuted);
          }
          break;
        case 'KeyJ':
          e.preventDefault();
          if (playerRef.current?.seekTo) {
            const newTime = Math.max(0, currentTime - 10);
            playerRef.current.seekTo(newTime, true);
            setCurrentTime(newTime);
          }
          break;
        case 'KeyL':
          e.preventDefault();
          if (playerRef.current?.seekTo) {
            const newTime = Math.min(duration, currentTime + 10);
            playerRef.current.seekTo(newTime, true);
            setCurrentTime(newTime);
          }
          break;
        case 'KeyF':
          e.preventDefault();
          toggleFullscreen();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    isPlaying,
    currentTime,
    duration,
    isMuted,
    playbackSpeed,
    speedOptions,
    handleSkip,
    toggleFullscreen,
    playerRef,
  ]);

  const handleSpeedChange = useCallback(
    (speed: number) => {
      setPlaybackSpeed(speed);
      playerRef.current?.setPlaybackRate(speed);
    },
    [playerRef]
  );

  const handleQualityChange = useCallback(
    (level: number) => {
      const shouldCaptureSourceSwitch =
        activeProviderId === 'bunny' &&
        ((level === -2 && bunnySourcePreference !== 'original') ||
          (level !== -2 && bunnySourcePreference === 'original'));

      if (shouldCaptureSourceSwitch) {
        const fallbackCurrentTime = videoRef.current?.currentTime ?? 0;
        const current = playerRef.current?.getCurrentTime?.() ?? fallbackCurrentTime;
        bunnySourceSwitchResumeRef.current = {
          time: Number.isFinite(current) ? Math.max(0, current) : 0,
          wasPlaying: isPlaying,
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
    [activeProviderId, bunnySourcePreference, hlsRef, isPlaying, playerRef, videoRef]
  );

  const handleTimelineClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!timelineRef.current) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percentage = Math.max(0, Math.min(1, x / rect.width));
      const newTime = percentage * duration;
      handleSeekToTimestamp(newTime);
    },
    [duration, handleSeekToTimestamp, timelineRef]
  );

  const handleTimelineMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      setIsDragging(true);
      handleTimelineClick(e);
    },
    [handleTimelineClick]
  );

  const handleTimelineMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isDragging || !timelineRef.current) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percentage = Math.max(0, Math.min(1, x / rect.width));
      setCurrentTime(percentage * duration);
    },
    [isDragging, duration, timelineRef]
  );

  const handleTimelineMouseUp = useCallback(() => {
    if (isDragging) {
      handleSeekToTimestamp(currentTime);
      setIsDragging(false);
    }
  }, [isDragging, currentTime, handleSeekToTimestamp]);

  return {
    isReady,
    bunnyPlaybackState,
    currentTime,
    setCurrentTime,
    videoDuration,
    setVideoDuration,
    isPlaying,
    isMuted,
    isFrameMode,
    frameStepSeconds,
    frameStepLabel,
    isDragging,
    playbackSpeed,
    qualityOptions,
    selectedQualityLevel,
    isBunnyPortraitSource,
    bunnyPortraitFrameWidth,
    cursorIdle,
    isFullscreenMode,
    showComments,
    isMobileCommentsOpen,
    setShowComments,
    setIsMobileCommentsOpen,
    handleVideoMouseMove,
    handleVideoMouseLeave,
    handlePlayPause,
    handleSeekToTimestamp,
    handleMuteToggle,
    handleFrameModeToggle,
    handleSkip,
    handleSpeedChange,
    handleQualityChange,
    handleTimelineMouseDown,
    handleTimelineMouseMove,
    handleTimelineMouseUp,
    toggleFullscreen,
  };
}
