export const VIDEO_PRESENCE_POLL_MS = 5000;
export const VIDEO_PRESENCE_HEARTBEAT_MS = 15000;
export const VIDEO_PRESENCE_TTL_MS = 30000;

export interface VideoPresenceParticipant {
  id: string;
  name: string;
  isAnonymous: boolean;
  isGuest?: boolean;
  isPlaying: boolean;
  isSelf: boolean;
}
