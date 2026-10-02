'use client';
/* eslint-disable react-hooks/set-state-in-effect */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
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
import {
  clampSeekTime,
  getAdjacentPlaybackSpeed,
  getFrameIndexAtTime,
  getFrameStepLabel,
  getFrameStepSeconds,
  getPlayheadPercent,
  isTypingTarget,
  normalizeFrameRate,
  resolvePlayerShortcut,
  resolveSkipAmount as resolveSkipAmountFor,
  timeFromClientX as timeFromClientXWithin,
} from '@/components/video-page/hooks/video-player-utils';
import type { BunnyPlaybackSource } from '@/components/video-page/hooks/use-bunny-playback-source';
import { useCursorIdle } from '@/components/video-page/hooks/use-cursor-idle';
import {
  findLevelForHeight,
  findTopLevel,
  parseMasterPlaylistLevels,
  readStoredQualityPreference,
  shouldUseHlsJs,
  writeStoredQualityPreference,
} from '@/components/video-page/hooks/quality-preference';

/**
 * In Auto, a cut no longer than this plays from the uploaded original instead of the
 * Bunny renditions. Short VFX shots are exactly where the renditions band and smear, and
 * at this length the original costs little more to stream than the encode does.
 */
const SHORT_CLIP_ORIGINAL_MAX_SECONDS = 20;
/**
 * Auto also leaves an original alone when it is bigger than this, whatever its length:
 * Safari decodes ProRes, so a 15 second 4K ProRes source would otherwise download whole.
 */
