'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { downloadAudioAsWav } from '@/lib/client/download-file';

export function useCommentMedia() {
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [voiceProgress, setVoiceProgress] = useState(0);
  const [voiceCurrentTime, setVoiceCurrentTime] = useState(0);
  const [voicePlaybackRate, setVoicePlaybackRate] = useState(1);
  // A set, not a single id: two downloads can be in flight at once, and one
  // finishing must not clear the other's spinner and re-enable its button.
  const [downloadingVoiceIds, setDownloadingVoiceIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const voiceRafRef = useRef<number | null>(null);
  const voiceKnownDurationRef = useRef<number>(0);

  const stopVoiceTracking = useCallback(() => {
    if (voiceRafRef.current) {
      cancelAnimationFrame(voiceRafRef.current);
      voiceRafRef.current = null;
    }
  }, []);

  const startVoiceTracking = useCallback(() => {
    stopVoiceTracking();
    const tick = () => {
      const audio = audioPlayerRef.current;
      if (audio) {
        const dur =
          isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : voiceKnownDurationRef.current;
        if (dur > 0) {
          setVoiceProgress((audio.currentTime / dur) * 100);
          setVoiceCurrentTime(audio.currentTime);
        }
      }
      voiceRafRef.current = requestAnimationFrame(tick);
    };
    voiceRafRef.current = requestAnimationFrame(tick);
  }, [stopVoiceTracking]);

  const playVoice = useCallback(
    (commentId: string, voiceUrl: string, knownDuration?: number) => {
      if (playingVoiceId === commentId) {
        if (audioPlayerRef.current) {
          audioPlayerRef.current.pause();
          audioPlayerRef.current = null;
        }
        stopVoiceTracking();
        setPlayingVoiceId(null);
        setVoiceProgress(0);
        setVoiceCurrentTime(0);
        return;
      }

      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
      }
      stopVoiceTracking();

      voiceKnownDurationRef.current = knownDuration || 0;
      const audio = new Audio(voiceUrl);
      audio.playbackRate = voicePlaybackRate;
      audioPlayerRef.current = audio;
      setPlayingVoiceId(commentId);
      setVoiceProgress(0);
      setVoiceCurrentTime(0);

      audio.onplay = () => {
        startVoiceTracking();
      };

      audio.onended = () => {
        stopVoiceTracking();
        setPlayingVoiceId(null);
        setVoiceProgress(0);
        setVoiceCurrentTime(0);
        audioPlayerRef.current = null;
      };

      audio.onerror = () => {
        stopVoiceTracking();
        setPlayingVoiceId(null);
        setVoiceProgress(0);
        setVoiceCurrentTime(0);
        audioPlayerRef.current = null;
      };

      void audio.play();
    },
    [playingVoiceId, voicePlaybackRate, startVoiceTracking, stopVoiceTracking]
  );

  const stopVoice = useCallback(() => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current = null;
    }
    stopVoiceTracking();
    setPlayingVoiceId(null);
    setVoiceProgress(0);
    setVoiceCurrentTime(0);
  }, [stopVoiceTracking]);

  const toggleVoiceSpeed = useCallback(() => {
    setVoicePlaybackRate((prev) => {
      const next = prev === 1 ? 2 : 1;
      if (audioPlayerRef.current) {
        audioPlayerRef.current.playbackRate = next;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
        audioPlayerRef.current = null;
      }
      stopVoiceTracking();
    };
  }, [stopVoiceTracking]);

  /**
   * Voice notes are stored the way MediaRecorder wrote them, and an editor
   * cannot import WebM/Opus. Hand over a WAV instead, converted in the browser
   * from the file it already knows how to decode.
   */
  const downloadVoice = useCallback(
    async (commentId: string, voiceUrl: string, baseName: string) => {
      setDownloadingVoiceIds((prev) => new Set(prev).add(commentId));
      try {
        const result = await downloadAudioAsWav(voiceUrl, baseName);
        if (result === 'failed') {
          toast.error('Failed to download voice note');
        } else if (result === 'conversion-unsupported') {
          toast.warning('This browser cannot convert the recording. Downloaded the original.');
        }
      } finally {
        setDownloadingVoiceIds((prev) => {
          const next = new Set(prev);
          next.delete(commentId);
          return next;
        });
      }
    },
    []
  );

  return {
    playingVoiceId,
    voiceProgress,
    voiceCurrentTime,
    voicePlaybackRate,
    downloadingVoiceIds,
    playVoice,
    stopVoice,
    toggleVoiceSpeed,
    downloadVoice,
  };
}
