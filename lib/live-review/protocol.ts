// Shared wire contract. Media URLs and access credentials never appear in room snapshots.
import type { AnnotationStroke } from '@/components/annotation/types';

export interface LiveStroke extends AnnotationStroke {
  id: string;
  participantId: string;
}

export interface LiveParticipant {
  id: string;
  name: string;
  isManager: boolean;
  canComment: boolean;
  status: 'ready' | 'buffering' | 'blocked';
}

export interface LivePlayback {
  position: number;
  playing: boolean;
  rate: number;
  updatedAt: number;
}

export interface LiveSnapshot {
  sessionId: string;
  videoId: string;
  versionId: string;
  status: 'active' | 'ended';
  revision: number;
  controlEpoch: number;
  presenterId: string | null;
  playback: LivePlayback;
  participants: LiveParticipant[];
  strokes: LiveStroke[];
  canvasEpoch: number;
  serverTime: number;
}

export type LiveClientMessage =
  | { type: 'auth'; ticket: string }
  | { type: 'ping'; clientTime: number }
  | { type: 'leave' }
  | { type: 'status'; status: LiveParticipant['status'] }
  | {
      type: 'playback';
      commandId: string;
      controlEpoch: number;
      position: number;
      playing: boolean;
      rate: number;
    }
  | { type: 'transfer'; participantId: string; controlEpoch: number }
  | { type: 'stroke'; canvasEpoch: number; stroke: Omit<LiveStroke, 'participantId'> }
  | { type: 'undo'; canvasEpoch: number }
  | { type: 'clear'; canvasEpoch: number }
  | { type: 'end' };

export type LiveServerMessage =
  | { type: 'snapshot'; snapshot: LiveSnapshot }
  | { type: 'pong'; clientTime: number; serverTime: number }
  | { type: 'comments'; versionId: string }
  | { type: 'error'; code: string; message: string; strokeId?: string };

export interface LiveDiscovery {
  enabled: boolean;
  available: boolean;
  canStart: boolean;
  session: { id: string; versionId: string } | null;
}

export interface LiveJoinResult {
  ticket: string;
  participantId: string;
  websocketUrl: string;
  sessionId: string;
  versionId: string;
}

export const LIVE_MAX_PARTICIPANTS = 10;
export const LIVE_MAX_MESSAGE_BYTES = 64 * 1024;
export const LIVE_MAX_STROKE_POINTS = 1000;
export const LIVE_MAX_STROKES = 100;
