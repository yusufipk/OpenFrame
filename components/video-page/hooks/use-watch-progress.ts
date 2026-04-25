'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerAdapter, WatchProgressConfig } from '@/components/video-page/types';

interface UseWatchProgressParams extends WatchProgressConfig {
  playerRef: RefObject<YT.Player | PlayerAdapter | null>;
  isReady: boolean;
  currentTime: number;
  videoDuration: number;
}

export function useWatchProgress({
  videoId,
  activeVersionId,
  isAuthenticated,
  pathname,
  playerRef,
  isReady,
  currentTime,
  videoDuration,
}: UseWatchProgressParams) {
  const [savedProgress, setSavedProgress] = useState<number | null>(null);
  const [showResumePrompt, setShowResumePrompt] = useState(false);
  const [progressFetchKey, setProgressFetchKey] = useState(0);

  const videoDurationRef = useRef(0);
  const progressSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressWriteInFlightRef = useRef(false);
  const pendingProgressPayloadRef = useRef<{
    progress: number;
    duration: number;
    force: boolean;
  } | null>(null);
  const lastSavedProgressRef = useRef<number>(0);
  const lastPathnameRef = useRef<string>(pathname);

  const flushScheduledWatchProgress = useCallback(async () => {
    if (!isAuthenticated || !activeVersionId || progressWriteInFlightRef.current) return;

    const nextPayload = pendingProgressPayloadRef.current;
    if (!nextPayload) return;

    if (!nextPayload.force && Math.abs(nextPayload.progress - lastSavedProgressRef.current) < 2) {
      pendingProgressPayloadRef.current = null;
      return;
    }

    pendingProgressPayloadRef.current = null;
    progressWriteInFlightRef.current = true;

    try {
      const response = await fetch(`/api/watch/${videoId}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          progress: nextPayload.progress,
          duration: nextPayload.duration,
          versionId: activeVersionId,
        }),
      });
      if (response.ok) {
        lastSavedProgressRef.current = nextPayload.progress;
      }
    } catch (err) {
      console.error('Error saving watch progress:', err);
    } finally {
      progressWriteInFlightRef.current = false;
      if (pendingProgressPayloadRef.current) {
        void flushScheduledWatchProgress();
      }
    }
  }, [isAuthenticated, activeVersionId, videoId]);

  const scheduleWatchProgressSave = useCallback(
    (input: { progress: number; duration?: number; immediate?: boolean; force?: boolean }) => {
      if (!isAuthenticated || !activeVersionId) return;

      const progress = Math.max(0, input.progress);
      if (progress <= 0) return;

      const duration = Math.max(0, input.duration ?? videoDurationRef.current ?? 0);
      const force = input.force ?? false;

      if (!force && Math.abs(progress - lastSavedProgressRef.current) < 2) {
        return;
      }

      const existingPayload = pendingProgressPayloadRef.current;
      pendingProgressPayloadRef.current = existingPayload
        ? {
            progress: Math.max(existingPayload.progress, progress),
            duration: Math.max(existingPayload.duration, duration),
            force: existingPayload.force || force,
          }
        : { progress, duration, force };

      if (input.immediate) {
        if (progressDebounceTimerRef.current) {
          clearTimeout(progressDebounceTimerRef.current);
          progressDebounceTimerRef.current = null;
        }
        void flushScheduledWatchProgress();
        return;
      }

      if (progressDebounceTimerRef.current) {
        clearTimeout(progressDebounceTimerRef.current);
      }

      progressDebounceTimerRef.current = setTimeout(() => {
        progressDebounceTimerRef.current = null;
        void flushScheduledWatchProgress();
      }, 800);
    },
    [isAuthenticated, activeVersionId, flushScheduledWatchProgress]
  );

  useEffect(() => {
    return () => {
      if (progressDebounceTimerRef.current) {
        clearTimeout(progressDebounceTimerRef.current);
        progressDebounceTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    videoDurationRef.current = videoDuration;
  }, [videoDuration]);

  useEffect(() => {
    lastSavedProgressRef.current = 0;
    pendingProgressPayloadRef.current = null;
    progressWriteInFlightRef.current = false;
    if (progressDebounceTimerRef.current) {
      clearTimeout(progressDebounceTimerRef.current);
      progressDebounceTimerRef.current = null;
    }
  }, [videoId, activeVersionId]);

  const loadWatchProgress = useCallback(
    async (showPrompt = true) => {
      if (!isAuthenticated || !activeVersionId) return;

      setSavedProgress(null);
      setShowResumePrompt(false);

      try {
        const res = await fetch(`/api/watch/${videoId}/progress`, { cache: 'no-store' });
        if (res.ok) {
          const response = await res.json();
          const progress = response.data?.progress || 0;
          const percentage = response.data?.percentage || 0;

          if (showPrompt && percentage > 5 && percentage < 95) {
            setSavedProgress(progress);
            setShowResumePrompt(true);
          }
        }
      } catch (err) {
        console.error('Error loading watch progress:', err);
      }
    },
    [isAuthenticated, activeVersionId, videoId]
  );

  useEffect(() => {
    loadWatchProgress();
  }, [loadWatchProgress, progressFetchKey]);

  useEffect(() => {
    if (lastPathnameRef.current !== pathname) {
      const previousPath = lastPathnameRef.current;
      lastPathnameRef.current = pathname;

      if (previousPath !== pathname) {
        setProgressFetchKey((k) => k + 1);
      }
    }
  }, [pathname]);

  useEffect(() => {
    if (!isAuthenticated || !isReady || !activeVersionId) return;

    progressSaveTimerRef.current = setInterval(() => {
      if (playerRef.current?.getCurrentTime) {
        scheduleWatchProgressSave({
          progress: playerRef.current.getCurrentTime(),
          duration: playerRef.current.getDuration?.() || videoDuration,
        });
      }
    }, 5000);

    return () => {
      if (progressSaveTimerRef.current) {
        clearInterval(progressSaveTimerRef.current);
        progressSaveTimerRef.current = null;
      }
    };
  }, [
    isAuthenticated,
    isReady,
    videoDuration,
    activeVersionId,
    scheduleWatchProgressSave,
    playerRef,
  ]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const saveProgressOnLeave = () => {
      const playerCurrentTime = playerRef.current?.getCurrentTime?.() || currentTime;
      const playerDuration = playerRef.current?.getDuration?.() || videoDuration;
      const pendingPayload = pendingProgressPayloadRef.current;
      const finalProgress = Math.max(playerCurrentTime, pendingPayload?.progress ?? 0);
      const finalDuration = Math.max(playerDuration, pendingPayload?.duration ?? 0);

      if (finalProgress > 0 && navigator.sendBeacon && activeVersionId) {
        if (progressDebounceTimerRef.current) {
          clearTimeout(progressDebounceTimerRef.current);
          progressDebounceTimerRef.current = null;
        }
        const data = new Blob(
          [
            JSON.stringify({
              progress: finalProgress,
              duration: finalDuration,
              versionId: activeVersionId,
            }),
          ],
          { type: 'application/json' }
        );
        navigator.sendBeacon(`/api/watch/${videoId}/progress`, data);
      }
    };

    const handleVisibilityChange = () => {
      const playerCurrentTime = playerRef.current?.getCurrentTime?.() || 0;
      const playerDuration = playerRef.current?.getDuration?.() || videoDuration;

      if (document.visibilityState === 'hidden') {
        scheduleWatchProgressSave({
          progress: playerCurrentTime,
          duration: playerDuration,
          immediate: true,
          force: true,
        });
      }
    };

    window.addEventListener('beforeunload', saveProgressOnLeave);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', saveProgressOnLeave);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [
    isAuthenticated,
    currentTime,
    videoDuration,
    activeVersionId,
    videoId,
    scheduleWatchProgressSave,
    playerRef,
  ]);

  const handleResumeFromSaved = useCallback(() => {
    if (savedProgress !== null && playerRef.current) {
      if (playerRef.current.seekTo) {
        playerRef.current.seekTo(savedProgress, true);
      }
      setShowResumePrompt(false);
      setSavedProgress(null);
      return savedProgress;
    }
    return null;
  }, [savedProgress, playerRef]);

  const handleDismissResume = useCallback(() => {
    setShowResumePrompt(false);
    setSavedProgress(null);
  }, []);

  return {
    savedProgress,
    showResumePrompt,
    scheduleWatchProgressSave,
    loadWatchProgress,
    handleResumeFromSaved,
    handleDismissResume,
  };
}
