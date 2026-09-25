'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type {
  LiveClientMessage,
  LiveDiscovery,
  LiveJoinResult,
  LiveServerMessage,
  LiveSnapshot,
  LiveStroke,
} from '@/lib/live-review/protocol';
import {
  desiredPlaybackPosition,
  estimateServerOffset,
  playbackCorrection,
  shouldAcceptSnapshot,
} from '@/lib/live-review/sync';

type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'blocked';

interface UseLiveReviewParams {
  videoId: string;
  versionId: string | null;
  providerId: string | undefined;
  guestName?: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  onCommentsChanged?: () => void;
  onVersionSelect?: (versionId: string) => void;
  enabled?: boolean;
}

const DISCOVERY_INTERVAL_MS = 2000;
const PING_INTERVAL_MS = 5000;
const SYNC_INTERVAL_MS = 1000;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const MAX_NATIVE_PLAYBACK_RATE = 16;

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return fallback;
}

function savedParticipant(videoId: string, sessionId: string | undefined): string | undefined {
  if (!sessionId) return;
  try {
    const saved = JSON.parse(sessionStorage.getItem(`live-review:${videoId}`) ?? 'null');
    return saved?.sessionId === sessionId && typeof saved.participantId === 'string'
      ? saved.participantId
      : undefined;
  } catch {
    return undefined;
  }
}

function rememberParticipant(videoId: string, ticket: LiveJoinResult | null) {
  try {
    if (ticket) {
      sessionStorage.setItem(
        `live-review:${videoId}`,
        JSON.stringify({
          sessionId: ticket.sessionId,
          participantId: ticket.participantId,
        })
      );
    } else {
      sessionStorage.removeItem(`live-review:${videoId}`);
    }
  } catch {
    // Storage restrictions must not prevent joining a room.
  }
}

