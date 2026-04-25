export interface Version {
  id: string;
  versionNumber: number;
  versionLabel: string | null;
  providerId: string;
  videoId: string;
  originalUrl: string;
  title: string | null;
  thumbnailUrl: string | null;
  duration: number | null;
  isActive: boolean;
  _count: { comments: number };
}

export interface CommentTag {
  id: string;
  name: string;
  color: string;
}

export interface VideoAsset {
  id: string;
  videoId: string;
  kind: 'IMAGE' | 'VIDEO' | 'AUDIO';
  provider: 'R2_IMAGE' | 'YOUTUBE' | 'BUNNY' | 'R2_AUDIO';
  displayName: string;
  sourceUrl: string | null;
  providerVideoId: string | null;
  thumbnailUrl: string | null;
  uploadedByUserId: string | null;
  uploadedByGuestName: string | null;
  createdAt: string;
  updatedAt: string;
  uploadedByUser: { id: string; name: string | null; image: string | null } | null;
  canDelete: boolean;
}

export interface ApprovalDecision {
  id: string;
  approverId: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  note: string | null;
  respondedAt: string | null;
  createdAt: string;
  approver: {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
  };
}

export interface ApprovalRequest {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELED';
  requestedById: string;
  message: string | null;
  resolvedAt: string | null;
  canceledAt: string | null;
  canceledById: string | null;
  createdAt: string;
  updatedAt: string;
  requestedBy: {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
  };
  canceledBy: {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
  } | null;
  decisions: ApprovalDecision[];
}

export interface CommentReply {
  id: string;
  content: string | null;
  timestamp: number;
  timestampEnd: number | null;
  voiceUrl: string | null;
  voiceDuration: number | null;
  imageUrl: string | null;
  annotationData: string | null;
  createdAt: string;
  author: { id: string; name: string | null; image: string | null } | null;
  guestName: string | null;
  canEdit?: boolean;
  canDelete?: boolean;
  tag: CommentTag | null;
}

export interface Comment {
  id: string;
  content: string | null;
  timestamp: number;
  timestampEnd: number | null;
  voiceUrl: string | null;
  voiceDuration: number | null;
  imageUrl: string | null;
  annotationData: string | null;
  isResolved: boolean;
  createdAt: string;
  author: { id: string; name: string | null; image: string | null } | null;
  guestName: string | null;
  canEdit?: boolean;
  canDelete?: boolean;
  tag: CommentTag | null;
  replies: CommentReply[];
}

export interface VideoData {
  id: string;
  title: string;
  description: string | null;
  projectId: string;
  project: {
    name: string;
    ownerId: string;
    members?: { role: string }[];
    visibility?: string;
  };
  versions: (Version & { comments: Comment[] })[];
  isAuthenticated: boolean;
  currentUserId: string | null;
  currentUserName: string | null;
  canComment?: boolean;
  canDownload?: boolean;
  canManageTags?: boolean;
  canResolveComments?: boolean;
  canRequestApproval?: boolean;
  canShareVideo?: boolean;
  canUploadAssets?: boolean;
  canDownloadAssets?: boolean;
}

export interface BunnyQualityOption {
  level: number;
  label: string;
}

export type BunnyPlaybackState = 'none' | 'processing' | 'error';
export type BunnyDownloadPreference = 'original' | 'compressed';
export type DownloadTarget = BunnyDownloadPreference | 'direct';

export interface CommentMarker {
  id: string;
  timestamp: number;
  timestampEnd: number | null;
  color: string;
  annotationData: string | null;
  preview: string;
}

export interface PlayerAdapter {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (time: number, allowSeekAhead?: boolean) => void;
  mute: () => void;
  unMute: () => void;
  isMuted: () => boolean;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  setPlaybackRate: (rate: number) => void;
  destroy: () => void;
  off?: (event: string) => void;
}

export interface WatchProgressConfig {
  videoId: string;
  activeVersionId: string | null;
  isAuthenticated: boolean;
  pathname: string;
}

export interface WatchProgressState {
  savedProgress: number | null;
  showResumePrompt: boolean;
}

export interface CommentActionsConfig {
  videoId: string;
}

export interface VersionActionsConfig {
  projectId?: string;
  videoId: string;
  bunnyUploadsEnabled?: boolean;
}

export interface VideoPageHeaderActions {
  onVersionSelect: (versionId: string) => void;
  onDeleteCurrentVersionClick: () => void;
  onDownload: (preference?: BunnyDownloadPreference) => void;
  onOpenCompare: () => void;
  onCreateVersion: () => void;
}

export interface VideoPageCommentsActions {
  onExportComments: (format: 'csv' | 'pdf') => void;
  onResolveComment: (commentId: string, currentlyResolved: boolean) => void;
  onEditComment: (commentId: string) => void;
  onDeleteComment: (commentId: string) => void;
  onReplyComment: (
    parentId: string,
    voiceData?: { url: string; duration: number },
    imageData?: { url: string }
  ) => void;
  onSubmitReplyWithMedia: (parentId: string) => void;
  onStartEditAnnotation: () => void;
}

export interface VideoPageComposerActions {
  onSubmitCommentWithMedia: () => void;
  onAddComment: () => void;
  onPauseVideoForAnnotation: () => void;
}

export interface VideoPageCompareActions {
  onToggleVersion: (versionId: string) => void;
  onCompare: () => void;
}
