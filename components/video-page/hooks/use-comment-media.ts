'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export function useCommentMedia() {
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [voiceProgress, setVoiceProgress] = useState(0);
  const [voiceCurrentTime, setVoiceCurrentTime] = useState(0);
  const [voicePlaybackRate, setVoicePlaybackRate] = useState(1);

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

  return {
    playingVoiceId,
    voiceProgress,
    voiceCurrentTime,
    voicePlaybackRate,
    playVoice,
    stopVoice,
    toggleVoiceSpeed,
  };
}