export function useLiveReview({
  videoId,
  versionId,
  providerId,
  guestName,
  videoRef,
  onCommentsChanged,
  onVersionSelect,
  enabled = true,
}: UseLiveReviewParams) {
  const [discovery, setDiscovery] = useState<LiveDiscovery | null>(null);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [rejectedStroke, setRejectedStroke] = useState<{ id: string; sequence: number } | null>(
    null
  );
  const rejectedStrokeSequenceRef = useRef(0);
  const [isJoined, setIsJoined] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const discoveryRequestRef = useRef<AbortController | null>(null);
  const joinRef = useRef<LiveJoinResult | null>(null);
  const snapshotRef = useRef<LiveSnapshot | null>(null);
  const participantRef = useRef<string | null>(null);
  const statusRef = useRef<ConnectionStatus>('idle');
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const syncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const generationRef = useRef(0);
  const serverOffsetRef = useRef(0);
  const bestPingRef = useRef(Number.POSITIVE_INFINITY);
  const applyingUntilRef = useRef(0);
  const lastPlaybackSentRef = useRef(0);
  const lastPlaybackKeyRef = useRef('');
  const commandSequenceRef = useRef(0);
  const lastStatusRef = useRef<string | null>(null);
  const callbacksRef = useRef({ onCommentsChanged, onVersionSelect });
  useEffect(() => {
    callbacksRef.current = { onCommentsChanged, onVersionSelect };
  }, [onCommentsChanged, onVersionSelect]);

  const setStatus = useCallback((next: ConnectionStatus) => {
    statusRef.current = next;
    setConnectionStatus(next);
  }, []);

  const send = useCallback((message: LiveClientMessage): boolean => {
    const socket = socketRef.current;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      (statusRef.current !== 'connected' && statusRef.current !== 'blocked')
    )
      return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const reportStatus = useCallback(
    (status: 'ready' | 'buffering' | 'blocked') => {
      if (lastStatusRef.current === status) return;
      if (send({ type: 'status', status })) lastStatusRef.current = status;
    },
    [send]
  );

  const applyPlayback = useCallback(
    (room: LiveSnapshot, force = false) => {
      const video = videoRef.current;
      if (!video || video.readyState < 1 || room.versionId !== versionId) return;
      if (room.status !== 'active') return;
      const self = participantRef.current;
      const presenter = room.presenterId === self;
      const desired = desiredPlaybackPosition(
        room,
        Date.now(),
        serverOffsetRef.current,
        Number.isFinite(video.duration)
          ? Math.max(0, video.duration - 0.01)
          : Number.POSITIVE_INFINITY
      );
      const drift = desired - video.currentTime;
      const correction = playbackCorrection(drift);
      if (force || correction.seek || (!room.playback.playing && Math.abs(drift) > 0.08)) {
        applyingUntilRef.current = Date.now() + 600;
        try {
          video.currentTime = desired;
        } catch {
          // Metadata or source switching can temporarily reject seeks.
        }
      }
      const rate = Math.min(
        MAX_NATIVE_PLAYBACK_RATE,
        Math.max(
          0.25,
          room.playback.rate * (presenter || !room.playback.playing ? 1 : correction.rateFactor)
        )
      );
      if (Math.abs(video.playbackRate - rate) > 0.005) {
        applyingUntilRef.current = Date.now() + 600;
        video.playbackRate = rate;
      }
      if (!room.playback.playing) {
        if (!video.paused) {
          applyingUntilRef.current = Date.now() + 600;
          video.pause();
        }
        reportStatus(video.readyState < 3 ? 'buffering' : 'ready');
      } else if (video.paused && statusRef.current !== 'blocked') {
        applyingUntilRef.current = Date.now() + 600;
        void video
          .play()
          .then(() => {
            reportStatus(video.readyState < 3 ? 'buffering' : 'ready');
          })
          .catch((cause: unknown) => {
            if (
              snapshotRef.current?.playback.playing !== true ||
              (cause instanceof DOMException && cause.name === 'AbortError')
            )
              return;
            reportStatus('blocked');
            setStatus('blocked');
            setError('Playback was blocked. Select Resume playback to follow the room.');
          });
      }
    },
    [reportStatus, setStatus, versionId, videoRef]
  );

  const clearConnectionTimers = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (pingTimerRef.current) clearInterval(pingTimerRef.current);
    if (syncTimerRef.current) clearInterval(syncTimerRef.current);
    reconnectTimerRef.current = null;
    pingTimerRef.current = null;
    syncTimerRef.current = null;
  }, []);

  const closeConnection = useCallback(() => {
    clearConnectionTimers();
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  }, [clearConnectionTimers]);

  const refreshDiscovery = useCallback(async () => {
    if (!enabled || !videoId || discoveryRequestRef.current) return;
    const controller = new AbortController();
    discoveryRequestRef.current = controller;
    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(videoId)}/live-review`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return;
      const body = await response.json();
      if (!controller.signal.aborted) setDiscovery(body.data as LiveDiscovery);
    } catch {
      // Discovery is optional while the rest of the video page works normally.
    } finally {
      if (discoveryRequestRef.current === controller) discoveryRequestRef.current = null;
    }
  }, [enabled, videoId]);

  useEffect(() => {
    if (!enabled || !videoId) return;
    const timer = setTimeout(() => void refreshDiscovery(), 0);
    return () => {
      clearTimeout(timer);
      discoveryRequestRef.current?.abort();
      discoveryRequestRef.current = null;
    };
  }, [enabled, videoId, refreshDiscovery]);

  useEffect(() => {
    if (!enabled || !discovery?.enabled || isJoined) return;
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') void refreshDiscovery();
    };
    const timer = setInterval(refreshVisible, DISCOVERY_INTERVAL_MS);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [discovery?.enabled, enabled, isJoined, refreshDiscovery]);

  const getTicket = useCallback(
    async (action: 'start' | 'join', existingParticipantId?: string): Promise<LiveJoinResult> => {
      const response = await fetch(`/api/videos/${encodeURIComponent(videoId)}/live-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          versionId:
            action === 'join'
              ? (joinRef.current?.versionId ?? discovery?.session?.versionId ?? versionId)
              : versionId,
          guestName: guestName?.trim() || undefined,
          participantId:
            existingParticipantId ??
            (action === 'join' ? savedParticipant(videoId, discovery?.session?.id) : undefined),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.data) {
        throw Object.assign(new Error(errorMessage(body, 'Could not join live review.')), {
          status: response.status,
        });
      }
      return body.data as LiveJoinResult;
    },
    [discovery?.session?.id, discovery?.session?.versionId, guestName, versionId, videoId]
  );

  const connectRef = useRef<(ticket: LiveJoinResult, generation: number) => void>(() => {});
  const reconnectRef = useRef<(generation: number) => void>(() => {});

  const connect = useCallback(
    (ticket: LiveJoinResult, generation: number) => {
      if (generation !== generationRef.current) return;
      closeConnection();
      setStatus(reconnectAttemptRef.current ? 'reconnecting' : 'connecting');
      const socket = new WebSocket(ticket.websocketUrl);
      socketRef.current = socket;
      socket.onopen = () => {
        if (generation !== generationRef.current) return;
        socket.send(
          JSON.stringify({ type: 'auth', ticket: ticket.ticket } satisfies LiveClientMessage)
        );
      };
      socket.onmessage = (event) => {
        if (generation !== generationRef.current) return;
        let message: LiveServerMessage;
        try {
          message = JSON.parse(String(event.data)) as LiveServerMessage;
        } catch {
          return;
        }
        if (message.type === 'snapshot') {
          const room = message.snapshot;
          if (
            room.sessionId !== ticket.sessionId ||
            room.videoId !== videoId ||
            room.versionId !== ticket.versionId
          )
            return;
          if (!shouldAcceptSnapshot(snapshotRef.current, room)) return;
          const previous = snapshotRef.current;
          if (previous && previous.canvasEpoch !== room.canvasEpoch) setRejectedStroke(null);
          snapshotRef.current = room;
          setSnapshot(room);
          if (room.status === 'ended') {
            rememberParticipant(videoId, null);
            generationRef.current += 1;
            closeConnection();
            joinRef.current = null;
            participantRef.current = null;
            setParticipantId(null);
            setIsJoined(false);
            setStatus('idle');
            void refreshDiscovery();
            return;
          }
          if (statusRef.current === 'connecting' || statusRef.current === 'reconnecting') {
            if (!Number.isFinite(bestPingRef.current))
              serverOffsetRef.current = room.serverTime - Date.now();
            setStatus('connected');
            setError(null);
            reconnectAttemptRef.current = 0;
            lastStatusRef.current = null;
            reportStatus('ready');
            callbacksRef.current.onCommentsChanged?.();
            send({ type: 'ping', clientTime: Date.now() });
            pingTimerRef.current = setInterval(() => {
              send({ type: 'ping', clientTime: Date.now() });
            }, PING_INTERVAL_MS);
            syncTimerRef.current = setInterval(() => {
              const current = snapshotRef.current;
              if (current && current.presenterId !== participantRef.current) applyPlayback(current);
            }, SYNC_INTERVAL_MS);
          }
          const presenterChanged = previous?.presenterId !== room.presenterId;
          const playbackChanged =
            previous === null ||
            previous.playback.position !== room.playback.position ||
            previous.playback.playing !== room.playback.playing ||
            previous.playback.rate !== room.playback.rate ||
            previous.playback.updatedAt !== room.playback.updatedAt;
          if (
            room.presenterId !== participantRef.current ||
            playbackChanged ||
            presenterChanged ||
            previous?.controlEpoch !== room.controlEpoch
          ) {
            applyPlayback(room, previous === null || presenterChanged);
          }
        } else if (message.type === 'pong') {
          const now = Date.now();
          const latency = now - message.clientTime;
          if (latency >= 0 && latency < bestPingRef.current + 50) {
            if (latency < bestPingRef.current) bestPingRef.current = latency;
            serverOffsetRef.current = estimateServerOffset(
              message.clientTime,
              now,
              message.serverTime
            );
          }
        } else if (message.type === 'comments' && message.versionId === ticket.versionId) {
          callbacksRef.current.onCommentsChanged?.();
        } else if (message.type === 'error') {
          if (
            message.strokeId &&
            ['FORBIDDEN', 'STALE_STROKE', 'CANVAS_LIMIT'].includes(message.code)
          ) {
            rejectedStrokeSequenceRef.current += 1;
            setRejectedStroke({
              id: message.strokeId,
              sequence: rejectedStrokeSequenceRef.current,
            });
          } else {
            setError(message.message);
          }
        }
      };
      socket.onclose = () => {
        if (generation !== generationRef.current || socketRef.current !== socket) return;
        clearConnectionTimers();
        socketRef.current = null;
        videoRef.current?.pause();
        setStatus('reconnecting');
        reconnectRef.current(generation);
      };
      socket.onerror = () => {
        if (generation === generationRef.current)
          setError('Live review connection failed. Reconnecting.');
      };
    },
    [
      applyPlayback,
      clearConnectionTimers,
      closeConnection,
      refreshDiscovery,
      reportStatus,
      send,
      setStatus,
      videoId,
      videoRef,
    ]
  );
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const reconnect = useCallback(
    (generation: number) => {
      if (generation !== generationRef.current || !joinRef.current) return;
      const attempt = reconnectAttemptRef.current++;
      reconnectTimerRef.current = setTimeout(
        async () => {
          if (generation !== generationRef.current || !joinRef.current) return;
          try {
            const nextTicket = await getTicket('join', joinRef.current.participantId);
            if (generation !== generationRef.current) return;
            joinRef.current = nextTicket;
            rememberParticipant(videoId, nextTicket);
            snapshotRef.current = null;
            bestPingRef.current = Number.POSITIVE_INFINITY;
            setSnapshot(null);
            connectRef.current(nextTicket, generation);
          } catch (cause) {
            if (generation !== generationRef.current) return;
            const status =
              cause && typeof cause === 'object' && 'status' in cause ? cause.status : null;
            if (status === 401 || status === 403 || status === 404) {
              rememberParticipant(videoId, null);
              joinRef.current = null;
              participantRef.current = null;
              setParticipantId(null);
              setIsJoined(false);
              setStatus('idle');
              setError(cause instanceof Error ? cause.message : 'Live review access ended.');
              void refreshDiscovery();
              return;
            }
            setError(cause instanceof Error ? cause.message : 'Could not reconnect.');
            reconnectRef.current(generation);
          }
        },
        RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]
      );
    },
    [getTicket, refreshDiscovery, setStatus, videoId]
  );
  useEffect(() => {
    reconnectRef.current = reconnect;
  }, [reconnect]);

  const begin = useCallback(
    async (action: 'start' | 'join') => {
      if (
        !enabled ||
        !videoId ||
        (action === 'start' && (!versionId || (providerId !== 'r2' && providerId !== 'bunny')))
      )
        return;
      generationRef.current += 1;
      const generation = generationRef.current;
      closeConnection();
      joinRef.current = null;
      snapshotRef.current = null;
      setSnapshot(null);
      setIsJoined(false);
      setError(null);
      setRejectedStroke(null);
      setStatus('connecting');
      reconnectAttemptRef.current = 0;
      bestPingRef.current = Number.POSITIVE_INFINITY;
      try {
        const ticket = await getTicket(action);
        if (generation !== generationRef.current) return;
        joinRef.current = ticket;
        rememberParticipant(videoId, ticket);
        participantRef.current = ticket.participantId;
        setParticipantId(ticket.participantId);
        setIsJoined(true);
        snapshotRef.current = null;
        setSnapshot(null);
        if (ticket.versionId !== versionId) {
          if (!callbacksRef.current.onVersionSelect)
            throw new Error('Select the room video version before joining.');
          callbacksRef.current.onVersionSelect(ticket.versionId);
        } else {
          connectRef.current(ticket, generation);
        }
      } catch (cause) {
        if (generation !== generationRef.current) return;
        const status =
          cause && typeof cause === 'object' && 'status' in cause ? cause.status : null;
        if (status === 401 || status === 403 || status === 404) rememberParticipant(videoId, null);
        joinRef.current = null;
        participantRef.current = null;
        setParticipantId(null);
        setIsJoined(false);
        setStatus('idle');
        setError(cause instanceof Error ? cause.message : 'Could not join live review.');
      }
    },
    [closeConnection, enabled, getTicket, providerId, setStatus, versionId, videoId]
  );

  useEffect(() => {
    const ticket = joinRef.current;
    if (
      ticket &&
      isJoined &&
      ticket.versionId === versionId &&
      !socketRef.current &&
      connectionStatus === 'connecting'
    ) {
      connectRef.current(ticket, generationRef.current);
    }
  }, [connectionStatus, isJoined, versionId]);

  const leave = useCallback(() => {
    rememberParticipant(videoId, null);
    generationRef.current += 1;
    closeConnection();
    joinRef.current = null;
    snapshotRef.current = null;
    participantRef.current = null;
    setSnapshot(null);
    setParticipantId(null);
    setIsJoined(false);
    setStatus('idle');
    setError(null);
    setRejectedStroke(null);
    void refreshDiscovery();
  }, [closeConnection, refreshDiscovery, setStatus, videoId]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      closeConnection();
    };
  }, [closeConnection, videoId]);

  useEffect(() => {
    const room = snapshotRef.current;
    if (room && room.versionId === versionId) applyPlayback(room, true);
  }, [applyPlayback, versionId]);

  useEffect(() => {
    if (!isJoined || providerId === 'youtube') return;
    const video = videoRef.current;
    if (!video) return;
    let pendingPlaybackTimer: ReturnType<typeof setTimeout> | null = null;
    const onLocalChange = () => {
      const room = snapshotRef.current;
      if (!room || room.versionId !== versionId || statusRef.current !== 'connected') return;
      if (Date.now() < applyingUntilRef.current) {
        const expected = desiredPlaybackPosition(room, Date.now(), serverOffsetRef.current);
        const isPresenter = room.presenterId === participantRef.current;
        const matchesRoom =
          video.paused === !room.playback.playing &&
          Math.abs(video.currentTime - expected) < (isPresenter ? 0.25 : 0.75) &&
          Math.abs(video.playbackRate - room.playback.rate) <
            (isPresenter ? 0.02 : room.playback.rate * 0.08);
        if (matchesRoom) return;
      }
      if (room.presenterId !== participantRef.current) {
        applyPlayback(room, true);
        return;
      }
      const key = `${video.paused}:${video.currentTime.toFixed(2)}:${video.playbackRate.toFixed(2)}`;
      const now = Date.now();
      if (key === lastPlaybackKeyRef.current) return;
      const wait = 120 - (now - lastPlaybackSentRef.current);
      if (wait > 0) {
        if (pendingPlaybackTimer) clearTimeout(pendingPlaybackTimer);
        pendingPlaybackTimer = setTimeout(() => {
          pendingPlaybackTimer = null;
          onLocalChange();
        }, wait);
        return;
      }
      lastPlaybackKeyRef.current = key;
      lastPlaybackSentRef.current = now;
      send({
        type: 'playback',
        commandId: `${participantRef.current}:${now}:${++commandSequenceRef.current}`,
        controlEpoch: room.controlEpoch,
        position: video.currentTime,
        playing: !video.paused,
        rate: video.playbackRate,
      });
    };
    const onWaiting = () => reportStatus('buffering');
    const onReady = () => {
      if (statusRef.current !== 'blocked') reportStatus('ready');
    };
    const onMetadata = () => {
      const room = snapshotRef.current;
      if (room) applyPlayback(room, true);
    };
    video.addEventListener('play', onLocalChange);
    video.addEventListener('pause', onLocalChange);
    video.addEventListener('seeked', onLocalChange);
    video.addEventListener('ratechange', onLocalChange);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('stalled', onWaiting);
    video.addEventListener('playing', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('loadedmetadata', onMetadata);
    return () => {
      if (pendingPlaybackTimer) clearTimeout(pendingPlaybackTimer);
      video.removeEventListener('play', onLocalChange);
      video.removeEventListener('pause', onLocalChange);
      video.removeEventListener('seeked', onLocalChange);
      video.removeEventListener('ratechange', onLocalChange);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('stalled', onWaiting);
      video.removeEventListener('playing', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('loadedmetadata', onMetadata);
    };
  }, [applyPlayback, isJoined, providerId, reportStatus, send, versionId, videoRef]);

  const transfer = useCallback(
    (nextParticipantId: string) => {
      const room = snapshotRef.current;
      if (room && room.participants.some((member) => member.id === nextParticipantId)) {
        send({
          type: 'transfer',
          participantId: nextParticipantId,
          controlEpoch: room.controlEpoch,
        });
      }
    },
    [send]
  );
  const end = useCallback(() => {
    send({ type: 'end' });
  }, [send]);
  const sendStroke = useCallback(
    (stroke: Omit<LiveStroke, 'participantId'>, canvasEpoch?: number) => {
      const room = snapshotRef.current;
      if (
        room &&
        !room.playback.playing &&
        (canvasEpoch === undefined || canvasEpoch === room.canvasEpoch)
      ) {
        send({ type: 'stroke', canvasEpoch: room.canvasEpoch, stroke });
      }
    },
    [send]
  );
  const undo = useCallback(
    (canvasEpoch?: number) => {
      const room = snapshotRef.current;
      if (room && (canvasEpoch === undefined || canvasEpoch === room.canvasEpoch))
        send({ type: 'undo', canvasEpoch: room.canvasEpoch });
    },
    [send]
  );
  const clear = useCallback(
    (canvasEpoch?: number) => {
      const room = snapshotRef.current;
      if (room && (canvasEpoch === undefined || canvasEpoch === room.canvasEpoch))
        send({ type: 'clear', canvasEpoch: room.canvasEpoch });
    },
    [send]
  );
  const retryPlayback = useCallback(() => {
    const room = snapshotRef.current;
    const video = videoRef.current;
    if (!room || !video || !room.playback.playing) return;
    setStatus('connected');
    void video
      .play()
      .then(() => {
        setError(null);
        setStatus('connected');
        reportStatus('ready');
        applyPlayback(room);
      })
      .catch(() => {
        setStatus('blocked');
        reportStatus('blocked');
      });
  }, [applyPlayback, reportStatus, setStatus, videoRef]);

  const isPresenter = !!snapshot && snapshot.presenterId === participantId;
  const self = snapshot?.participants.find((member) => member.id === participantId);
  const isManager = !!self?.isManager;
  const canDraw =
    connectionStatus === 'connected' && !!self?.canComment && !snapshot?.playback.playing;
  const playbackLocked = isJoined && (!isPresenter || connectionStatus !== 'connected');

  return {
    discovery,
    snapshot,
    participantId,
    connectionStatus,
    error,
    rejectedStroke,
    isJoined,
    isPresenter,
    isManager,
    canDraw,
    autoplayBlocked: connectionStatus === 'blocked',
    playbackLocked,
    start: () => begin('start'),
    join: () => begin('join'),
    leave,
    transfer,
    end,
    sendStroke,
    undo,
    clear,
    retryPlayback,
    refreshDiscovery,
  };
}
