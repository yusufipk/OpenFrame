'use client';

import { useEffect, useRef, useState } from 'react';
import { VIDEO_PRESENCE_POLL_MS, type VideoPresenceParticipant } from '@/lib/video-presence-types';

export type PresenceStatus = 'connecting' | 'connected' | 'unavailable';

export function useVideoPresence({
  videoId,
  enabled,
  isPlaying,
}: {
  videoId: string;
  enabled: boolean;
  isPlaying: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{
    videoId: string;
    participants: VideoPresenceParticipant[];
    status: PresenceStatus;
  }>({ videoId: '', participants: [], status: 'connecting' });
  const playingRef = useRef(isPlaying);
  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    playingRef.current = isPlaying;
    refreshRef.current?.();
  }, [isPlaying]);

  useEffect(() => {
    if (!enabled) return;
    let clientId = crypto.randomUUID();
    const endpoint = `/api/videos/${videoId}/presence`;
    let stopped = false;
    let suspended = false;
    let forbidden = false;
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<void> | null = null;

    const sendLeave = (leavingClientId = clientId) => {
      void fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: leavingClientId, action: 'leave', isPlaying: false }),
        keepalive: true,
      })
        .then((response) => response.json())
        .catch(() => {});
    };

    const refresh = () => {
      if (stopped || suspended || forbidden) return;
      clearTimeout(timer);
      if (pending) {
        queued = true;
        return;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      pending = (async () => {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId, action: 'heartbeat', isPlaying: playingRef.current }),
            signal: controller.signal,
            cache: 'no-store',
          });
          if (response.status === 401 || response.status === 403) forbidden = true;
          if (!response.ok) throw new Error('Presence unavailable');
          const payload = await response.json();
          if (!Array.isArray(payload.data?.participants)) throw new Error('Invalid presence');
          if (!stopped && !suspended) {
            setSnapshot({ videoId, participants: payload.data.participants, status: 'connected' });
          }
        } catch {
          if (!stopped && !suspended) {
            setSnapshot({ videoId, participants: [], status: 'unavailable' });
          }
        } finally {
          clearTimeout(timeout);
        }
      })().finally(() => {
        pending = null;
        if (stopped || suspended) return;
        if (queued) {
          queued = false;
          refresh();
        } else if (!forbidden) {
          timer = setTimeout(
            refresh,
            document.visibilityState === 'hidden' ? 15_000 : VIDEO_PRESENCE_POLL_MS
          );
        }
      });
    };

    const leave = () => {
      suspended = true;
      clearTimeout(timer);
      const leavingClientId = clientId;
      // Unload delivery is best effort. The server expires missing heartbeats.
      sendLeave(leavingClientId);
      // Serialize a second leave after an in-flight heartbeat to avoid restoring it.
      if (pending) void pending.then(() => sendLeave(leavingClientId));
    };
    const resume = () => {
      // A restored page gets a new tab lease so an old leave cannot delete it.
      if (suspended) clientId = crypto.randomUUID();
      suspended = false;
      refresh();
    };
    refreshRef.current = refresh;
    refresh();
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', resume);

    return () => {
      stopped = true;
      clearTimeout(timer);
      refreshRef.current = null;
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', resume);
      const leavingClientId = clientId;
      if (pending) void pending.then(() => sendLeave(leavingClientId));
      else sendLeave();
    };
  }, [enabled, videoId]);

  return enabled && snapshot.videoId === videoId
    ? snapshot
    : { participants: [], status: 'connecting' as const };
}