const AUTO_ORIGINAL_MAX_BYTES = 100 * 1024 * 1024;

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
  progressRef: RefObject<HTMLDivElement | null>;
  playheadRef: RefObject<HTMLDivElement | null>;
  scrubReadoutRef: RefObject<HTMLDivElement | null>;
  hlsRef: RefObject<Hls | null>;
  playerRef: RefObject<YT.Player | PlayerAdapter | null>;
  formatTime: (seconds: number) => string;
  formatBunnyQualityLabel: (level: { height?: number; bitrate?: number }, index: number) => string;
  speedOptions: number[];
  scheduleWatchProgressSaveRef: RefObject<
    (input: { progress: number; duration?: number; immediate?: boolean; force?: boolean }) => void
  >;
  setViewingAnnotation: (strokes: AnnotationStroke[] | null) => void;
  /** Turns subtitles on or off. Lives outside this hook, next to the caption state. */
  toggleCaptionsRef: RefObject<() => void>;
  playbackLocked?: boolean;
  /**
   * Whether Auto may open short clips on the uploaded original. Off where the viewer may
   * not download the project's media: the original as the <video> source is one
   * "Save video as" away from a download.
   */
  autoOriginalAllowed?: boolean;
  /**
   * Where a Bunny version's signed URLs come from. `embedUrl` is the first grant;
   * reloads read the latest one so an expired token can be replaced mid-session.
   */
  bunnySource?: Pick<BunnyPlaybackSource, 'getLatestBaseUrl' | 'refresh'>;
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
  progressRef,
  playheadRef,
  scrubReadoutRef,
  hlsRef,
  playerRef,
  formatTime,
  formatBunnyQualityLabel,
  speedOptions,
  scheduleWatchProgressSaveRef,
  setViewingAnnotation,
  toggleCaptionsRef,
  playbackLocked = false,
  autoOriginalAllowed = false,
  bunnySource,
}: UseVideoPlayerParams) {
  const bunnySourceRef = useRef(bunnySource);
  useEffect(() => {
    bunnySourceRef.current = bunnySource;
  }, [bunnySource]);
  const annotationSeekRef = useRef<number | null>(null);
  const dismissAnnotation = useCallback(() => {
    annotationSeekRef.current = null;
    setViewingAnnotation(null);
  }, [setViewingAnnotation]);
  useEffect(() => {
    dismissAnnotation();
  }, [activeProviderId, activeVersionId, dismissAnnotation]);
  const [isApiLoaded, setIsApiLoaded] = useState(false);
  const [isReady, setIsReady] = useState(false);
  // Bumped every time the YouTube player loads or unloads a module. It is the only
  // signal that `getOption('captions', ...)` will answer, so the captions hook waits
  // on it rather than polling.
  const [youtubeModuleRevision, setYoutubeModuleRevision] = useState(0);
  const [bunnyPlaybackState, setBunnyPlaybackState] = useState<BunnyPlaybackState>('none');
  const [currentTime, setCurrentTime] = useState(0);
  const [durationMeasurement, setDurationMeasurement] = useState<{
    versionId: string | null;
    duration: number;
  }>({ versionId: null, duration: 0 });
  const videoDuration =
    durationMeasurement.versionId === activeVersionId ? durationMeasurement.duration : 0;
  const setVideoDuration = useCallback(
    (duration: number) => setDurationMeasurement({ versionId: activeVersionId, duration }),
    [activeVersionId]
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isFrameMode, setIsFrameMode] = useState(false);
  const [estimatedFrameRate, setEstimatedFrameRate] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const activeDragging = isDragging && !playbackLocked;
  const isDraggingRef = useRef(false);
  const scrubPointerIdRef = useRef<number | null>(null);
  // Scrubbing: the playhead position is driven directly via DOM (rAF) to avoid
  // per-frame React re-renders. These refs feed that loop.
  const dragTimeRef = useRef(0);
  const dragRectRef = useRef<DOMRect | null>(null);
  const durationRef = useRef(0);
  // Live scrubbing: coalesce seeks so we never queue stale ones (keeps HLS
  // responsive). scrubTargetRef is the latest desired time; isSeekingRef is true
  // while a seek is in flight; wasPlayingBeforeScrubRef restores play on release.
  const scrubTargetRef = useRef<number | null>(null);
  const isSeekingRef = useRef(false);
  const wasPlayingBeforeScrubRef = useRef(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [qualityOptions, setQualityOptions] = useState<BunnyQualityOption[]>([]);
  const [selectedQualityLevel, setSelectedQualityLevel] = useState<number>(-1);
  // Read once per mount: the choice is per browser, and React state carries it after that.
  const [storedQualityPreference] = useState(readStoredQualityPreference);
  const [bunnySourcePreference, setBunnySourcePreference] = useState<'auto' | 'original'>(() =>
    storedQualityPreference?.mode === 'original' ? 'original' : 'auto'
  );
  // A remembered rendition, as a height so it carries over to videos with other levels.
  const preferredHeightRef = useRef<number | null>(
    storedQualityPreference?.mode === 'height' ? storedQualityPreference.height : null
  );
  // Which source the <video> is actually playing, which is not the same as the preference:
  // Auto plays the original for short clips, and an original that will not decode falls
  // back to the renditions.
  // A remembered Original only opens the original where the viewer may download the
  // project's media; elsewhere it acts as Auto until Original is picked on this page.
  const [originalPickedHere, setOriginalPickedHere] = useState(false);
  // Bumped to load the original again after it failed for a reason other than decoding.
  const [originalRetryNonce, setOriginalRetryNonce] = useState(0);
  const effectiveSourcePreference: 'auto' | 'original' =
    bunnySourcePreference === 'original' && !autoOriginalAllowed && !originalPickedHere
      ? 'auto'
      : bunnySourcePreference;
  const [activeBunnySource, setActiveBunnySource] = useState<'hls' | 'original'>('hls');
  const [autoPlaysOriginal, setAutoPlaysOriginal] = useState(false);
  const bunnySwitchToHlsRef = useRef<(() => void) | null>(null);
  const pendingHlsQualityRef = useRef<number | null>(null);
  const bunnySourceSwitchResumeRef = useRef<{ time: number; wasPlaying: boolean } | null>(null);
  const previousVersionKeyRef = useRef<string | null>(null);
  const [isBunnyPortraitSource, setIsBunnyPortraitSource] = useState(false);
  const [bunnyPortraitFrameWidth, setBunnyPortraitFrameWidth] = useState<number>(0);
  const { cursorIdle, handleVideoMouseMove, handleVideoMouseLeave } = useCursorIdle(isPlaying);
  const bunnyRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bunnyFrameCallbackIdRef = useRef<number | null>(null);
  const bunnyFrameSampleRef = useRef<{ mediaTime: number; presentedFrames: number } | null>(null);
  const [isFullscreenMode, setIsFullscreenMode] = useState(false);
  const [showComments, setShowComments] = useState(true);
  // Keyboard/button seeks have no drag to key the readout off, so flash it for a
  // moment instead — stepping frame by frame is exactly when the count matters.
  const [isSeekReadoutVisible, setIsSeekReadoutVisible] = useState(false);
  const seekReadoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashSeekReadout = useCallback(() => {
    setIsSeekReadoutVisible(true);
    if (seekReadoutTimerRef.current) clearTimeout(seekReadoutTimerRef.current);
    seekReadoutTimerRef.current = setTimeout(() => setIsSeekReadoutVisible(false), 1200);
  }, []);

  useEffect(() => {
    return () => {
      if (seekReadoutTimerRef.current) clearTimeout(seekReadoutTimerRef.current);
    };
  }, []);

  const frameStepSeconds = useMemo(
    () => getFrameStepSeconds(estimatedFrameRate),
    [estimatedFrameRate]
  );

  const frameStepLabel = useMemo(() => getFrameStepLabel(estimatedFrameRate), [estimatedFrameRate]);

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

      // Samples that straddle a seek compare frames from two different points in
      // the media timeline, so the ratio is meaningless — skip them.
      if (previousSample && !videoEl.seeking) {
        const deltaFrames = metadata.presentedFrames - previousSample.presentedFrames;
        const deltaTime = metadata.mediaTime - previousSample.mediaTime;
        if (deltaFrames > 0 && deltaTime > 0) {
          const nextFrameRate = normalizeFrameRate(deltaFrames / deltaTime);
          if (nextFrameRate !== null) {
            setEstimatedFrameRate(nextFrameRate);
          }
        }
      }

      bunnyFrameCallbackIdRef.current = videoEl.requestVideoFrameCallback(trackFrameRate);
    };

    bunnyFrameCallbackIdRef.current = videoEl.requestVideoFrameCallback(trackFrameRate);
  }, [stopBunnyFrameTracking, videoRef]);

  useEffect(() => {
    isDraggingRef.current = activeDragging;
  }, [activeDragging]);

  useEffect(() => {
    if (!playbackLocked || !isDragging) return;
    isDraggingRef.current = false;
    scrubTargetRef.current = null;
    isSeekingRef.current = false;
    wasPlayingBeforeScrubRef.current = false;
    const timer = setTimeout(() => setIsDragging(false), 0);
    return () => clearTimeout(timer);
  }, [isDragging, playbackLocked]);

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

  useEffect(() => {
    if (activeProviderId !== 'youtube') return;
    if (isApiLoaded) return;

    if (window.YT) {
      setIsApiLoaded(true);
      return;
    }

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    // A document with no <script> is unusual but not impossible, and dereferencing the
    // first one threw on mount when there was none. Next always emits one in the app;
    // appending to <head> covers everything else.
    const firstScriptTag = document.getElementsByTagName('script')[0];
    if (firstScriptTag?.parentNode) {
      firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
    } else {
      document.head.appendChild(tag);
    }

    window.onYouTubeIframeAPIReady = () => {
      setIsApiLoaded(true);
    };
  }, [activeProviderId, isApiLoaded]);

  // Read through a ref: the page saves the measured length back to the version after
  // playback starts, and a dependency on it would rebuild the player mid-playback.
  // Declared before the player effect, so it has run by the time that one reads it.
  const activeVersionDurationRef = useRef<number | null>(null);
  useEffect(() => {
    activeVersionDurationRef.current = activeVersion?.duration ?? null;
  }, [activeVersion?.duration]);
  // Set when the viewer picks a rendition, so a rebuild for it does not land back on Auto's
  // short-clip original when that rendition has no height to remember it by.
  const skipAutoOriginalRef = useRef(false);
  // Whether a chosen original failed to decode for the version on screen, and whether the
  // viewer has been told about such a failure on this page already.
  const originalDecodeFailedRef = useRef(false);
  const originalFailureToastShownRef = useRef(false);

  useEffect(() => {
    if (!canInitializePlayer) return;
    if (!activeProviderId) return;
    const isYoutube = activeProviderId === 'youtube';
    const isBunny = activeProviderId === 'bunny';
    const isR2 = activeProviderId === 'r2';

    if (isYoutube && !isApiLoaded) return;
    if (!isYoutube && !isBunny && !isR2) return;

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
    setSelectedQualityLevel(effectiveSourcePreference === 'original' ? -2 : -1);
    setActiveBunnySource('hls');
    setAutoPlaysOriginal(false);
    bunnySwitchToHlsRef.current = null;
    originalDecodeFailedRef.current = false;
    // A pick waiting for a manifest belongs to the player being torn down.
    pendingHlsQualityRef.current = null;
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
    // A Bunny version has no URL until its signed grant arrives; this effect runs
    // again once it does.
    if (isBunny && !embedUrl) return;

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
            onApiChange: () => {
              setYoutubeModuleRevision((revision) => revision + 1);
            },
            onStateChange: (event: YT.OnStateChangeEvent) => {
              setIsPlaying(event.data === YT.PlayerState.PLAYING);
              if (event.data === YT.PlayerState.PLAYING) dismissAnnotation();

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
        // Chromium now plays HLS natively too, but its own player opens on the lowest
        // rendition and exposes no levels to pick from, so it always gets hls.js. Safari
        // keeps its native player (and AirPlay); browsers without either get the error.
        const useHlsJs = shouldUseHlsJs(Hls.isSupported(), videoEl, navigator);
        // The signed base can be refreshed while this player lives; every reload
        // reads the newest one rather than the URL the player was created with.
        const currentPlaylistUrl = () => {
          const latestBase = bunnySourceRef.current?.getLatestBaseUrl();
          return latestBase ? `${latestBase}playlist.m3u8` : embedUrl;
        };
        const currentOriginalUrl = () => {
          const latestBase = bunnySourceRef.current?.getLatestBaseUrl();
          return latestBase ? `${latestBase}original` : bunnyOriginalUrl;
        };

        let cachedDuration = 0;
        let destroyed = false;
        let retryAttempt = 0;
        let usingHlsJs = false;
        let hlsInstance: Hls | null = null;
        // Auto tries the original for a cut that is short, or whose length we were never
        // told (an upload that did not report it); the metadata settles the length below.
        const autoTriesOriginal =
          effectiveSourcePreference === 'auto' &&
          autoOriginalAllowed &&
          preferredHeightRef.current === null &&
          !skipAutoOriginalRef.current &&
          !!bunnyOriginalUrl &&
          (activeVersionDurationRef.current === null ||
            activeVersionDurationRef.current <= SHORT_CLIP_ORIGINAL_MAX_SECONDS);
        let sourceMode: 'hls' | 'original' =
          effectiveSourcePreference === 'original' || autoTriesOriginal ? 'original' : 'hls';
        // True while the original is playing because it was chosen (by the viewer or by
        // Auto for a short clip), as opposed to Early-Play standing in for a cut that is
        // still encoding. A chosen original that fails falls back to the renditions; the
        // stand-in keeps retrying, because the renditions are not there yet.
        let originalIsChosen = sourceMode === 'original';
        let isAutoOriginal = autoTriesOriginal;
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
          videoEl.src = getRetryUrl(currentPlaylistUrl());
          videoEl.load();
        };
        const retryOriginalLoad = () => {
          if (!bunnyOriginalUrl) return;
          videoEl.src = getRetryUrl(currentOriginalUrl());
          videoEl.load();
        };
        const retryHlsLoad = () => {
          if (destroyed || !hlsInstance) return;
          const retryUrl = getRetryUrl(currentPlaylistUrl());
          try {
            hlsInstance.stopLoad();
          } catch {
            // ignore stop-load failures and continue with a fresh loadSource
          }
          // Loading starts from MANIFEST_PARSED, once the start level is known.
          hlsInstance.loadSource(retryUrl);
        };
        // A CDN token that expires mid-session fails the next segment or range
        // request after playback has started. Fetch a fresh grant and reload the
        // same source where it stopped. Bounded so a source that is broken for
        // another reason still ends up in the error state instead of looping.
        let lastTokenRecoveryAt = 0;
        const recoverWithFreshToken = (): boolean => {
          const source = bunnySourceRef.current;
          if (!source) return false;
          const now = Date.now();
          if (now - lastTokenRecoveryAt < 60 * 1000) return false;
          lastTokenRecoveryAt = now;
          const resumeTime = videoEl.currentTime || 0;
          const wasPlaying = !videoEl.paused;
          setBunnyPlaybackState('processing');
          void source.refresh().then(() => {
            if (destroyed) return;
            // hls.js re-attaches the media on loadSource and forgets any start
            // position passed alongside it, so the resume goes through the same
            // loadedmetadata path a manual source switch uses.
            bunnySourceSwitchResumeRef.current = { time: resumeTime, wasPlaying };
            if (usingHlsJs && sourceMode === 'hls') {
              retryHlsLoad();
              return;
            }
            if (sourceMode === 'original') retryOriginalLoad();
            else retryNativeLoad();
          });
          return true;
        };
        const activateOriginalFallback = (): boolean => {
          if (!bunnyOriginalUrl) return false;
          sourceMode = 'original';
          originalIsChosen = false;
          isAutoOriginal = false;
          setActiveBunnySource('original');
          setAutoPlaysOriginal(false);
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

        // hls.js loads nothing while the original plays, so the Quality menu would list no
        // renditions to step down to. The master playlist is a few hundred bytes.
        let renditionOptionsRequested = false;
        const loadRenditionOptions = () => {
          // Only hls.js can be told which rendition to play; Safari's player picks its own.
          if (renditionOptionsRequested || !useHlsJs) return;
          renditionOptionsRequested = true;
          fetch(currentPlaylistUrl())
            .then((response) => (response.ok ? response.text() : ''))
            .then((text) => {
              if (destroyed || sourceMode !== 'original') return;
              setQualityOptions(
                parseMasterPlaylistLevels(text)
                  .map((level, index) => ({
                    level: index,
                    label: formatBunnyQualityLabel(level, index),
                    height: level.height && level.height > 0 ? level.height : undefined,
                  }))
                  // Bunny lists renditions out of order; hls.js sorts its own levels.
                  .sort((a, b) => (a.height ?? 0) - (b.height ?? 0))
              );
            })
            .catch(() => {
              // The menu keeps Auto and Original; nothing else depends on this list.
            });
        };

        const onLoadedMetadata = () => {
          if (destroyed) return;
          clearRetryTimer();
          if (sourceMode === 'original' && originalIsChosen) {
            // A container the browser opens but whose video track it cannot decode (a
            // ProRes .mov in Chrome, say) reports no picture size and plays sound only.
            const cannotShowPicture = videoEl.videoWidth === 0 || videoEl.videoHeight === 0;
            const tooLongForAuto =
              isAutoOriginal &&
              Number.isFinite(videoEl.duration) &&
              videoEl.duration > SHORT_CLIP_ORIGINAL_MAX_SECONDS;
            if (cannotShowPicture || tooLongForAuto) {
              leaveOriginalForHls(cannotShowPicture ? 'decode' : 'switch');
              return;
            }
          }
          if (sourceMode === 'original') {
            setSelectedQualityLevel(isAutoOriginal ? -1 : -2);
            setAutoPlaysOriginal(isAutoOriginal);
            if (originalIsChosen) loadRenditionOptions();
          }
          setBunnyPlaybackState(
            sourceMode === 'original' && !originalIsChosen ? 'processing' : 'none'
          );
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
          if (sourceMode === 'original' && originalIsChosen) {
            const networkError = videoEl.error?.code === MediaError.MEDIA_ERR_NETWORK;
            // An expired token mid-playback is worth one fresh grant before giving up
            // on the original.
            if (
              networkError &&
              videoEl.readyState >= HTMLMediaElement.HAVE_METADATA &&
              recoverWithFreshToken()
            ) {
              return;
            }
            leaveOriginalForHls(networkError ? 'network' : 'decode');
            return;
          }
          if (videoEl.readyState >= HTMLMediaElement.HAVE_METADATA) {
            // Only a network failure can be an expired token; decode errors are final.
            if (videoEl.error?.code === MediaError.MEDIA_ERR_NETWORK && recoverWithFreshToken())
              return;
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
          // The manifest usually declares FRAME-RATE, which gives us a frame
          // count before playback ever starts; measurement refines it later.
          for (const level of levels) {
            const manifestFrameRate = normalizeFrameRate(level.frameRate);
            if (manifestFrameRate !== null) {
              setEstimatedFrameRate(manifestFrameRate);
              break;
            }
          }

          setQualityOptions(
            levels.map((level, index) => ({
              level: index,
              label: formatBunnyQualityLabel(level, index),
              height: level.height > 0 ? level.height : undefined,
            }))
          );
          const pendingQuality = pendingHlsQualityRef.current;
          pendingHlsQualityRef.current = null;

          let manualLevel = -1;
          if (pendingQuality !== null && pendingQuality >= 0 && pendingQuality < levels.length) {
            manualLevel = pendingQuality;
          } else if (pendingQuality === null && preferredHeightRef.current !== null) {
            manualLevel = findLevelForHeight(levels, preferredHeightRef.current);
          }

          if (!hlsInstance) {
            setSelectedQualityLevel(manualLevel);
            return;
          }

          if (manualLevel >= 0) {
            // loadLevel pins the level without the buffer flush currentLevel does; nothing
            // is buffered yet at this point.
            hlsInstance.startLevel = manualLevel;
            hlsInstance.loadLevel = manualLevel;
          } else {
            // Auto starts on the best rendition and lets ABR step down if the connection
            // cannot keep up. Short review clips often fit in a single segment, so a low
            // opening level would be the only level the viewer ever sees.
            hlsInstance.startLevel = Math.max(0, findTopLevel(levels));
            hlsInstance.loadLevel = -1;
          }
          setSelectedQualityLevel(manualLevel);
          hlsInstance.startLoad(-1);
        };

        const startHlsPlayback = () => {
          sourceMode = 'hls';
          setActiveBunnySource('hls');
          if (useHlsJs) {
            usingHlsJs = true;
            // Loading waits for MANIFEST_PARSED, so the start level is picked before the first
            // fragment rather than left to hls.js's 500 kbps opening guess.
            const hls = new Hls({ autoStartLoad: false });
            hlsInstance = hls;
            hlsRef.current = hls;
            hls.attachMedia(videoEl);

            hls.on(Hls.Events.MEDIA_ATTACHED, () => {
              if (!destroyed) {
                hls.loadSource(currentPlaylistUrl());
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
                // A 403 here is either a video still encoding or a grant that expired
                // before playback started (a tab left open overnight). Ask for a fresh
                // grant; the hook throttles this, and the retries pick it up.
                if (responseCode === 403) void bunnySourceRef.current?.refresh();
                if (activateOriginalFallback()) {
                  return;
                }
                setIsReady(false);
                setBunnyPlaybackState('processing');
                scheduleRetry(retryHlsLoad);
                return;
              }

              if (
                data.fatal &&
                data.type === Hls.ErrorTypes.NETWORK_ERROR &&
                responseCode === 403 &&
                recoverWithFreshToken()
              ) {
                return;
              }

              if (data.fatal) {
                setBunnyPlaybackState('error');
                console.error('Fatal HLS error:', data);
              }
            });
          } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
            videoEl.src = currentPlaylistUrl();
            videoEl.load();
          } else {
            setBunnyPlaybackState('error');
            console.error('HLS is not supported in this browser.');
          }
        };

        const leaveOriginalForHls = (reason: 'decode' | 'network' | 'switch' = 'switch') => {
          if (destroyed || sourceMode !== 'original') return;
          // A decode failure can come after playback started; pick up where it stopped.
          // A switch the viewer asked for has already recorded its own resume point.
          if (
            !bunnySourceSwitchResumeRef.current &&
            videoEl.readyState >= HTMLMediaElement.HAVE_METADATA &&
            videoEl.currentTime > 0
          ) {
            bunnySourceSwitchResumeRef.current = {
              time: videoEl.currentTime,
              wasPlaying: !videoEl.paused,
            };
          }
          if (reason === 'decode' && originalIsChosen && !isAutoOriginal) {
            originalDecodeFailedRef.current = true;
            // Once per page: a remembered Original that never decodes here (ProRes in
            // Chrome, say) would otherwise repeat this on every video.
            if (!originalFailureToastShownRef.current) {
              originalFailureToastShownRef.current = true;
              toast.info(
                "This browser can't play the original file, so the best encoded version is playing instead."
              );
            }
          }
          originalIsChosen = false;
          isAutoOriginal = false;
          clearRetryTimer();
          setAutoPlaysOriginal(false);
          setIsReady(false);
          videoEl.removeAttribute('src');
          videoEl.load();
          startHlsPlayback();
        };
        bunnySwitchToHlsRef.current = leaveOriginalForHls;

        // Auto checks the size first: the length alone says nothing about a 4K ProRes
        // source, and Bunny exposes Content-Length to cross-origin requests.
        const startAutoOriginal = () => {
          fetch(currentOriginalUrl(), { method: 'HEAD' })
            .then((response) =>
              response.ok ? Number(response.headers.get('content-length')) : NaN
            )
            .catch(() => NaN)
            .then((size) => {
              if (destroyed || sourceMode !== 'original') return;
              // The viewer may have picked a rendition while the size was being checked.
              const renditionPicked =
                skipAutoOriginalRef.current ||
                preferredHeightRef.current !== null ||
                (pendingHlsQualityRef.current ?? -1) >= 0;
              if (renditionPicked || !(size > 0) || size > AUTO_ORIGINAL_MAX_BYTES) {
                originalIsChosen = false;
                isAutoOriginal = false;
                startHlsPlayback();
                return;
              }
              setActiveBunnySource('original');
              retryOriginalLoad();
            });
        };

        if (sourceMode === 'original' && bunnyOriginalUrl) {
          if (isAutoOriginal) {
            startAutoOriginal();
          } else {
            setActiveBunnySource('original');
            retryOriginalLoad();
          }
        } else {
          startHlsPlayback();
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
      } else if (isR2) {
        const videoEl = videoRef.current;
        if (!videoEl) return;

        let cachedDuration = 0;
        let destroyed = false;

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
          setBunnyPlaybackState('none');
          if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
            setIsBunnyPortraitSource(videoEl.videoHeight > videoEl.videoWidth);
          }
          setIsReady(true);
          syncDuration();
          if (!videoEl.paused) {
            startBunnyFrameTracking();
          }
        };

        const onPlay = () => {
          setIsPlaying(true);
          setBunnyPlaybackState('none');
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
          syncDuration();
        };

        const onVideoError = () => {
          if (destroyed) return;
          setBunnyPlaybackState('error');
        };

        videoEl.addEventListener('loadedmetadata', onLoadedMetadata);
        videoEl.addEventListener('play', onPlay);
        videoEl.addEventListener('pause', onPause);
        videoEl.addEventListener('ended', onEnded);
        videoEl.addEventListener('timeupdate', onTimeUpdate);
        videoEl.addEventListener('error', onVideoError);

        const playbackSrc =
          embedUrl.startsWith('/') && typeof window !== 'undefined'
            ? `${window.location.origin}${embedUrl}`
            : embedUrl;
        videoEl.src = playbackSrc;
        videoEl.load();

        playerRef.current = {
          playVideo: () => {
            videoEl.play().catch((err) => console.error('Error playing video:', err));
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
            stopBunnyFrameTracking();
            videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
            videoEl.removeEventListener('play', onPlay);
            videoEl.removeEventListener('pause', onPause);
            videoEl.removeEventListener('ended', onEnded);
            videoEl.removeEventListener('timeupdate', onTimeUpdate);
            videoEl.removeEventListener('error', onVideoError);
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
      } else if (isBunny || isR2) {
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
    effectiveSourcePreference,
    originalRetryNonce,
    autoOriginalAllowed,
    hlsRef,
    iframeRef,
    playerRef,
    scheduleWatchProgressSaveRef,
    setVideoDuration,
    startBunnyFrameTracking,
    stopBunnyFrameTracking,
    videoRef,
    dismissAnnotation,
  ]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      // iPhone Safari has no element fullscreen, only the native player's own
      // fullscreen on a <video>. It hides our overlays, but it is the only way
      // there to fill the screen.
      if (typeof document.documentElement.requestFullscreen !== 'function') {
        const videoEl = videoRef.current as
          | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
          | null;
        if (videoEl && typeof videoEl.webkitEnterFullscreen === 'function') {
          videoEl.webkitEnterFullscreen();
        } else {
          toast.error('Fullscreen is not supported in this browser');
        }
        return;
      }
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
  }, [videoRef]);

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
      if (!activeDragging && playerRef.current) {
        if (playerRef.current.getCurrentTime) {
          setCurrentTime(playerRef.current.getCurrentTime());
        }
      }
    }, 250);

    return () => clearInterval(interval);
  }, [isReady, activeDragging, activeVersion?.providerId, playerRef]);

  const duration = useMemo(() => {
    return videoDuration || activeVersion?.duration || 0;
  }, [videoDuration, activeVersion?.duration]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  // Read through a ref so the rAF loop below is not torn down and rebuilt every
  // time the measured frame rate is re-published.
  const frameRateRef = useRef<number | null>(null);
  useEffect(() => {
    frameRateRef.current = estimatedFrameRate;
  }, [estimatedFrameRate]);

  // Position the progress fill + playhead + scrub readout directly on the DOM
  // (no React state / re-render) so scrubbing and playback stay smooth at the
  // display's refresh rate instead of stepping ~4x/sec.
  const applyPlayhead = useCallback(
    (time: number) => {
      const d = durationRef.current;
      const percent = getPlayheadPercent(time, d);
      if (progressRef.current) progressRef.current.style.width = `${percent}%`;
      if (playheadRef.current) playheadRef.current.style.left = `calc(${percent}% - 2px)`;

      const readoutEl = scrubReadoutRef.current;
      if (readoutEl) {
        // Clamp in CSS rather than JS so the badge stays inside the timeline at
        // either end without measuring it on every frame.
        readoutEl.style.left = `clamp(3rem, ${percent}%, calc(100% - 3rem))`;
        const rate = frameRateRef.current;
        if (rate === null) {
          readoutEl.textContent = formatTime(time);
        } else {
          readoutEl.textContent = `${formatTime(time)} · f${getFrameIndexAtTime(time, rate, d)}`;
        }
      }
    },
    [progressRef, playheadRef, scrubReadoutRef, formatTime]
  );

  // Live-preview seek for the HTML5 video element (Bunny/R2/direct). Coalesced:
  // only one seek is in flight at a time; the newest target is chased on
  // 'seeked' so we stay responsive without flooding hls.js with stale seeks.
  const requestScrubSeek = useCallback(
    (time: number) => {
      const videoEl = videoRef.current;
      if (!videoEl) return; // YouTube (iframe) keeps seek-on-release only
      scrubTargetRef.current = time;
      if (isSeekingRef.current) return;
      isSeekingRef.current = true;
      try {
        videoEl.currentTime = time;
      } catch {
        isSeekingRef.current = false;
      }
    },
    [videoRef]
  );

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    const onSeeked = () => {
      const target = scrubTargetRef.current;
      if (
        isDraggingRef.current &&
        target !== null &&
        Math.abs(videoEl.currentTime - target) > 0.04
      ) {
        try {
          videoEl.currentTime = target; // chase the latest scrub position
        } catch {
          isSeekingRef.current = false;
        }
      } else {
        isSeekingRef.current = false;
      }
    };
    videoEl.addEventListener('seeked', onSeeked);
    return () => videoEl.removeEventListener('seeked', onSeeked);
  }, [videoRef, isReady, activeProviderId]);

  // While playing (live time) or dragging (cursor position), drive the playhead
  // from a requestAnimationFrame loop for 60fps-smooth motion. During a drag we
  // also request a (coalesced) seek so the frame previews live like an editor.
  useEffect(() => {
    if (!isPlaying && !activeDragging) return;
    let raf = 0;
    const tick = () => {
      if (isDraggingRef.current) {
        applyPlayhead(dragTimeRef.current);
        requestScrubSeek(dragTimeRef.current);
      } else if (playerRef.current?.getCurrentTime) {
        applyPlayhead(playerRef.current.getCurrentTime());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, activeDragging, applyPlayhead, requestScrubSeek, playerRef]);

  // When idle (paused, not dragging), keep the playhead in sync with seeks and
  // comment jumps. useLayoutEffect avoids a one-frame flash on mount/seek.
  useLayoutEffect(() => {
    if (isPlaying || activeDragging) return;
    applyPlayhead(currentTime);
  }, [currentTime, isPlaying, activeDragging, applyPlayhead]);

  const resolveSkipAmount = useCallback(
    (seconds: number) => resolveSkipAmountFor(seconds, { isFrameMode, frameStepSeconds }),
    [frameStepSeconds, isFrameMode]
  );

  const handleFrameModeToggle = useCallback(() => {
    setIsFrameMode((prev) => !prev);
  }, []);

  const handlePlayPause = useCallback(() => {
    if (playbackLocked) return;
    if (!playerRef.current) return;
    if (isPlaying) {
      playerRef.current.pauseVideo();
    } else {
      dismissAnnotation();
      playerRef.current.playVideo();
    }
  }, [isPlaying, playbackLocked, playerRef, dismissAnnotation]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onSeeking = () => {
      const annotationTime = annotationSeekRef.current;
      annotationSeekRef.current = null;
      if (annotationTime !== null && Math.abs(video.currentTime - annotationTime) < 0.05) return;
      dismissAnnotation();
    };
    // Media events also cover playback and seeks applied by the live presenter.
    video.addEventListener('play', dismissAnnotation);
    video.addEventListener('seeking', onSeeking);
    return () => {
      video.removeEventListener('play', dismissAnnotation);
      video.removeEventListener('seeking', onSeeking);
    };
  }, [videoRef, isReady, activeVersionId, dismissAnnotation]);

  const handleSeekToTimestamp = useCallback(
    (
      timestamp: number,
      annotation?: string | null,
      options?: { pauseAfterSeek?: boolean; timestampEnd?: number | null }
    ) => {
      if (playbackLocked) return;
      // Keep the preview through its own asynchronous media seek, but not later seeks.
      annotationSeekRef.current = annotation ? timestamp : null;
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
        const shouldPauseAfterSeek = !!annotation || options?.pauseAfterSeek || hasRangeEnd;

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
    [isPlaying, playbackLocked, playerRef, setViewingAnnotation]
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
      if (playbackLocked) return;
      const newTime = clampSeekTime(currentTime + resolveSkipAmount(seconds), duration);
      handleSeekToTimestamp(newTime);
      flashSeekReadout();
    },
    [
      currentTime,
      duration,
      flashSeekReadout,
      handleSeekToTimestamp,
      playbackLocked,
      resolveSkipAmount,
    ]
  );

  useEffect(() => {
    if (activeProviderId === 'r2-image') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('[data-slot="dialog-content"]')) {
        return;
      }

      if (isTypingTarget(e.target as HTMLElement)) {
        return;
      }

      const shortcut = resolvePlayerShortcut(e);
      if (shortcut === null) return;
      e.preventDefault();
      // Mute, fullscreen and subtitles only change what this viewer sees and hears, so
      // they stay available while someone else is driving playback.
      if (
        playbackLocked &&
        shortcut !== 'toggle-mute' &&
        shortcut !== 'toggle-fullscreen' &&
        shortcut !== 'toggle-captions'
      ) {
        return;
      }

      const stepPlaybackSpeed = (direction: 1 | -1) => {
        const newSpeed = getAdjacentPlaybackSpeed(speedOptions, playbackSpeed, direction);
        if (newSpeed === null) return;
        setPlaybackSpeed(newSpeed);
        playerRef.current?.setPlaybackRate(newSpeed);
      };

      switch (shortcut) {
        case 'toggle-play':
          handlePlayPause();
          break;
        case 'skip-back':
          handleSkip(-5);
          break;
        case 'skip-forward':
          handleSkip(5);
          break;
        case 'speed-up':
          stepPlaybackSpeed(1);
          break;
        case 'speed-down':
          stepPlaybackSpeed(-1);
          break;
        case 'toggle-mute':
          if (playerRef.current) {
            if (isMuted) {
              playerRef.current.unMute();
            } else {
              playerRef.current.mute();
            }
            setIsMuted(!isMuted);
          }
          break;
        case 'jump-back':
          if (playerRef.current?.seekTo) {
            dismissAnnotation();
            const newTime = Math.max(0, currentTime - 10);
            playerRef.current.seekTo(newTime, true);
            setCurrentTime(newTime);
            flashSeekReadout();
          }
          break;
        case 'jump-forward':
          if (playerRef.current?.seekTo) {
            dismissAnnotation();
            const newTime = Math.min(duration, currentTime + 10);
            playerRef.current.seekTo(newTime, true);
            setCurrentTime(newTime);
            flashSeekReadout();
          }
          break;
        case 'toggle-fullscreen':
          toggleFullscreen();
          break;
        case 'toggle-captions':
          toggleCaptionsRef.current();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    activeProviderId,
    isPlaying,
    currentTime,
    duration,
    isMuted,
    playbackSpeed,
    speedOptions,
    flashSeekReadout,
    handleSkip,
    toggleFullscreen,
    toggleCaptionsRef,
    playerRef,
    playbackLocked,
    handlePlayPause,
    dismissAnnotation,
  ]);

  const handleSpeedChange = useCallback(
    (speed: number) => {
      if (playbackLocked) return;
      setPlaybackSpeed(speed);
      playerRef.current?.setPlaybackRate(speed);
    },
    [playbackLocked, playerRef]
  );

  const handleQualityChange = useCallback(
    (level: number) => {
      const captureResumePoint = () => {
        const fallbackCurrentTime = videoRef.current?.currentTime ?? 0;
        const current = playerRef.current?.getCurrentTime?.() ?? fallbackCurrentTime;
        bunnySourceSwitchResumeRef.current = {
          time: Number.isFinite(current) ? Math.max(0, current) : 0,
          wasPlaying: isPlaying,
        };
      };
      const isBunny = activeProviderId === 'bunny';
      const onOriginal = isBunny && activeBunnySource === 'original';
      // Indices only mean something to the list they came from: the hls.js levels while
      // HLS plays, the parsed master playlist while the original plays. Heights carry over.
      pendingHlsQualityRef.current = null;

      if (level === -2) {
        writeStoredQualityPreference({ mode: 'original' });
        setOriginalPickedHere(true);
        preferredHeightRef.current = null;
        skipAutoOriginalRef.current = false;
        if (effectiveSourcePreference === 'original') {
          // playerRef is empty for the moment a rebuild is pending; a second click then
          // would only overwrite the resume point the first one recorded.
          if (isBunny && !onOriginal && playerRef.current) {
            if (originalDecodeFailedRef.current) {
              toast.info("This browser can't play the original file of this video.");
            } else {
              // It fell back for a network reason; try it again.
              captureResumePoint();
              setSelectedQualityLevel(-2);
              setOriginalRetryNonce((nonce) => nonce + 1);
            }
          }
          return;
        }
        if (isBunny) captureResumePoint();
        setBunnySourcePreference('original');
        setSelectedQualityLevel(-2);
        return;
      }

      if (level === -1) {
        writeStoredQualityPreference({ mode: 'auto' });
        preferredHeightRef.current = null;
        skipAutoOriginalRef.current = false;
      } else {
        const height = qualityOptions.find((option) => option.level === level)?.height ?? null;
        if (height) writeStoredQualityPreference({ mode: 'height', height });
        preferredHeightRef.current = height;
        skipAutoOriginalRef.current = true;
      }

      if (effectiveSourcePreference === 'original') {
        // The player rebuilds for the new preference: a rendition is found again by its
        // height, and Auto decides between the original and the renditions again.
        if (isBunny) captureResumePoint();
        setBunnySourcePreference('auto');
        setSelectedQualityLevel(level);
        return;
      }

      if (onOriginal) {
        // Auto is already playing the original for a short clip; Auto again is a no-op.
        if (level === -1) return;
        captureResumePoint();
        setSelectedQualityLevel(level);
        bunnySwitchToHlsRef.current?.();
        return;
      }

      const hls = hlsRef.current;
      if (!hls) {
        // hls.js has not parsed the manifest yet (or this is native HLS); the level is
        // applied when MANIFEST_PARSED arrives.
        pendingHlsQualityRef.current = level;
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
    [
      activeBunnySource,
      activeProviderId,
      effectiveSourcePreference,
      hlsRef,
      isPlaying,
      playerRef,
      qualityOptions,
      videoRef,
    ]
  );

  // Convert a clientX into a time using the timeline rect captured at drag start
  // (avoids a layout read on every move).
  const timeFromClientX = useCallback((clientX: number) => {
    return timeFromClientXWithin(clientX, dragRectRef.current, durationRef.current);
  }, []);

  const handleTimelinePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (playbackLocked) return;
      if (!timelineRef.current) return;
      // A secondary mouse button should not start a scrub; touch and pen report 0.
      if (e.button !== 0) return;
      // A second finger landing on the bar mid-drag must not restart the scrub.
      if (isDraggingRef.current) return;
      scrubPointerIdRef.current = e.pointerId;
      dismissAnnotation();
      // Cache the rect once for the whole drag; the rAF loop reads dragTimeRef.
      dragRectRef.current = timelineRef.current.getBoundingClientRect();
      const newTime = timeFromClientX(e.clientX);
      dragTimeRef.current = newTime;
      // Freeze playback while scrubbing so the previewed frames don't fight the
      // player; resume on release if it was playing.
      wasPlayingBeforeScrubRef.current = isPlaying;
      if (isPlaying) playerRef.current?.pauseVideo?.();
      setIsDragging(true);
      applyPlayhead(newTime);
      setCurrentTime(newTime);
      requestScrubSeek(newTime);
    },
    [
      applyPlayhead,
      requestScrubSeek,
      timeFromClientX,
      timelineRef,
      isPlaying,
      playbackLocked,
      playerRef,
      dismissAnnotation,
    ]
  );

  const handleTimelinePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (playbackLocked) return;
      if (!isDraggingRef.current || e.pointerId !== scrubPointerIdRef.current) return;
      const newTime = timeFromClientX(e.clientX);
      dragTimeRef.current = newTime;
      setCurrentTime(newTime);
    },
    [playbackLocked, timeFromClientX]
  );

  // Commit the final scrub position and restore playback if needed.
  const endScrub = useCallback(() => {
    if (!isDraggingRef.current) return;
    if (playbackLocked) {
      setIsDragging(false);
      wasPlayingBeforeScrubRef.current = false;
      return;
    }
    setIsDragging(false);
    const finalTime = dragTimeRef.current;
    setCurrentTime(finalTime);
    const videoEl = videoRef.current;
    if (videoEl) {
      try {
        videoEl.currentTime = finalTime;
      } catch {
        // ignore
      }
    } else {
      playerRef.current?.seekTo?.(finalTime, true);
    }
    if (wasPlayingBeforeScrubRef.current) {
      playerRef.current?.playVideo?.();
      wasPlayingBeforeScrubRef.current = false;
    }
  }, [playbackLocked, playerRef, videoRef]);

  const handleTimelinePointerUp = useCallback(() => {
    endScrub();
  }, [endScrub]);

  // While dragging, track the pointer anywhere on the page (not just over the
  // timeline) so a fast or off-bar drag keeps scrubbing smoothly, and release
  // anywhere to commit the seek. Pointer events cover mouse, touch and pen alike;
  // a cancelled touch (the browser taking over the gesture) commits like a release.
  useEffect(() => {
    if (!activeDragging) return;
    // Only the pointer that started the scrub drives it: a second finger on the
    // video must neither move the playhead nor end the drag.
    const isScrubPointer = (e: PointerEvent) => e.pointerId === scrubPointerIdRef.current;
    const onMove = (e: PointerEvent) => {
      if (playbackLocked || !isScrubPointer(e)) return;
      const newTime = timeFromClientX(e.clientX);
      dragTimeRef.current = newTime;
      setCurrentTime(newTime);
    };
    const onEnd = (e: PointerEvent) => {
      if (isScrubPointer(e)) endScrub();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
  }, [activeDragging, playbackLocked, timeFromClientX, endScrub]);

  return {
    isReady,
    youtubeModuleRevision,
    bunnyPlaybackState,
    currentTime,
    setCurrentTime,
    videoDuration,
    durationVersionId: durationMeasurement.versionId,
    setVideoDuration,
    isPlaying,
    isMuted,
    isFrameMode,
    frameStepSeconds,
    frameStepLabel,
    isDragging: activeDragging,
    showScrubReadout: activeDragging || isSeekReadoutVisible,
    playbackSpeed,
    qualityOptions,
    selectedQualityLevel,
    autoPlaysOriginal,
    isBunnyPortraitSource,
    bunnyPortraitFrameWidth,
    cursorIdle,
    isFullscreenMode,
    showComments,
    setShowComments,
    handleVideoMouseMove,
    handleVideoMouseLeave,
    handlePlayPause,
    handleSeekToTimestamp,
    handleMuteToggle,
    handleFrameModeToggle,
    handleSkip,
    handleSpeedChange,
    handleQualityChange,
    handleTimelinePointerDown,
    handleTimelinePointerMove,
    handleTimelinePointerUp,
    toggleFullscreen,
  };
}
