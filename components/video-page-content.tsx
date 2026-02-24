'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import Hls, { type Level } from 'hls.js';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Play,
  Pause,
  Volume2,
  VolumeX,
  SkipBack,
  SkipForward,
  Gauge,
  MessageSquare,
  MessageSquareOff,
  Mic,
  Send,
  Clock,
  CheckCircle2,
  Circle,
  ChevronDown,
  MoreVertical,
  Plus,
  Loader2,
  Link as LinkIcon,
  AlertCircle,
  GitCompareArrows,
  Reply,
  Pencil,
  Trash2,
  X,
  ArrowUpRight,
  Tag,
  User,
  Maximize,
  Minimize,
  Image as ImageIcon,
  Download,
  FileText,
  Share2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { parseVideoUrl, getThumbnailUrl, fetchVideoMetadata, type VideoSource } from '@/lib/video-providers';
import { AnnotationCanvas, type AnnotationStroke, type AnnotationCanvasHandle } from '@/components/annotation-canvas';
import { Linkify } from '@/components/linkify';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import * as tus from 'tus-js-client';
import { UploadCloud, FileVideo } from 'lucide-react';

interface Version {
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

interface CommentTag {
  id: string;
  name: string;
  color: string;
}

interface PlayerAdapter {
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

interface Comment {
  id: string;
  content: string | null;
  timestamp: number;
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
  replies: {
    id: string;
    content: string | null;
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
  }[];
}

interface VideoData {
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
}

function formatTime(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatBunnyQualityLabel(level: { height?: number; bitrate?: number }, index: number): string {
  if (typeof level.height === 'number' && level.height > 0) {
    return `${level.height}p`;
  }
  if (typeof level.bitrate === 'number' && level.bitrate > 0) {
    return `${Math.round(level.bitrate / 1000)} kbps`;
  }
  return `Level ${index + 1}`;
}

function sanitizeDownloadFileName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const BUNNY_PULL_ZONE_HOSTNAME = 'vz-965f4f4a-fc1.b-cdn.net';
const DIRECT_DOWNLOAD_ALLOWED_HOSTS = [
  BUNNY_PULL_ZONE_HOSTNAME,
  ...(process.env.NEXT_PUBLIC_BUNNY_CDN_URL
    ? (() => {
      try {
        return [new URL(process.env.NEXT_PUBLIC_BUNNY_CDN_URL).hostname];
      } catch {
        return [process.env.NEXT_PUBLIC_BUNNY_CDN_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '')];
      }
    })()
    : []),
  ...(process.env.NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS ?? '').split(','),
]
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

function getSafeDirectDownloadUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    if (DIRECT_DOWNLOAD_ALLOWED_HOSTS.length === 0) {
      return null;
    }

    const normalizedHost = parsed.hostname.toLowerCase();
    if (!DIRECT_DOWNLOAD_ALLOWED_HOSTS.includes(normalizedHost)) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

interface BunnyQualityOption {
  level: number;
  label: string;
}

type BunnyPlaybackState = 'none' | 'processing' | 'error';
type BunnyDownloadPreference = 'original' | 'compressed';
type DownloadTarget = BunnyDownloadPreference | 'direct';

export type VideoPageMode = 'dashboard' | 'watch';

interface VideoPageContentProps {
  mode: VideoPageMode;
  videoId: string;
  projectId?: string;
}

export function VideoPageContent({ mode, videoId, projectId: propProjectId }: VideoPageContentProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const bunnyViewportRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const playerRef = useRef<YT.Player | PlayerAdapter | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const [video, setVideo] = useState<VideoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [bunnyPlaybackState, setBunnyPlaybackState] = useState<BunnyPlaybackState>('none');
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [qualityOptions, setQualityOptions] = useState<BunnyQualityOption[]>([]);
  const [selectedQualityLevel, setSelectedQualityLevel] = useState<number>(-1);
  const [isBunnyPortraitSource, setIsBunnyPortraitSource] = useState(false);
  const [bunnyPortraitFrameWidth, setBunnyPortraitFrameWidth] = useState<number>(0);
  const [cursorIdle, setCursorIdle] = useState(false);
  const cursorIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPathnameRef = useRef<string>(pathname);

  const [commentText, setCommentText] = useState('');
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [isUploadingAudio, setIsUploadingAudio] = useState(false);
  const [imageBlob, setImageBlob] = useState<File | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [voiceProgress, setVoiceProgress] = useState(0);
  const [voiceCurrentTime, setVoiceCurrentTime] = useState(0);
  const [voicePlaybackRate, setVoicePlaybackRate] = useState(1);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const voiceRafRef = useRef<number | null>(null);
  const voiceKnownDurationRef = useRef<number>(0);
  const [selectedTimestamp, setSelectedTimestamp] = useState<number | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [activeDownloadTarget, setActiveDownloadTarget] = useState<DownloadTarget | null>(null);

  // Watch progress state
  const [savedProgress, setSavedProgress] = useState<number | null>(null);
  const [showResumePrompt, setShowResumePrompt] = useState(false);
  const progressSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressWriteInFlightRef = useRef(false);
  const pendingProgressPayloadRef = useRef<{ progress: number; duration: number; force: boolean } | null>(null);
  const lastSavedProgressRef = useRef<number>(0);
  const bunnyRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fullscreen state
  const [isFullscreenMode, setIsFullscreenMode] = useState(false);
  const [showComments, setShowComments] = useState(true);
  const [isMobileCommentsOpen, setIsMobileCommentsOpen] = useState(false);

  // YouTube API loading state
  const [isApiLoaded, setIsApiLoaded] = useState(false);
  const [progressFetchKey, setProgressFetchKey] = useState(0);

  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [isSubmittingReply, setIsSubmittingReply] = useState(false);
  const [isReplyRecording, setIsReplyRecording] = useState(false);
  const [replyRecordingTime, setReplyRecordingTime] = useState(0);
  const [replyAudioBlob, setReplyAudioBlob] = useState<Blob | null>(null);
  const [isUploadingReplyAudio, setIsUploadingReplyAudio] = useState(false);
  const [replyImageBlob, setReplyImageBlob] = useState<File | null>(null);
  const [isUploadingReplyImage, setIsUploadingReplyImage] = useState(false);
  const replyImageInputRef = useRef<HTMLInputElement>(null);
  const replyMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const replyAudioChunksRef = useRef<Blob[]>([]);
  const replyRecordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editTagId, setEditTagId] = useState<string | null>(null);
  const [editAnnotationData, setEditAnnotationData] = useState<string | null | undefined>(undefined);
  const [isEditingAnnotation, setIsEditingAnnotation] = useState(false);
  const editAnnotationCanvasRef = useRef<AnnotationCanvasHandle>(null);
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
  const [, setDeletingCommentId] = useState<string | null>(null);
  const isMutatingRef = useRef(false);
  const commentsEtagRef = useRef<Map<string, string>>(new Map());
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // Annotation state
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [annotationStrokes, setAnnotationStrokes] = useState<AnnotationStroke[] | null>(null);
  const [viewingAnnotation, setViewingAnnotation] = useState<AnnotationStroke[] | null>(null);
  const annotationCanvasRef = useRef<AnnotationCanvasHandle>(null);

  const [guestName, setGuestName] = useState('');
  const [guestNameConfirmed, setGuestNameConfirmed] = useState(mode === 'dashboard');

  // Compare dialog state
  const [showCompareDialog, setShowCompareDialog] = useState(false);
  const [selectedCompareVersions, setSelectedCompareVersions] = useState<Set<string>>(new Set());
  const router = useRouter();

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
  }, [activeVersionId]);

  useEffect(() => {
    const saved = localStorage.getItem('openframe_guest_name');
    if (saved) {
      setGuestName(saved);
      if (mode === 'watch') setGuestNameConfirmed(true);
    }
  }, [mode]);

  const isGuest = video ? !video.isAuthenticated : false;
  const canInitializePlayer = mode !== 'watch' || !isGuest || guestNameConfirmed;
  const normalizedGuestName = guestName.trim();

  const [showVersionDialog, setShowVersionDialog] = useState(false);
  const [newVersionUrl, setNewVersionUrl] = useState('');
  const [newVersionLabel, setNewVersionLabel] = useState('');
  const [newVersionSource, setNewVersionSource] = useState<VideoSource | null>(null);
  const [newVersionUrlError, setNewVersionUrlError] = useState('');
  const [isCreatingVersion, setIsCreatingVersion] = useState(false);

  const [newVersionMode, setNewVersionMode] = useState<'url' | 'file'>('url');
  const [newVersionFile, setNewVersionFile] = useState<File | null>(null);
  const [newVersionUploadProgress, setNewVersionUploadProgress] = useState(0);
  const [newVersionUploadStatus, setNewVersionUploadStatus] = useState('');

  const [availableTags, setAvailableTags] = useState<CommentTag[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);

  const projectId = propProjectId || video?.projectId;

  // Cursor idle detection: hide overlay when cursor idle for 3s while playing
  // Memoize version selection handler to prevent recreating on each render
  const handleVersionSelect = useCallback((versionId: string) => {
    setActiveVersionId(versionId);
  }, []);

  // Memoize toggle show resolved handler
  const handleToggleShowResolved = useCallback(() => {
    setShowResolved(prev => !prev);
  }, []);

  const handleExportComments = useCallback(
    async (format: 'csv' | 'pdf') => {
      if (!activeVersionId) return;

      if (format === 'csv') {
        setIsExportingCsv(true);
      } else {
        setIsExportingPdf(true);
      }

      try {
        const response = await fetch(
          `/api/versions/${activeVersionId}/comments/export?format=${format}&includeResolved=${showResolved}`
        );

        if (!response.ok) {
          let message = 'Failed to export comments';
          try {
            const data = await response.json();
            if (typeof data?.error === 'string') {
              message = data.error;
            }
          } catch {
            // Keep fallback message when response is not JSON.
          }
          throw new Error(message);
        }

        const blob = await response.blob();
        const disposition = response.headers.get('content-disposition');
        const fallbackName = `comments.${format}`;
        const matched = disposition?.match(/filename="?([^"]+)"?/i);
        const filename = matched?.[1] || fallbackName;

        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(downloadUrl);

        toast.success(`Comments exported as ${format.toUpperCase()}`);
      } catch (error) {
        console.error('Failed to export comments:', error);
        toast.error(error instanceof Error ? error.message : 'Failed to export comments');
      } finally {
        if (format === 'csv') {
          setIsExportingCsv(false);
        } else {
          setIsExportingPdf(false);
        }
      }
    },
    [activeVersionId, showResolved]
  );

  const handleVideoMouseMove = useCallback(() => {
    setCursorIdle(false);
    if (cursorIdleTimerRef.current) clearTimeout(cursorIdleTimerRef.current);

    // In fullscreen mode: hide header AND controls when cursor idle for 1s while playing
    // Non-fullscreen: hide only the play overlay (existing behavior)
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

  // Determine current user info for permission checks and comment display
  const currentUserId = video?.currentUserId || null;
  const currentUserName = video?.currentUserName || null;
  const canResolveComments = !!video?.canResolveComments;

  const apiBasePath = mode === 'dashboard'
    ? `/api/projects/${propProjectId}/videos/${videoId}?includeComments=false`
    : `/api/watch/${videoId}`;

  const fetchVersionComments = useCallback(async (versionId: string, useEtag: boolean) => {
    const headers: HeadersInit = {};
    if (useEtag) {
      const etag = commentsEtagRef.current.get(versionId);
      if (etag) headers['If-None-Match'] = etag;
    }

    const res = await fetch(`/api/versions/${versionId}/comments?includeResolved=true`, {
      cache: 'no-store',
      headers,
    });

    if (res.status === 304) return;
    if (!res.ok) return;

    const etag = res.headers.get('etag');
    if (etag) commentsEtagRef.current.set(versionId, etag);

    const payload = await res.json();
    const commentsList = payload?.data?.comments;
    if (!Array.isArray(commentsList)) return;

    setVideo((prev) => {
      if (!prev) return prev;
      const totalComments = commentsList.reduce((sum: number, comment: Comment) => {
        return sum + 1 + (comment.replies?.length ?? 0);
      }, 0);

      return {
        ...prev,
        versions: prev.versions.map((version) => (
          version.id === versionId
            ? { ...version, comments: commentsList, _count: { comments: totalComments } }
            : version
        )),
      };
    });
  }, []);

  useEffect(() => {
    async function fetchVideo() {
      try {
        const res = await fetch(apiBasePath, { cache: 'no-store' });
        if (!res.ok) {
          const errorText = mode === 'dashboard' ? await res.text() : '';
          setError(mode === 'dashboard'
            ? `Failed to load video: ${res.status} ${errorText}`
            : 'Video not found or access denied'
          );
          setLoading(false);
          return;
        }
        const response = await res.json();
        const rawData = response.data as Omit<VideoData, 'versions'> & {
          versions?: Array<Version & { comments?: Comment[] }>;
        };
        const normalizedData: VideoData = {
          ...rawData,
          versions: (rawData.versions || []).map((version) => ({
            ...version,
            comments: Array.isArray(version.comments) ? version.comments : [],
          })),
        };

        setVideo(normalizedData);
        const active = normalizedData.versions?.find((v) => v.isActive) || normalizedData.versions?.[0];
        if (active) setActiveVersionId(active.id);
      } catch (err) {
        console.error('Error fetching video:', err);
        setError('Failed to load video');
      } finally {
        setLoading(false);
      }
    }
    fetchVideo();
  }, [apiBasePath, mode]);

  useEffect(() => {
    if (!activeVersionId) return;
    void fetchVersionComments(activeVersionId, true);
  }, [activeVersionId, fetchVersionComments]);

  // Memoize active version lookup to avoid recalculating on every render
  const activeVersion = useMemo(() => {
    return video?.versions?.find((v) => v.id === activeVersionId) ||
      video?.versions?.find((v) => v.isActive) ||
      video?.versions?.[0];
  }, [video?.versions, activeVersionId]);
  const activeProviderId = activeVersion?.providerId;
  const activeVersionDuration = activeVersion?.duration;

  const isDownloadingVideo = activeDownloadTarget !== null;

  const isVideoDownloadAvailable = useMemo(() => {
    if (!activeVersion || !video?.canDownload) return false;
    if (activeVersion.providerId === 'bunny') return true;
    if (activeVersion.providerId !== 'direct') return false;
    return !!getSafeDirectDownloadUrl(activeVersion.originalUrl);
  }, [activeVersion, video?.canDownload]);

  const handleDownloadVideo = useCallback(async (preference: BunnyDownloadPreference = 'compressed') => {
    if (!activeVersion || !video || isDownloadingVideo) return;
    if (!video.canDownload) {
      toast.error('Download is disabled for this shared link');
      return;
    }
    if (activeVersion.providerId !== 'bunny' && activeVersion.providerId !== 'direct') {
      toast.error('This video source does not support direct download');
      return;
    }

    const target: DownloadTarget = activeVersion.providerId === 'bunny' ? preference : 'direct';
    setActiveDownloadTarget(target);
    try {
      let downloadUrl: string | null = null;

      if (activeVersion.providerId === 'bunny') {
        const prepareRes = await fetch(`/api/versions/${activeVersion.id}/download?source=${preference}&prepare=1`, {
          cache: 'no-store',
        });

        if (!prepareRes.ok) {
          const prepareBody = await prepareRes.json().catch(() => null);
          const fallbackError = preference === 'original'
            ? 'Original file is not available for this video'
            : 'Compressed file is not available for this video';
          const errorMessage = typeof prepareBody?.error === 'string'
            ? prepareBody.error
            : fallbackError;
          throw new Error(errorMessage);
        }

        downloadUrl = `/api/versions/${activeVersion.id}/download?source=${preference}`;
      } else {
        downloadUrl = getSafeDirectDownloadUrl(activeVersion.originalUrl);
        if (!downloadUrl) {
          throw new Error('Direct download URL is not allowed');
        }
      }

      if (!downloadUrl) {
        throw new Error('Missing download URL');
      }

      const versionLabel = activeVersion.versionLabel?.trim() || `v${activeVersion.versionNumber}`;
      const baseName = sanitizeDownloadFileName(`${video.title} ${versionLabel}`) || 'video';
      const a = document.createElement('a');
      a.href = downloadUrl;
      if (activeVersion.providerId === 'direct') {
        a.download = `${baseName}.mp4`;
      }
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (error) {
      console.error('Failed to start video download:', error);
      if (error instanceof Error && error.message === 'Direct download URL is not allowed') {
        toast.error('This direct download host is not allowed');
      } else if (error instanceof Error && error.message) {
        toast.error(error.message);
      } else {
        toast.error('Failed to start download');
      }
    } finally {
      setActiveDownloadTarget(null);
    }
  }, [activeVersion, isDownloadingVideo, video]);

  const getGuestUploadToken = useCallback(async (intent: 'audio' | 'image') => {
    if (!isGuest) return null;

    const response = await fetch(`/api/watch/${videoId}/upload-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { data?: { token?: string }; error?: string }
      | null;
    const token = payload?.data?.token;
    if (!response.ok || !token) {
      throw new Error(payload?.error || 'Failed to prepare upload');
    }
    return token;
  }, [isGuest, videoId]);

  // Memoize comments array
  const comments = useMemo(() => {
    return activeVersion?.comments || [];
  }, [activeVersion]);

  // Memoize filtered comments to avoid filtering on every render
  const filteredComments = useMemo(() => {
    return comments.filter((c) => showResolved || !c.isResolved);
  }, [comments, showResolved]);

  // Memoize sorted comments to avoid sorting on every render
  const sortedComments = useMemo(() => {
    return [...filteredComments].sort((a, b) => a.timestamp - b.timestamp);
  }, [filteredComments]);

  // Memoize duration computation
  const duration = useMemo(() => {
    return videoDuration || activeVersion?.duration || 0;
  }, [videoDuration, activeVersion?.duration]);

  // Memoize embed URL calculation to avoid recalculating on every render
  const embedUrl = useMemo(() => {
    if (!activeVersion) return '';
    if (activeVersion.providerId === 'youtube') {
      const base = `https://www.youtube.com/embed/${activeVersion.videoId}?enablejsapi=1&rel=0&modestbranding=1&controls=0&showinfo=0&iv_load_policy=3&disablekb=1`;
      if (typeof window === 'undefined') return base;
      const origin = window.location.origin;
      return `${base}&origin=${encodeURIComponent(origin)}`;
    }
    if (activeVersion.providerId === 'bunny') {
      return `https://${BUNNY_PULL_ZONE_HOSTNAME}/${activeVersion.videoId}/playlist.m3u8`;
    }
    try {
      const url = new URL(activeVersion.originalUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return '';
      }
      return activeVersion.originalUrl;
    } catch {
      return '';
    }
  }, [activeVersion]);

  const selectedQualityLabel = useMemo(() => {
    if (selectedQualityLevel === -1) return 'Auto';
    return qualityOptions.find((option) => option.level === selectedQualityLevel)?.label ?? 'Auto';
  }, [qualityOptions, selectedQualityLevel]);

  useEffect(() => {
    if (!projectId) return;
    async function fetchTags() {
      try {
        const query = videoId ? `?videoId=${encodeURIComponent(videoId)}` : '';
        const res = await fetch(`/api/projects/${projectId}/tags${query}`);
        if (res.ok) {
          const data = await res.json();
          const tags = data.data || [];
          setAvailableTags(tags);
          if (tags.length > 0 && !selectedTagId) {
            setSelectedTagId(tags[0].id);
          }
        }
      } catch {
      }
    }
    fetchTags();
  }, [projectId, selectedTagId, videoId]);

  // Load YouTube API immediately on component mount (async, non-blocking)
  useEffect(() => {
    // Already loaded
    if (isApiLoaded) return;

    // Already in progress
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

  const flushScheduledWatchProgress = useCallback(async () => {
    if (!video?.isAuthenticated || !activeVersionId || progressWriteInFlightRef.current) return;

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
  }, [video?.isAuthenticated, activeVersionId, videoId]);

  const scheduleWatchProgressSave = useCallback((input: {
    progress: number;
    duration?: number;
    immediate?: boolean;
    force?: boolean;
  }) => {
    if (!video?.isAuthenticated || !activeVersionId) return;

    const progress = Math.max(0, input.progress);
    if (progress <= 0) return;

    const duration = Math.max(0, input.duration ?? videoDuration ?? 0);
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
  }, [video?.isAuthenticated, activeVersionId, videoDuration, flushScheduledWatchProgress]);

  useEffect(() => {
    return () => {
      if (progressDebounceTimerRef.current) {
        clearTimeout(progressDebounceTimerRef.current);
        progressDebounceTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    lastSavedProgressRef.current = 0;
    pendingProgressPayloadRef.current = null;
    progressWriteInFlightRef.current = false;
    if (progressDebounceTimerRef.current) {
      clearTimeout(progressDebounceTimerRef.current);
      progressDebounceTimerRef.current = null;
    }
  }, [videoId, activeVersionId]);

  useEffect(() => {
    if (!canInitializePlayer) return;
    if (!activeProviderId) return;
    const isYoutube = activeProviderId === 'youtube';
    const isBunny = activeProviderId === 'bunny';

    if (isYoutube && !isApiLoaded) return;
    if (!isYoutube && !isBunny) return;

    setIsReady(false);
    setBunnyPlaybackState('none');
    setCurrentTime(0);
    setVideoDuration(0);
    setIsPlaying(false);
    setIsMuted(false);
    setPlaybackSpeed(1);
    setQualityOptions([]);
    setSelectedQualityLevel(-1);
    setIsBunnyPortraitSource(false);

    if (playerRef.current) {
      try { playerRef.current.destroy(); } catch { /* ignore */ }
      playerRef.current = null;
    }
    if (hlsRef.current) {
      try { hlsRef.current.destroy(); } catch { /* ignore */ }
      hlsRef.current = null;
    }
    if (bunnyRetryTimerRef.current) {
      clearTimeout(bunnyRetryTimerRef.current);
      bunnyRetryTimerRef.current = null;
    }

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
                scheduleWatchProgressSave({
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

        let cachedDuration = 0;
        let destroyed = false;
        let retryAttempt = 0;
        let usingHlsJs = false;
        let hlsInstance: Hls | null = null;
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
        const getRetryUrl = () => {
          retryAttempt += 1;
          const separator = embedUrl.includes('?') ? '&' : '?';
          return `${embedUrl}${separator}retry=${Date.now()}-${retryAttempt}`;
        };
        const retryNativeLoad = () => {
          videoEl.src = getRetryUrl();
          videoEl.load();
        };
        const retryHlsLoad = () => {
          if (destroyed || !hlsInstance) return;
          const retryUrl = getRetryUrl();
          try {
            hlsInstance.stopLoad();
          } catch {
            // ignore stop-load failures and continue with a fresh loadSource
          }
          hlsInstance.loadSource(retryUrl);
          hlsInstance.startLoad(-1);
        };

        const syncDuration = () => {
          if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
            cachedDuration = videoEl.duration;
            setVideoDuration(videoEl.duration);
          }
        };

        const saveProgress = () => {
          const current = videoEl.currentTime || 0;
          const duration = Number.isFinite(videoEl.duration) && videoEl.duration > 0 ? videoEl.duration : cachedDuration;
          scheduleWatchProgressSave({
            progress: current,
            duration,
            immediate: true,
            force: true,
          });
        };

        const onLoadedMetadata = () => {
          if (destroyed) return;
          clearRetryTimer();
          setBunnyPlaybackState('none');
          if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
            setIsBunnyPortraitSource(videoEl.videoHeight > videoEl.videoWidth);
          }
          setIsReady(true);
          syncDuration();
        };

        const onPlay = () => {
          setIsPlaying(true);
          setBunnyPlaybackState('none');
          syncDuration();
        };

        const onPause = () => {
          setIsPlaying(false);
          saveProgress();
        };

        const onEnded = () => {
          setIsPlaying(false);
          saveProgress();
        };

        const onTimeUpdate = () => {
          if (!isDraggingRef.current) {
            setCurrentTime(videoEl.currentTime || 0);
          }
          if (Number.isFinite(videoEl.duration) && videoEl.duration > 0 && videoEl.duration !== cachedDuration) {
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
          setIsReady(false);
          setBunnyPlaybackState('processing');
          scheduleRetry(retryNativeLoad);
        };

        videoEl.addEventListener('loadedmetadata', onLoadedMetadata);
        videoEl.addEventListener('play', onPlay);
        videoEl.addEventListener('pause', onPause);
        videoEl.addEventListener('ended', onEnded);
        videoEl.addEventListener('timeupdate', onTimeUpdate);
        videoEl.addEventListener('error', onVideoError);

        const configureHlsLevels = (levels: Level[]) => {
          setQualityOptions(levels.map((level, index) => ({
            level: index,
            label: formatBunnyQualityLabel(level, index),
          })));
          setSelectedQualityLevel(-1);
        };

        if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          videoEl.src = embedUrl;
          videoEl.load();
        } else if (Hls.isSupported()) {
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
            const isManifestLoadFailure = data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
              || data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT;
            const hasProcessingLikeStatus = responseCode === undefined
              || responseCode === 0
              || responseCode === 403
              || responseCode === 404
              || responseCode === 423
              || responseCode === 429
              || responseCode === 503;
            const isLikelyProcessing = isManifestLoadFailure
              && hasProcessingLikeStatus;
            const isNetworkPreMetadataProcessing = data.type === Hls.ErrorTypes.NETWORK_ERROR
              && hasProcessingLikeStatus
              && videoEl.readyState < HTMLMediaElement.HAVE_METADATA;
            const isUnknownPreMetadataProcessing = !data.details
              && !data.type
              && videoEl.readyState < HTMLMediaElement.HAVE_METADATA;
            if (isLikelyProcessing || isNetworkPreMetadataProcessing || isUnknownPreMetadataProcessing) {
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
          getPlayerState: () => (
            videoEl.paused
              ? (window.YT?.PlayerState?.PAUSED ?? 2)
              : (window.YT?.PlayerState?.PLAYING ?? 1)
          ),
          setPlaybackRate: (rate: number) => {
            videoEl.playbackRate = rate;
          },
          destroy: () => {
            destroyed = true;
            clearRetryTimer();
            videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
            videoEl.removeEventListener('play', onPlay);
            videoEl.removeEventListener('pause', onPause);
            videoEl.removeEventListener('ended', onEnded);
            videoEl.removeEventListener('timeupdate', onTimeUpdate);
            videoEl.removeEventListener('error', onVideoError);
            if (hlsRef.current) {
              try { hlsRef.current.destroy(); } catch { /* ignore */ }
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
        try { playerRef.current.destroy(); } catch { /* ignore */ }
        playerRef.current = null;
      }
      if (hlsRef.current) {
        try { hlsRef.current.destroy(); } catch { /* ignore */ }
        hlsRef.current = null;
      }
      if (bunnyRetryTimerRef.current) {
        clearTimeout(bunnyRetryTimerRef.current);
        bunnyRetryTimerRef.current = null;
      }
    };
  }, [activeProviderId, activeVersionId, embedUrl, isApiLoaded, video?.isAuthenticated, videoId, canInitializePlayer, scheduleWatchProgressSave]);

  // Save detected duration to DB if the version doesn't have one stored
  useEffect(() => {
    if (!videoDuration || !activeVersionId || !propProjectId) return;
    if (activeVersionDuration && activeVersionDuration > 0) return;

    const roundedDuration = Math.round(videoDuration);
    // Fire-and-forget PATCH to save duration
    fetch(`/api/projects/${propProjectId}/videos/${videoId}/versions/${activeVersionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: roundedDuration }),
    }).catch(() => { /* ignore save errors */ });

    // Also update local state so the version object has the duration
    setVideo((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        versions: prev.versions.map((v) =>
          v.id === activeVersionId ? { ...v, duration: roundedDuration } : v
        ),
      };
    });
  }, [videoDuration, activeVersionDuration, activeVersionId, propProjectId, videoId]);

  // Load watch progress when video is loaded (authenticated users only)
  const loadWatchProgress = useCallback(async (showPrompt = true) => {
    if (!video?.isAuthenticated || !activeVersionId) return;

    // Reset state
    setSavedProgress(null);
    setShowResumePrompt(false);

    try {
      // Use cache: 'no-store' to always fetch fresh data
      const res = await fetch(`/api/watch/${videoId}/progress`, { cache: 'no-store' });
      if (res.ok) {
        const response = await res.json();
        const progress = response.data?.progress || 0;
        const percentage = response.data?.percentage || 0;

        // Only show resume prompt if progress is between 5% and 95%
        if (showPrompt && percentage > 5 && percentage < 95) {
          setSavedProgress(progress);
          setShowResumePrompt(true);
        }
      }
    } catch (err) {
      console.error('Error loading watch progress:', err);
    }
  }, [video?.isAuthenticated, activeVersionId, videoId]);

  // Load progress on mount and when dependencies change
  useEffect(() => {
    loadWatchProgress();
  }, [loadWatchProgress, progressFetchKey]);

  // Refetch progress when pathname changes (user navigates back to this page)
  useEffect(() => {
    if (lastPathnameRef.current !== pathname) {
      const previousPath = lastPathnameRef.current;
      lastPathnameRef.current = pathname;

      // If we navigated away and came back to this video page, refetch progress
      if (previousPath !== pathname) {
        setProgressFetchKey(k => k + 1);
      }
    }
  }, [pathname]);

  // Save watch progress periodically while playing (authenticated users only)
  useEffect(() => {
    if (!video?.isAuthenticated || !isReady || !activeVersionId) return;

    // Save progress every 5 seconds while playing
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
  }, [video?.isAuthenticated, isReady, videoDuration, activeVersionId, scheduleWatchProgressSave]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => {
        setIsFullscreenMode(true);
        setShowComments(false);
      }).catch((err) => {
        console.error('Fullscreen failed:', err);
        toast.error('Unable to enter fullscreen mode');
      });
    } else {
      document.exitFullscreen().then(() => {
        setIsFullscreenMode(false);
        setShowComments(true);
      }).catch((err) => {
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

  // Save progress when user leaves the page
  useEffect(() => {
    if (!video?.isAuthenticated) return;

    const saveProgressOnLeave = () => {
      // Get current time and duration directly from player instance
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
        // Use sendBeacon for reliable save on page unload
        const data = new Blob([JSON.stringify({
          progress: finalProgress,
          duration: finalDuration,
          versionId: activeVersionId,
        })], { type: 'application/json' });
        navigator.sendBeacon(`/api/watch/${videoId}/progress`, data);
      }
    };

    // Save when tab becomes hidden (user switches tabs, minimizes, etc.)
    const handleVisibilityChange = () => {
      // Get current time and duration directly from player instance
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
  }, [video?.isAuthenticated, currentTime, videoDuration, activeVersionId, videoId, scheduleWatchProgressSave]);

  const handleResumeFromSaved = useCallback(() => {
    if (savedProgress !== null && playerRef.current) {
      if (playerRef.current.seekTo) {
        playerRef.current.seekTo(savedProgress, true);
      }
      setCurrentTime(savedProgress);
      setShowResumePrompt(false);
      setSavedProgress(null);
    }
  }, [savedProgress]);

  // Dismiss resume prompt
  const handleDismissResume = useCallback(() => {
    setShowResumePrompt(false);
    setSavedProgress(null);
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
  }, [isReady, isDragging, activeVersion?.providerId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      const isBunnyBlocked = activeVersion?.providerId === 'bunny' && bunnyPlaybackState !== 'none';
      const isPlaybackControlKey = [
        'Space',
        'KeyK',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Comma',
        'Period',
        'KeyM',
        'KeyJ',
        'KeyL',
      ].includes(e.code);
      if (isBunnyBlocked && isPlaybackControlKey) {
        e.preventDefault();
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
          if (playerRef.current) {
            const newTime = Math.max(0, currentTime - 5);
            if (playerRef.current.seekTo) {
              playerRef.current.seekTo(newTime, true);
            }
            setCurrentTime(newTime);
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (playerRef.current) {
            const newTime = Math.min(duration, currentTime + 5);
            if (playerRef.current.seekTo) {
              playerRef.current.seekTo(newTime, true);
            }
            setCurrentTime(newTime);
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          {
            const speeds = SPEED_OPTIONS;
            const currentIndex = speeds.indexOf(playbackSpeed);
            if (currentIndex < speeds.length - 1) {
              const newSpeed = speeds[currentIndex + 1];
              setPlaybackSpeed(newSpeed);
              playerRef.current?.setPlaybackRate(newSpeed);
            }
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          {
            const speeds = SPEED_OPTIONS;
            const currentIndex = speeds.indexOf(playbackSpeed);
            if (currentIndex > 0) {
              const newSpeed = speeds[currentIndex - 1];
              setPlaybackSpeed(newSpeed);
              playerRef.current?.setPlaybackRate(newSpeed);
            }
          }
          break;
        case 'Comma':
          if (e.shiftKey) {
            e.preventDefault();
            const speeds = SPEED_OPTIONS;
            const currentIndex = speeds.indexOf(playbackSpeed);
            if (currentIndex > 0) {
              const newSpeed = speeds[currentIndex - 1];
              setPlaybackSpeed(newSpeed);
              playerRef.current?.setPlaybackRate(newSpeed);
            }
          }
          break;
        case 'Period':
          if (e.shiftKey) {
            e.preventDefault();
            const speeds = SPEED_OPTIONS;
            const currentIndex = speeds.indexOf(playbackSpeed);
            if (currentIndex < speeds.length - 1) {
              const newSpeed = speeds[currentIndex + 1];
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
  }, [activeVersion?.providerId, bunnyPlaybackState, isPlaying, currentTime, duration, isMuted, playbackSpeed, toggleFullscreen]);

  const handlePlayPause = useCallback(() => {
    if (activeVersion?.providerId === 'bunny' && bunnyPlaybackState !== 'none') return;
    if (!playerRef.current) return;
    if (isPlaying) {
      playerRef.current.pauseVideo();
    } else {
      playerRef.current.playVideo();
    }
  }, [activeVersion?.providerId, bunnyPlaybackState, isPlaying]);

  const handleSeekToTimestamp = useCallback((timestamp: number, annotation?: string | null) => {
    setCurrentTime(timestamp);
    if (playerRef.current?.seekTo) {
      const playerState = playerRef.current.getPlayerState?.();
      const ytPlayingState = window.YT?.PlayerState?.PLAYING ?? 1;
      const ytBufferingState = window.YT?.PlayerState?.BUFFERING ?? 3;
      const wasPlayingBeforeSeek = typeof playerState === 'number'
        ? playerState === ytPlayingState || playerState === ytBufferingState
        : isPlaying;

      playerRef.current.seekTo(timestamp, true);
      // Preserve playback state when seeking so timeline clicks do not force-pause.
      if (wasPlayingBeforeSeek) {
        playerRef.current.playVideo();
      } else {
        playerRef.current.pauseVideo();
      }
    }
    // Show annotation overlay if present
    if (annotation) {
      try {
        const strokes = JSON.parse(annotation) as AnnotationStroke[];
        setViewingAnnotation(strokes);
      } catch {
        setViewingAnnotation(null);
      }
    } else {
      setViewingAnnotation(null);
    }
  }, [isPlaying]);

  const handleMuteToggle = useCallback(() => {
    if (!playerRef.current) return;
    if (isMuted) {
      playerRef.current.unMute();
    } else {
      playerRef.current.mute();
    }
    setIsMuted(!isMuted);
  }, [isMuted]);

  const handleSkip = useCallback(
    (seconds: number) => {
      const newTime = Math.max(0, Math.min(duration, currentTime + seconds));
      handleSeekToTimestamp(newTime);
    },
    [currentTime, duration, handleSeekToTimestamp]
  );

  const handleSpeedChange = useCallback(
    (speed: number) => {
      setPlaybackSpeed(speed);
      playerRef.current?.setPlaybackRate(speed);
    },
    []
  );

  const handleQualityChange = useCallback((level: number) => {
    const hls = hlsRef.current;
    if (!hls) return;

    if (level === -1) {
      hls.currentLevel = -1;
      hls.nextLevel = -1;
      setSelectedQualityLevel(-1);
      return;
    }

    hls.currentLevel = level;
    hls.nextLevel = level;
    setSelectedQualityLevel(level);
  }, []);

  const handleTimelineClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!timelineRef.current) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percentage = Math.max(0, Math.min(1, x / rect.width));
      const newTime = percentage * duration;
      handleSeekToTimestamp(newTime);
    },
    [duration, handleSeekToTimestamp]
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
    [isDragging, duration]
  );

  const handleTimelineMouseUp = useCallback(() => {
    if (isDragging) {
      handleSeekToTimestamp(currentTime);
      setIsDragging(false);
    }
  }, [isDragging, currentTime, handleSeekToTimestamp]);

  const handleAddComment = useCallback(async (voiceData?: { url: string; duration: number }) => {
    if (!voiceData && !imageBlob && !commentText.trim() && !annotationStrokes && !isAnnotating) return;
    if (!activeVersion) return;

    // Auto-capture strokes from canvas if still in draw mode
    let effectiveStrokes = annotationStrokes;
    if (isAnnotating && annotationCanvasRef.current) {
      const canvasStrokes = annotationCanvasRef.current.getStrokes();
      if (canvasStrokes.length > 0) {
        effectiveStrokes = canvasStrokes;
      }
    }

    const tempId = `temp-${Date.now()}`;
    const serializedAnnotation = effectiveStrokes ? JSON.stringify(effectiveStrokes) : null;
    const optimisticComment: Comment = {
      id: tempId,
      content: (voiceData || imageBlob) ? commentText.trim() || null : commentText,
      timestamp: selectedTimestamp ?? currentTime,
      voiceUrl: voiceData?.url ?? null,
      voiceDuration: voiceData?.duration ?? null,
      imageUrl: imageBlob ? URL.createObjectURL(imageBlob) : null,
      annotationData: serializedAnnotation,
      isResolved: false,
      createdAt: new Date().toISOString(),
      author: isGuest ? null : { id: 'current-user', name: currentUserName, image: null },
      guestName: isGuest ? normalizedGuestName : null,
      canEdit: true,
      canDelete: true,
      tag: availableTags.find(t => t.id === selectedTagId) || null,
      replies: [],
    };

    setVideo((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        versions: prev.versions.map((v) =>
          v.id === activeVersionId
            ? { ...v, comments: [...v.comments, optimisticComment] }
            : v
        ),
      };
    });

    setCommentText('');
    setSelectedTimestamp(null);
    setSelectedTagId(availableTags.length > 0 ? availableTags[0].id : null);
    setAudioBlob(null);
    setImageBlob(null);
    setAnnotationStrokes(null);
    setIsAnnotating(false);
    setViewingAnnotation(effectiveStrokes || null);

    setIsSubmittingComment(true);
    isMutatingRef.current = true;

    try {
      let imageData: { url: string } | undefined;

      if (imageBlob) {
        setIsUploadingImage(true);
        const imageFormData = new FormData();
        imageFormData.append('image', imageBlob);
        imageFormData.append('videoId', videoId);
        const uploadToken = await getGuestUploadToken('image');
        if (uploadToken) imageFormData.append('uploadToken', uploadToken);

        const imageRes = await fetch('/api/upload/image', {
          method: 'POST',
          body: imageFormData,
        });

        if (!imageRes.ok) throw new Error('Failed to upload image');
        const imageDataResponse = await imageRes.json();
        imageData = { url: imageDataResponse.data.url };
      }

      const res = await fetch(`/api/versions/${activeVersion.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: (voiceData || imageBlob) ? commentText.trim() || null : commentText,
          timestamp: selectedTimestamp ?? currentTime,
          ...(voiceData && { voiceUrl: voiceData.url, voiceDuration: voiceData.duration }),
          ...(imageData && { imageUrl: imageData.url }),
          ...(isGuest && normalizedGuestName && { guestName: normalizedGuestName }),
          ...(selectedTagId && { tagId: selectedTagId }),
          ...(serializedAnnotation && { annotationData: serializedAnnotation }),
        }),
      });

      if (res.ok) {
        const response = await res.json();
        const newComment = response.data;
        setVideo((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            versions: prev.versions.map((v) =>
              v.id === activeVersionId
                ? { ...v, comments: v.comments.map(c => c.id === tempId ? { ...newComment, replies: newComment.replies || [] } : { ...c, replies: c.replies || [] }) }
                : v
            ),
          };
        });
      } else {
        setVideo((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            versions: prev.versions.map((v) =>
              v.id === activeVersionId
                ? { ...v, comments: v.comments.filter(c => c.id !== tempId) }
                : v
            ),
          };
        });
        toast.error('Failed to add comment');
      }
    } catch {
      setVideo((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          versions: prev.versions.map((v) =>
            v.id === activeVersionId
              ? { ...v, comments: v.comments.filter(c => c.id !== tempId) }
              : v
          ),
        };
      });
      toast.error('Failed to add comment');
    } finally {
      setIsSubmittingComment(false);
      setIsUploadingImage(false);
      isMutatingRef.current = false;
    }
  }, [commentText, currentTime, selectedTimestamp, activeVersion, activeVersionId, isGuest, normalizedGuestName, currentUserName, selectedTagId, availableTags, imageBlob, annotationStrokes, isAnnotating, videoId, getGuestUploadToken]);

  const handleImageSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>, isReply: boolean = false) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be less than 10MB');
      return;
    }

    if (isReply) {
      setReplyImageBlob(file);
    } else {
      setImageBlob(file);
    }
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>, isReply: boolean = false) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          if (file.size > 10 * 1024 * 1024) {
            toast.error('Image must be less than 10MB');
            return;
          }
          if (isReply) {
            setReplyImageBlob(file);
          } else {
            setImageBlob(file);
          }
          e.preventDefault();
          break;
        }
      }
    }
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });

      audioChunksRef.current = [];
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        setAudioBlob(blob);
        stream.getTracks().forEach((track) => track.stop());
        if (recordingTimerRef.current) {
          clearInterval(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }
      };

      mediaRecorder.start(100);
      setIsRecording(true);
      setRecordingTime(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 0.1);
      }, 100);
    } catch (err) {
      console.error('Failed to start recording:', err);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    setAudioBlob(null);
    setRecordingTime(0);
  }, []);

  const submitVoiceComment = useCallback(async () => {
    if (!audioBlob || !activeVersion) return;
    setIsUploadingAudio(true);

    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');
      formData.append('videoId', videoId);
      const uploadToken = await getGuestUploadToken('audio');
      if (uploadToken) formData.append('uploadToken', uploadToken);

      const uploadRes = await fetch('/api/upload/audio', {
        method: 'POST',
        body: formData,
      });

      if (!uploadRes.ok) {
        throw new Error('Failed to upload audio');
      }

      const uploadData = await uploadRes.json();
      const { url } = uploadData.data;

      await handleAddComment({ url, duration: recordingTime });
      setAudioBlob(null);
      setRecordingTime(0);
    } catch (err) {
      console.error('Failed to submit voice comment:', err);
    } finally {
      setIsUploadingAudio(false);
    }
  }, [audioBlob, activeVersion, recordingTime, handleAddComment, videoId, getGuestUploadToken]);

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
        const dur = isFinite(audio.duration) && audio.duration > 0
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

  const playVoice = useCallback((commentId: string, voiceUrl: string, knownDuration?: number) => {
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

    audio.play();
  }, [playingVoiceId, voicePlaybackRate, startVoiceTracking, stopVoiceTracking]);

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
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
    };
  }, [stopVoiceTracking]);

  const submitCommentWithMedia = useCallback(async () => {
    if (!activeVersion) return;

    // If we only have audio, handle it via submitVoiceComment for backwards compatibility conceptually
    if (audioBlob && !imageBlob && !commentText.trim()) {
      submitVoiceComment();
      return;
    }

    if (audioBlob) setIsUploadingAudio(true);
    if (imageBlob) setIsUploadingImage(true);

    try {
      let voiceData: { url: string; duration: number } | undefined;
      if (audioBlob) {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');
        formData.append('videoId', videoId);
        const uploadToken = await getGuestUploadToken('audio');
        if (uploadToken) formData.append('uploadToken', uploadToken);
        const uploadRes = await fetch('/api/upload/audio', { method: 'POST', body: formData });
        if (!uploadRes.ok) throw new Error('Failed to upload audio');
        const uploadData = await uploadRes.json();
        voiceData = { url: uploadData.data.url, duration: recordingTime };
      }

      await handleAddComment(voiceData); // Image is uploaded inside handleAddComment for both text/image cases

      setAudioBlob(null);
      setRecordingTime(0);
      setImageBlob(null);
      if (imageInputRef.current) imageInputRef.current.value = '';
    } catch (err) {
      console.error('Failed to submit comment with media:', err);
      toast.error('Failed to upload media');
    } finally {
      setIsUploadingAudio(false);
      setIsUploadingImage(false);
    }
  }, [audioBlob, imageBlob, activeVersion, recordingTime, commentText, submitVoiceComment, handleAddComment, videoId, getGuestUploadToken]);

  const handleResolveComment = useCallback(
    async (commentId: string, currentlyResolved: boolean) => {
      if (!video?.canResolveComments) {
        toast.error('Only admins can resolve comments');
        return;
      }

      isMutatingRef.current = true;
      setVideo((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          versions: prev.versions.map((v) =>
            v.id === activeVersionId
              ? {
                ...v,
                comments: v.comments.map((c) =>
                  c.id === commentId ? { ...c, isResolved: !c.isResolved } : c
                ),
              }
              : v
          ),
        };
      });

      try {
        const res = await fetch(`/api/comments/${commentId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isResolved: !currentlyResolved }),
        });

        if (!res.ok) {
          setVideo((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              versions: prev.versions.map((v) =>
                v.id === activeVersionId
                  ? {
                    ...v,
                    comments: v.comments.map((c) =>
                      c.id === commentId ? { ...c, isResolved: currentlyResolved } : c
                    ),
                  }
                  : v
              ),
            };
          });
          toast.error('Failed to update comment');
        }
      } catch {
        setVideo((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            versions: prev.versions.map((v) =>
              v.id === activeVersionId
                ? {
                  ...v,
                  comments: v.comments.map((c) =>
                    c.id === commentId ? { ...c, isResolved: currentlyResolved } : c
                  ),
                }
                : v
            ),
          };
        });
        toast.error('Failed to update comment');
      } finally {
        isMutatingRef.current = false;
      }
    },
    [activeVersionId, video?.canResolveComments]
  );

  const handleReplyComment = useCallback(async (parentId: string, voiceData?: { url: string; duration: number }, imageData?: { url: string }) => {
    if (!voiceData && !replyImageBlob && !replyText.trim()) return;
    if (!activeVersion) return;

    const tempId = `temp-reply-${Date.now()}`;
    const parentComment = comments.find((c) => c.id === parentId);
    const optimisticReply = {
      id: tempId,
      content: (voiceData || replyImageBlob) ? replyText.trim() || null : replyText,
      voiceUrl: voiceData?.url ?? null,
      voiceDuration: voiceData?.duration ?? null,
      imageUrl: replyImageBlob ? URL.createObjectURL(replyImageBlob) : null,
      annotationData: null,
      createdAt: new Date().toISOString(),
      author: isGuest ? null : { id: 'current-user', name: currentUserName, image: null },
      guestName: isGuest ? normalizedGuestName : null,
      canEdit: true,
      canDelete: true,
      tag: null,
    };

    setVideo((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        versions: prev.versions.map((v) =>
          v.id === activeVersionId
            ? {
              ...v,
              comments: v.comments.map((c) =>
                c.id === parentId
                  ? { ...c, replies: [...(c.replies || []), optimisticReply] }
                  : c
              ),
            }
            : v
        ),
      };
    });

    setReplyText('');
    setReplyingTo(null);
    setReplyAudioBlob(null);
    setReplyRecordingTime(0);
    setReplyImageBlob(null);

    setIsSubmittingReply(true);
    isMutatingRef.current = true;

    try {
      let submittedImageData: { url: string } | undefined = imageData;

      if (replyImageBlob && !imageData) {
        setIsUploadingReplyImage(true);
        const imageFormData = new FormData();
        imageFormData.append('image', replyImageBlob);
        imageFormData.append('videoId', videoId);
        const uploadToken = await getGuestUploadToken('image');
        if (uploadToken) imageFormData.append('uploadToken', uploadToken);

        const imageRes = await fetch('/api/upload/image', {
          method: 'POST',
          body: imageFormData,
        });

        if (!imageRes.ok) throw new Error('Failed to upload image reply');
        const imageDataResponse = await imageRes.json();
        submittedImageData = { url: imageDataResponse.data.url };
      }

      const res = await fetch(`/api/versions/${activeVersion.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: (voiceData || submittedImageData) ? replyText.trim() || null : replyText,
          timestamp: parentComment?.timestamp ?? currentTime,
          parentId,
          ...(voiceData && { voiceUrl: voiceData.url, voiceDuration: voiceData.duration }),
          ...(submittedImageData && { imageUrl: submittedImageData.url }),
          ...(isGuest && normalizedGuestName && { guestName: normalizedGuestName }),
        }),
      });

      if (res.ok) {
        const response = await res.json();
        const newReply = response.data;
        setVideo((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            versions: prev.versions.map((v) =>
              v.id === activeVersionId
                ? {
                  ...v,
                  comments: v.comments.map((c) =>
                    c.id === parentId
                      ? { ...c, replies: (c.replies || []).map(r => r.id === tempId ? newReply : r) }
                      : { ...c, replies: c.replies || [] }
                  ),
                }
                : v
            ),
          };
        });
      } else {
        setVideo((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            versions: prev.versions.map((v) =>
              v.id === activeVersionId
                ? {
                  ...v,
                  comments: v.comments.map((c) =>
                    c.id === parentId
                      ? { ...c, replies: (c.replies || []).filter(r => r.id !== tempId) }
                      : c
                  ),
                }
                : v
            ),
          };
        });
        toast.error('Failed to add reply');
      }
    } catch {
      setVideo((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          versions: prev.versions.map((v) =>
            v.id === activeVersionId
              ? {
                ...v,
                comments: v.comments.map((c) =>
                  c.id === parentId
                    ? { ...c, replies: (c.replies || []).filter(r => r.id !== tempId) }
                    : c
                ),
              }
              : v
          ),
        };
      });
      toast.error('Failed to add reply');
    } finally {
      setIsSubmittingReply(false);
      setIsUploadingReplyImage(false);
      isMutatingRef.current = false;
    }
  }, [replyText, activeVersion, activeVersionId, comments, currentTime, isGuest, normalizedGuestName, currentUserName, replyImageBlob, videoId, getGuestUploadToken]);

  const startReplyRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });
      replyAudioChunksRef.current = [];
      replyMediaRecorderRef.current = mediaRecorder;
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) replyAudioChunksRef.current.push(e.data);
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(replyAudioChunksRef.current, { type: 'audio/webm' });
        setReplyAudioBlob(blob);
        stream.getTracks().forEach((track) => track.stop());
        if (replyRecordingTimerRef.current) {
          clearInterval(replyRecordingTimerRef.current);
          replyRecordingTimerRef.current = null;
        }
      };
      mediaRecorder.start(100);
      setIsReplyRecording(true);
      setReplyRecordingTime(0);
      replyRecordingTimerRef.current = setInterval(() => {
        setReplyRecordingTime((prev) => prev + 0.1);
      }, 100);
    } catch (err) {
      console.error('Failed to start reply recording:', err);
    }
  }, []);

  const stopReplyRecording = useCallback(() => {
    if (replyMediaRecorderRef.current && replyMediaRecorderRef.current.state !== 'inactive') {
      replyMediaRecorderRef.current.stop();
    }
    setIsReplyRecording(false);
  }, []);

  const cancelReplyRecording = useCallback(() => {
    if (replyMediaRecorderRef.current && replyMediaRecorderRef.current.state !== 'inactive') {
      replyMediaRecorderRef.current.stop();
    }
    setIsReplyRecording(false);
    setReplyAudioBlob(null);
    setReplyRecordingTime(0);
  }, []);

  const submitVoiceReply = useCallback(async (parentId: string) => {
    if (!replyAudioBlob || !activeVersion) return;
    setIsUploadingReplyAudio(true);
    try {
      const formData = new FormData();
      formData.append('audio', replyAudioBlob, 'recording.webm');
      formData.append('videoId', videoId);
      const uploadToken = await getGuestUploadToken('audio');
      if (uploadToken) formData.append('uploadToken', uploadToken);
      const uploadRes = await fetch('/api/upload/audio', { method: 'POST', body: formData });
      if (!uploadRes.ok) throw new Error('Failed to upload audio');
      const uploadData = await uploadRes.json();
      const { url } = uploadData.data;
      await handleReplyComment(parentId, { url, duration: replyRecordingTime });
    } catch (err) {
      console.error('Failed to submit voice reply:', err);
    } finally {
      setIsUploadingReplyAudio(false);
    }
  }, [replyAudioBlob, activeVersion, replyRecordingTime, handleReplyComment, videoId, getGuestUploadToken]);

  const submitReplyWithMedia = useCallback(async (parentId: string) => {
    if (!activeVersion) return;

    if (replyAudioBlob && !replyImageBlob && !replyText.trim()) {
      submitVoiceReply(parentId);
      return;
    }

    if (replyAudioBlob) setIsUploadingReplyAudio(true);
    if (replyImageBlob) setIsUploadingReplyImage(true);

    try {
      let voiceData: { url: string; duration: number } | undefined;

      if (replyAudioBlob) {
        const formData = new FormData();
        formData.append('audio', replyAudioBlob, 'recording.webm');
        formData.append('videoId', videoId);
        const uploadToken = await getGuestUploadToken('audio');
        if (uploadToken) formData.append('uploadToken', uploadToken);
        const uploadRes = await fetch('/api/upload/audio', { method: 'POST', body: formData });
        if (!uploadRes.ok) throw new Error('Failed to upload audio reply');
        const uploadData = await uploadRes.json();
        voiceData = { url: uploadData.data.url, duration: replyRecordingTime };
      }

      await handleReplyComment(parentId, voiceData);

      setReplyAudioBlob(null);
      setReplyRecordingTime(0);
      setReplyImageBlob(null);
      if (replyImageInputRef.current) replyImageInputRef.current.value = '';
    } catch (err) {
      console.error('Failed to submit reply with media:', err);
      toast.error('Failed to upload media');
    } finally {
      setIsUploadingReplyAudio(false);
      setIsUploadingReplyImage(false);
    }
  }, [replyAudioBlob, replyImageBlob, activeVersion, replyRecordingTime, replyText, submitVoiceReply, handleReplyComment, videoId, getGuestUploadToken]);

  const handleEditComment = useCallback(async (commentId: string) => {
    if (!editText.trim() && !editAnnotationData) return;
    setIsSubmittingEdit(true);
    isMutatingRef.current = true;

    // Auto-capture strokes from edit canvas if still drawing
    let finalAnnotationData = editAnnotationData;
    if (isEditingAnnotation && editAnnotationCanvasRef.current) {
      const strokes = editAnnotationCanvasRef.current.getStrokes();
      if (strokes.length > 0) {
        finalAnnotationData = JSON.stringify(strokes);
      }
    }

    try {
      const body: Record<string, unknown> = { content: editText };
      if (editTagId !== undefined) body.tagId = editTagId;
      if (finalAnnotationData !== undefined) body.annotationData = finalAnnotationData;
      if (isGuest && normalizedGuestName) body.guestName = normalizedGuestName;
      const res = await fetch(`/api/comments/${commentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const editedTag = editTagId ? availableTags.find(t => t.id === editTagId) || null : null;
        setVideo((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            versions: prev.versions.map((v) =>
              v.id === activeVersionId
                ? {
                  ...v,
                  comments: v.comments.map((c) => {
                    if (c.id === commentId) return { ...c, content: editText.trim(), tag: editTagId !== undefined ? editedTag : c.tag, annotationData: finalAnnotationData !== undefined ? finalAnnotationData : c.annotationData };
                    return {
                      ...c,
                      replies: (c.replies || []).map((r) =>
                        r.id === commentId ? { ...r, content: editText.trim() } : r
                      ),
                    };
                  }),
                }
                : v
            ),
          };
        });
        setEditingCommentId(null);
        setEditText('');
        setEditTagId(null);
        setEditAnnotationData(undefined);
        setIsEditingAnnotation(false);
        // Update the viewing overlay if it was showing this annotation
        if (finalAnnotationData !== undefined && finalAnnotationData) {
          try {
            setViewingAnnotation(JSON.parse(finalAnnotationData));
          } catch { /* ignore parse errors */ }
        } else if (finalAnnotationData === null) {
          setViewingAnnotation(null);
        }
      }
    } catch (err) {
      console.error('Failed to edit comment:', err);
    } finally {
      setIsSubmittingEdit(false);
      isMutatingRef.current = false;
    }
  }, [editText, editTagId, editAnnotationData, isEditingAnnotation, activeVersionId, availableTags, isGuest, normalizedGuestName]);

  const handleDeleteComment = useCallback(async (commentId: string) => {
    setDeletingCommentId(commentId);
    isMutatingRef.current = true;

    const previousVideo = video;
    setVideo((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        versions: prev.versions.map((v) =>
          v.id === activeVersionId
            ? {
              ...v,
              comments: v.comments
                .filter((c) => c.id !== commentId)
                .map((c) => ({
                  ...c,
                  replies: c.replies?.filter((r) => r.id !== commentId) || [],
                })),
            }
            : v
        ),
      };
    });

    try {
      const res = await fetch(`/api/comments/${commentId}`, { method: 'DELETE' });
      if (!res.ok) {
        setVideo(previousVideo);
      }
    } catch (err) {
      console.error('Failed to delete comment:', err);
      setVideo(previousVideo);
    } finally {
      setDeletingCommentId(null);
      isMutatingRef.current = false;
    }
  }, [activeVersionId, video]);

  // Comment polling with Page Visibility API to pause when tab is hidden
  useEffect(() => {
    if (!activeVersionId) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;
    let isPageVisible = true;

    const poll = async () => {
      try {
        if (isMutatingRef.current || !isPageVisible) return;
        await fetchVersionComments(activeVersionId, true);
      } catch { /* silent */ }
    };

    // Start polling
    intervalId = setInterval(poll, 10000);

    // Handle page visibility change
    const handleVisibilityChange = () => {
      isPageVisible = document.visibilityState === 'visible';
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [activeVersionId, fetchVersionComments]);

  const handleNewVersionUrlChange = (url: string) => {
    setNewVersionUrl(url);
    setNewVersionUrlError('');
    if (!url.trim()) {
      setNewVersionSource(null);
      return;
    }
    const source = parseVideoUrl(url);
    if (source) {
      setNewVersionSource(source);
    } else {
      setNewVersionSource(null);
      if (url.length > 10) setNewVersionUrlError('Unsupported URL');
    }
  };

  const handleCreateVersion = async () => {
    if (!propProjectId) return;
    setIsCreatingVersion(true);
    setNewVersionUploadStatus('');
    setNewVersionUploadProgress(0);
    let uploadedBunnyVideoId: string | null = null;
    let uploadedBunnyUploadToken: string | null = null;

    try {
      let finalVideoUrl = '';
      let finalProviderId = '';
      let finalProviderVideoId = '';
      let finalThumbnailUrl: string | null = null;
      let finalDuration: number | null = null;

      if (newVersionMode === 'url') {
        if (!newVersionSource) throw new Error('Invalid URL');
        const meta = await fetchVideoMetadata(newVersionSource);
        finalVideoUrl = newVersionSource.originalUrl;
        finalProviderId = newVersionSource.providerId;
        finalProviderVideoId = newVersionSource.videoId;
        finalThumbnailUrl = getThumbnailUrl(newVersionSource, 'large');
        finalDuration = meta?.duration || null;
      } else {
        if (!newVersionFile) throw new Error('No file selected');
        let title = newVersionFile.name;
        if (newVersionLabel.trim()) {
          title = newVersionLabel.trim();
        } else {
          title = title.replace(/\.[^/.]+$/, '');
        }

        setNewVersionUploadStatus('Initializing upload...');
        const initRes = await fetch(`/api/projects/${propProjectId}/videos/bunny-init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title })
        });

        if (!initRes.ok) throw new Error('Failed to initialize upload');
        const { data: { videoId, libraryId, signature, expirationTime, uploadToken } } = await initRes.json();
        uploadedBunnyVideoId = videoId;
        uploadedBunnyUploadToken = uploadToken;

        await new Promise((resolve, reject) => {
          setNewVersionUploadStatus('Uploading video...');
          const upload = new tus.Upload(newVersionFile, {
            endpoint: 'https://video.bunnycdn.com/tusupload',
            retryDelays: [0, 3000, 5000, 10000, 20000],
            headers: {
              AuthorizationSignature: signature,
              AuthorizationExpire: expirationTime.toString(),
              VideoId: videoId,
              LibraryId: libraryId,
            },
            metadata: {
              filetype: newVersionFile.type,
              title: title,
            },
            onError: (error) => reject(new Error('Upload failed: ' + error.message)),
            onProgress: (bytesUploaded, bytesTotal) => {
              const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(1);
              setNewVersionUploadProgress(Number(percentage));
              setNewVersionUploadStatus(`Uploading... ${percentage}%`);
            },
            onSuccess: () => {
              setNewVersionUploadStatus('Processing video...');
              resolve(true);
            },
          });
          upload.start();
        });

        finalVideoUrl = `https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}`;
        finalProviderId = 'bunny';
        finalProviderVideoId = videoId;
        finalThumbnailUrl = `https://vz-965f4f4a-fc1.b-cdn.net/${videoId}/thumbnail.jpg`;
      }

      const res = await fetch(`/api/projects/${propProjectId}/videos/${videoId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrl: finalVideoUrl,
          providerId: finalProviderId,
          providerVideoId: finalProviderVideoId,
          uploadToken: uploadedBunnyUploadToken,
          versionLabel: newVersionLabel.trim() || null,
          thumbnailUrl: finalThumbnailUrl,
          duration: finalDuration,
          setActive: true,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'Failed to create version');
      }

      const versionData = await res.json();
      const newVersion = versionData.data;
      // Optimistically add the new version to local state instead of refetching
      setVideo((prev) => {
        if (!prev) return prev;
        const updatedVersions = prev.versions.map(v => ({ ...v, isActive: false }));
        const createdVersion = {
          ...newVersion,
          comments: [],
        };
        updatedVersions.unshift(createdVersion);
        return { ...prev, versions: updatedVersions };
      });
      setActiveVersionId(newVersion.id);
      setShowVersionDialog(false);
      setNewVersionUrl('');
      setNewVersionLabel('');
      setNewVersionSource(null);
      setNewVersionFile(null);
      setNewVersionUploadStatus('');
    } catch (err) {
      const errorObj = err as Error;
      if (uploadedBunnyVideoId && uploadedBunnyUploadToken) {
        await fetch(`/api/projects/${propProjectId}/videos/bunny-init`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: uploadedBunnyVideoId, uploadToken: uploadedBunnyUploadToken }),
        }).catch((cleanupError) => {
          console.error('Failed to cleanup pending Bunny version upload:', cleanupError);
        });
      }
      console.error('Failed to create version:', errorObj);
      toast.error(errorObj.message || 'Failed to create version');
    } finally {
      setIsCreatingVersion(false);
    }
  };

  // Version deletion
  const [showDeleteVersionDialog, setShowDeleteVersionDialog] = useState(false);
  const [versionToDelete, setVersionToDelete] = useState<string | null>(null);
  const [isDeletingVersion, setIsDeletingVersion] = useState(false);

  const handleDeleteVersion = async () => {
    if (!versionToDelete || !propProjectId) return;
    setIsDeletingVersion(true);
    try {
      const res = await fetch(
        `/api/projects/${propProjectId}/videos/${videoId}/versions/${versionToDelete}`,
        { method: 'DELETE' }
      );
      if (res.ok) {
        setVideo((prev) => {
          if (!prev) return prev;
          const remaining = prev.versions.filter((v) => v.id !== versionToDelete);
          return { ...prev, versions: remaining };
        });
        // If deleted version was active, switch to the first remaining
        if (activeVersionId === versionToDelete && video) {
          const remaining = video.versions.filter((v) => v.id !== versionToDelete);
          if (remaining.length > 0) setActiveVersionId(remaining[0].id);
        }
        setShowDeleteVersionDialog(false);
        setVersionToDelete(null);
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to delete version');
      }
    } catch {
      toast.error('Failed to delete version');
    } finally {
      setIsDeletingVersion(false);
    }
  };


  const containerHeight = 'h-screen';
  const backHref = mode === 'dashboard'
    ? `/projects/${propProjectId}`
    : (video?.projectId ? `/projects/${video.projectId}` : '/');
  const isBunnyVersion = activeVersion?.providerId === 'bunny';
  const showBunnyProcessingOverlay = isBunnyVersion && bunnyPlaybackState === 'processing';
  const showBunnyErrorOverlay = isBunnyVersion && bunnyPlaybackState === 'error';

  if (loading) {
    return (
      <div className={cn(containerHeight, 'flex flex-col bg-background overflow-hidden')}>
        <div className="flex-1 flex overflow-hidden min-h-0">
          <div className={cn("flex-1 flex flex-col overflow-hidden min-h-0", isFullscreenMode && "relative")}>
            <div className={cn("shrink-0 flex items-center justify-between h-12 px-4 border-b bg-background/50", isFullscreenMode && cursorIdle && isPlaying && "opacity-0 pointer-events-none transition-opacity duration-300")}>
              <div className="flex items-center gap-3">
                <Skeleton className="h-4 w-12" />
                <Separator orientation="vertical" className="h-5" />
                <div className="flex items-center gap-2">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-4 w-24" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-32 rounded-md" />
                {mode === 'dashboard' && <Skeleton className="h-8 w-28 rounded-md" />}
              </div>
            </div>
            <div className="flex-1 bg-black min-h-0" />
            <div className={cn("shrink-0 px-4 py-2 bg-background border-t", isFullscreenMode && cursorIdle && isPlaying && "opacity-0 pointer-events-none transition-opacity duration-300")}>
              <div className="flex items-center gap-1 mb-2">
                <Skeleton className="h-8 w-8 rounded-md" />
                <Skeleton className="h-8 w-8 rounded-md" />
                <Skeleton className="h-8 w-8 rounded-md" />
                <Skeleton className="h-8 w-8 rounded-md" />
                <Skeleton className="h-4 w-24 ml-1" />
                <div className="ml-auto">
                  <Skeleton className="h-8 w-12 rounded-md" />
                </div>
              </div>
              <Skeleton className="h-8 w-full rounded" />
            </div>
          </div>
          <div className={cn("hidden lg:flex w-80 shrink-0 border-l bg-card flex-col overflow-hidden", isFullscreenMode && !showComments && "hidden")}>
            <div className="shrink-0 flex items-center justify-between p-4 border-b">
              <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-5" />
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-5 w-6 rounded-full" />
              </div>
              <Skeleton className="h-8 w-28 rounded-md" />
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <Skeleton className="h-6 w-6 rounded-full" />
                      <Skeleton className="h-4 w-20" />
                    </div>
                    <Skeleton className="h-5 w-14 rounded" />
                  </div>
                  <Skeleton className="h-4 w-full mb-1" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ))}
            </div>
            <div className="shrink-0 border-t p-4">
              <Skeleton className="h-20 w-full rounded-md" />
              <div className="flex items-center justify-between mt-2">
                <Skeleton className="h-8 w-8 rounded-md" />
                <Skeleton className="h-8 w-20 rounded-md" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !video || !activeVersion) {
    return (
      <div className={cn(containerHeight, 'flex items-center justify-center bg-background')}>
        <div className="text-center">
          <p className="text-muted-foreground mb-4">{error || 'Video not found'}</p>
          <Button asChild variant="outline">
            <Link href={mode === 'dashboard' ? `/projects/${propProjectId}` : '/'}>
              {mode === 'dashboard' ? 'Back to Project' : 'Go Home'}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  if (mode === 'watch' && isGuest && !guestNameConfirmed) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="w-full max-w-sm mx-auto p-6">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 mb-4">
              <User className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-xl font-semibold mb-1">Welcome to OpenFrame</h1>
            <p className="text-sm text-muted-foreground">
              Enter your name to view and comment on this video
            </p>
          </div>
          <div className="space-y-3">
            <Input
              placeholder="Your name"
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && guestName.trim()) {
                  localStorage.setItem('openframe_guest_name', guestName.trim());
                  setGuestNameConfirmed(true);
                }
              }}
              autoFocus
            />
            <Button
              className="w-full"
              disabled={!guestName.trim()}
              onClick={() => {
                localStorage.setItem('openframe_guest_name', guestName.trim());
                setGuestNameConfirmed(true);
              }}
            >
              Continue
            </Button>
          </div>
          <p className="text-xs text-muted-foreground text-center mt-4">
            Or{' '}
            <Link href="/login" className="text-primary hover:underline">
              sign in
            </Link>{' '}
            for a full account
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(containerHeight, 'flex flex-col bg-background overflow-hidden')}
      onMouseUp={handleTimelineMouseUp}
      onMouseLeave={() => isDragging && handleTimelineMouseUp()}
    >
      <div className="flex-1 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden min-h-0">
        <div className={cn("flex-1 w-full flex flex-col min-h-0", isFullscreenMode && "relative")}>
          <div className={cn(
            "shrink-0 flex items-center justify-between h-12 px-4 border-b bg-background/50",
            isFullscreenMode ? "absolute top-0 left-0 right-0 z-50 transition-opacity duration-300" : "",
            isFullscreenMode && cursorIdle && isPlaying && "opacity-0 pointer-events-none"
          )}>
            <div className="flex items-center gap-3">
              <Link
                href={backHref}
                className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-4 w-4 mr-1" />
                Back
              </Link>
              <Separator orientation="vertical" className="h-5" />
              <div className="hidden sm:block min-w-0">
                <span className="text-sm font-medium">{video.title}</span>
                <span className="text-xs text-muted-foreground ml-2">• {video.project.name}</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Badge variant="secondary" className="mr-2">
                      v{activeVersion.versionNumber}
                    </Badge>
                    {activeVersion.versionLabel || `Version ${activeVersion.versionNumber}`}
                    <ChevronDown className="h-4 w-4 ml-2" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {video.versions.map((version) => (
                    <DropdownMenuItem
                      key={version.id}
                      onClick={() => handleVersionSelect(version.id)}
                    >
                      <Badge
                        variant={version.id === activeVersionId ? 'default' : 'secondary'}
                        className="mr-2"
                      >
                        v{version.versionNumber}
                      </Badge>
                      {version.versionLabel || `Version ${version.versionNumber}`}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {version._count.comments} comments
                      </span>
                    </DropdownMenuItem>
                  ))}
                  {mode === 'dashboard' && video.versions.length > 1 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => {
                          setVersionToDelete(activeVersionId);
                          setShowDeleteVersionDialog(true);
                        }}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete Current Version
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Version Delete Confirmation */}
              <AlertDialog open={showDeleteVersionDialog} onOpenChange={setShowDeleteVersionDialog}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this version?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete this version and all its comments. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={isDeletingVersion}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDeleteVersion}
                      disabled={isDeletingVersion}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {isDeletingVersion && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Delete Version
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              {activeVersion?.providerId === 'bunny' ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className={cn(
                        'transition-opacity duration-300',
                        isDownloadingVideo && 'opacity-50 pointer-events-none'
                      )}
                      disabled={!isVideoDownloadAvailable || isDownloadingVideo}
                    >
                      {isDownloadingVideo ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4 mr-1" />
                      )}
                      Download
                      <ChevronDown className="h-4 w-4 ml-1" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={(event) => {
                        event.preventDefault();
                        void handleDownloadVideo('original');
                      }}
                      disabled={!isVideoDownloadAvailable || isDownloadingVideo}
                    >
                      {activeDownloadTarget === 'original' ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4 mr-2" />
                      )}
                      Download Original
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={(event) => {
                        event.preventDefault();
                        void handleDownloadVideo('compressed');
                      }}
                      disabled={!isVideoDownloadAvailable || isDownloadingVideo}
                    >
                      {activeDownloadTarget === 'compressed' ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4 mr-2" />
                      )}
                      Download Compressed
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    'transition-opacity duration-300',
                    isDownloadingVideo && 'opacity-50 pointer-events-none'
                  )}
                  onClick={() => void handleDownloadVideo()}
                  disabled={!isVideoDownloadAvailable || isDownloadingVideo}
                >
                  {isDownloadingVideo ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 mr-1" />
                  )}
                  Download
                </Button>
              )}

              {mode === 'dashboard' && (
                <>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/projects/${projectId}/videos/${videoId}/share`}>
                      <Share2 className="h-4 w-4 mr-1" />
                      Share Video
                    </Link>
                  </Button>
                  <div className="hidden sm:flex items-center gap-2">
                    <Dialog open={showVersionDialog} onOpenChange={setShowVersionDialog}>
                      <DialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          <Plus className="h-4 w-4 mr-1" />
                          New Version
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Add New Version</DialogTitle>
                          <DialogDescription>
                            Upload a new version of this video. The new version will become active.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 mt-2">
                          <Tabs value={newVersionMode} onValueChange={(v) => setNewVersionMode(v as 'url' | 'file')} className="mb-2">
                            <TabsList className="grid w-full grid-cols-2">
                              <TabsTrigger value="url">Link URL</TabsTrigger>
                              <TabsTrigger value="file">Upload File</TabsTrigger>
                            </TabsList>
                          </Tabs>

                          {newVersionMode === 'url' ? (
                            <div className="space-y-2">
                              <Label>Video URL</Label>
                              <div className="relative">
                                <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <Input
                                  placeholder="https://youtube.com/watch?v=..."
                                  value={newVersionUrl}
                                  onChange={(e) => handleNewVersionUrlChange(e.target.value)}
                                  className="pl-10"
                                  disabled={isCreatingVersion}
                                />
                              </div>
                              {newVersionUrlError && (
                                <p className="text-sm text-destructive flex items-center gap-1">
                                  <AlertCircle className="h-4 w-4" />
                                  {newVersionUrlError}
                                </p>
                              )}
                              {newVersionSource && (
                                <p className="text-sm text-green-600 flex items-center gap-1">
                                  <CheckCircle2 className="h-4 w-4" />
                                  {newVersionSource.providerId.charAt(0).toUpperCase() +
                                    newVersionSource.providerId.slice(1)}{' '}
                                  video detected
                                </p>
                              )}
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <Label htmlFor="versionFile">Video File</Label>
                              <div className="flex items-center justify-center w-full">
                                <label htmlFor="versionFile" className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-lg cursor-pointer bg-muted/30 hover:bg-muted/50 transition-colors ${newVersionFile ? 'border-primary' : 'border-border'}`}>
                                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                                    {newVersionFile ? (
                                      <>
                                        <FileVideo className="w-8 h-8 mb-2 text-primary" />
                                        <p className="mb-1 text-sm text-foreground font-medium truncate max-w-[200px]">{newVersionFile.name}</p>
                                        <p className="text-xs text-muted-foreground">
                                          {(newVersionFile.size / (1024 * 1024)).toFixed(2)} MB
                                        </p>
                                      </>
                                    ) : (
                                      <>
                                        <UploadCloud className="w-8 h-8 mb-2 text-muted-foreground" />
                                        <p className="mb-1 text-sm text-muted-foreground">
                                          <span className="font-semibold">Click to upload</span> or drag and drop
                                        </p>
                                        <p className="text-xs text-muted-foreground">MP4, WebM, or OGG</p>
                                      </>
                                    )}
                                  </div>
                                  <input id="versionFile" type="file" accept="video/*" className="hidden" onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file && file.type.startsWith('video/')) {
                                      setNewVersionFile(file);
                                    } else {
                                      toast.error('Please select a valid video file');
                                    }
                                  }} disabled={isCreatingVersion} />
                                </label>
                              </div>
                            </div>
                          )}

                          <div className="space-y-2">
                            <Label>Version Label (optional)</Label>
                            <Input
                              placeholder="e.g. Final Cut, Review Round 2"
                              value={newVersionLabel}
                              onChange={(e) => setNewVersionLabel(e.target.value)}
                              disabled={isCreatingVersion}
                            />
                          </div>

                          {newVersionUploadStatus && (
                            <div className="space-y-2">
                              <p className="text-sm text-muted-foreground">{newVersionUploadStatus}</p>
                              {newVersionUploadProgress > 0 && newVersionUploadProgress < 100 && (
                                <div className="w-full bg-secondary rounded-full h-2">
                                  <div className="bg-primary h-2 rounded-full transition-all" style={{ width: `${newVersionUploadProgress}%` }}></div>
                                </div>
                              )}
                            </div>
                          )}

                          <Button
                            onClick={handleCreateVersion}
                            disabled={(newVersionMode === 'url' && !newVersionSource) || (newVersionMode === 'file' && !newVersionFile) || isCreatingVersion}
                            className="w-full"
                          >
                            {isCreatingVersion && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                            Add Version {video.versions.length + 1}
                          </Button>
                        </div>
                      </DialogContent>
                    </Dialog>

                    {video.versions.length >= 2 && (
                      <Button variant="outline" size="sm" onClick={() => {
                        setSelectedCompareVersions(new Set(activeVersionId ? [activeVersionId] : []));
                        setShowCompareDialog(true);
                      }}>
                        <GitCompareArrows className="h-4 w-4 mr-1" />
                        Compare
                      </Button>
                    )}
                  </div>

                  {/* Mobile Actions Dropdown */}
                  <div className="sm:hidden">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="icon" className="h-8 w-8">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {activeVersion?.providerId === 'bunny' ? (
                          <>
                            <DropdownMenuItem
                              onSelect={(event) => {
                                event.preventDefault();
                                void handleDownloadVideo('original');
                              }}
                              disabled={!isVideoDownloadAvailable || isDownloadingVideo}
                            >
                              {activeDownloadTarget === 'original' ? (
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              ) : (
                                <Download className="h-4 w-4 mr-2" />
                              )}
                              Download Original
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={(event) => {
                                event.preventDefault();
                                void handleDownloadVideo('compressed');
                              }}
                              disabled={!isVideoDownloadAvailable || isDownloadingVideo}
                            >
                              {activeDownloadTarget === 'compressed' ? (
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              ) : (
                                <Download className="h-4 w-4 mr-2" />
                              )}
                              Download Compressed
                            </DropdownMenuItem>
                          </>
                        ) : (
                          <DropdownMenuItem
                            onSelect={(event) => {
                              event.preventDefault();
                              void handleDownloadVideo();
                            }}
                            disabled={!isVideoDownloadAvailable || isDownloadingVideo}
                          >
                            {isDownloadingVideo ? (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                              <Download className="h-4 w-4 mr-2" />
                            )}
                            Download
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => setShowVersionDialog(true)}>
                          <Plus className="h-4 w-4 mr-2" />
                          New Version
                        </DropdownMenuItem>
                        {video.versions.length >= 2 && (
                          <DropdownMenuItem onSelect={() => {
                            setSelectedCompareVersions(new Set(activeVersionId ? [activeVersionId] : []));
                            setShowCompareDialog(true);
                          }}>
                            <GitCompareArrows className="h-4 w-4 mr-2" />
                            Compare
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </>
              )}
            </div>
          </div>

          <div
            ref={videoContainerRef}
            className={cn(
              'flex-1 bg-black flex items-center justify-center relative cursor-pointer group min-h-0',
              isFullscreenMode && "absolute inset-0",
              cursorIdle && isPlaying && 'cursor-none'
            )}
            onClick={handlePlayPause}
            onMouseMove={handleVideoMouseMove}
            onMouseLeave={handleVideoMouseLeave}
          >
            <div className={cn("relative w-full h-full", isFullscreenMode && "absolute inset-0")}>
              {activeVersion?.providerId === 'bunny' ? (
                <div ref={bunnyViewportRef} className="absolute inset-0 flex items-center justify-center bg-black">
                  <div
                    className={cn(
                      'relative flex items-center justify-center bg-black',
                      isBunnyPortraitSource ? 'h-full overflow-hidden' : 'w-full h-full'
                    )}
                    style={isBunnyPortraitSource && bunnyPortraitFrameWidth > 0 ? { width: `${bunnyPortraitFrameWidth}px` } : undefined}
                  >
                    <video
                      key={activeVersionId}
                      ref={videoRef}
                      className="w-full h-full object-contain border-0 bg-black"
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        objectPosition: 'center',
                        backgroundColor: 'black',
                      }}
                      preload="metadata"
                      playsInline
                    />
                  </div>
                </div>
              ) : (
                <iframe
                  key={activeVersionId}
                  ref={iframeRef}
                  src={embedUrl}
                  width="100%"
                  height="100%"
                  className="absolute inset-0 w-full h-full border-0"
                  referrerPolicy="origin-when-cross-origin"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              )}

              <div
                className={cn(
                  'absolute inset-0 flex items-center justify-center bg-black/20 transition-opacity duration-300',
                  (showBunnyProcessingOverlay || showBunnyErrorOverlay) && 'opacity-0 pointer-events-none',
                  isPlaying
                    ? cursorIdle ? 'opacity-0' : 'opacity-0 group-hover:opacity-100'
                    : 'opacity-100'
                )}
              >
                <div className="w-16 h-16 rounded-full bg-black/60 flex items-center justify-center relative z-10">
                  {isPlaying ? (
                    <Pause className="h-8 w-8 text-white relative right-[-1px]" />
                  ) : (
                    <Play className="h-8 w-8 text-white relative left-[2px]" />
                  )}
                </div>
              </div>

              {showBunnyProcessingOverlay && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65">
                  <div className="max-w-sm rounded-md border bg-background/95 px-4 py-3 text-center shadow-lg">
                    <div className="mb-2 flex items-center justify-center gap-2 text-sm font-medium">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Video Is Processing
                    </div>
                    <p className="text-xs text-muted-foreground">
                      This video is still processing. We&apos;ll keep retrying every few seconds.
                    </p>
                  </div>
                </div>
              )}

              {showBunnyErrorOverlay && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65">
                  <div className="max-w-sm rounded-md border bg-background/95 px-4 py-3 text-center shadow-lg">
                    <div className="mb-2 flex items-center justify-center gap-2 text-sm font-medium">
                      <AlertCircle className="h-4 w-4 text-destructive" />
                      Unable To Load Video
                    </div>
                    <p className="text-xs text-muted-foreground">
                      The Bunny stream is unavailable right now. Please refresh this page in a moment.
                    </p>
                  </div>
                </div>
              )}

              {/* Resume playback prompt */}
              {showResumePrompt && savedProgress !== null && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-10">
                  <div className="bg-background/95 backdrop-blur-sm rounded-lg p-4 shadow-lg max-w-sm mx-4">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                        <Clock className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium text-sm">Continue watching?</p>
                        <p className="text-xs text-muted-foreground">
                          Resume from {formatTime(savedProgress)}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="default"
                        onClick={handleResumeFromSaved}
                        className="flex-1"
                      >
                        <Play className="h-4 w-4 mr-1" />
                        Resume
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={handleDismissResume}
                        className="flex-1"
                      >
                        Start over
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Annotation canvas overlay – drawing mode */}
              {isAnnotating && (
                <AnnotationCanvas
                  ref={annotationCanvasRef}
                  mode="draw"
                  onConfirm={(strokes) => {
                    setAnnotationStrokes(strokes);
                    setIsAnnotating(false);
                  }}
                  onCancel={() => {
                    setIsAnnotating(false);
                    setAnnotationStrokes(null);
                  }}
                />
              )}

              {/* Annotation canvas overlay – viewing mode */}
              {viewingAnnotation && !isAnnotating && !isEditingAnnotation && (
                <AnnotationCanvas
                  mode="view"
                  strokes={viewingAnnotation}
                  onDismiss={() => setViewingAnnotation(null)}
                />
              )}

              {/* Annotation canvas overlay – edit annotation mode */}
              {isEditingAnnotation && (
                <AnnotationCanvas
                  ref={editAnnotationCanvasRef}
                  mode="draw"
                  strokes={editAnnotationData ? (() => { try { return JSON.parse(editAnnotationData); } catch { return undefined; } })() : (() => { const c = comments.find(c => c.id === editingCommentId); if (c?.annotationData) { try { return JSON.parse(c.annotationData); } catch { return undefined; } } return undefined; })()}
                  onConfirm={(strokes) => {
                    setEditAnnotationData(JSON.stringify(strokes));
                    setIsEditingAnnotation(false);
                  }}
                  onCancel={() => {
                    setIsEditingAnnotation(false);
                  }}
                />
              )}
            </div>
          </div>

          <div className={cn(
            "shrink-0 px-4 py-2 bg-background border-t",
            isFullscreenMode ? "absolute bottom-0 left-0 right-0 z-50 transition-opacity duration-300" : "",
            isFullscreenMode && cursorIdle && isPlaying && "opacity-0 pointer-events-none"
          )}>
            <div className="flex items-center gap-1 mb-2">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handlePlayPause}>
                {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => handleSkip(-10)}
                title="Back 10s"
              >
                <SkipBack className="h-4 w-4" />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => handleSkip(10)}
                title="Forward 10s"
              >
                <SkipForward className="h-4 w-4" />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleMuteToggle}
              >
                {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </Button>

              <span className="text-xs text-muted-foreground ml-1 tabular-nums">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>

              <div className="ml-auto flex items-center">
                {activeVersion?.providerId === 'bunny' && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs">
                        Quality {selectedQualityLabel}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[120px]">
                      <DropdownMenuItem
                        onClick={() => handleQualityChange(-1)}
                        className={cn(selectedQualityLevel === -1 && 'font-bold text-primary')}
                      >
                        Auto
                      </DropdownMenuItem>
                      {qualityOptions.length > 0 && <DropdownMenuSeparator />}
                      {qualityOptions.map((option) => (
                        <DropdownMenuItem
                          key={option.level}
                          onClick={() => handleQualityChange(option.level)}
                          className={cn(option.level === selectedQualityLevel && 'font-bold text-primary')}
                        >
                          {option.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs">
                      <Gauge className="h-3.5 w-3.5" />
                      {playbackSpeed === 1 ? '1x' : `${playbackSpeed}x`}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[80px]">
                    {SPEED_OPTIONS.map((speed) => (
                      <DropdownMenuItem
                        key={speed}
                        onClick={() => handleSpeedChange(speed)}
                        className={cn(speed === playbackSpeed && 'font-bold text-primary')}
                      >
                        {speed}x
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={toggleFullscreen}
                  title={isFullscreenMode ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
                >
                  {isFullscreenMode ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
                </Button>

                {isFullscreenMode ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setShowComments(!showComments)}
                    title={showComments ? 'Hide comments' : 'Show comments'}
                  >
                    {showComments ? <MessageSquareOff className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 lg:hidden"
                    onClick={() => setIsMobileCommentsOpen(true)}
                    title="Show comments"
                  >
                    <MessageSquare className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>

            <div
              ref={timelineRef}
              className="relative h-8 bg-muted rounded cursor-pointer select-none"
              onMouseDown={handleTimelineMouseDown}
              onMouseMove={handleTimelineMouseMove}
            >
              <div
                className="absolute left-0 top-0 h-full bg-primary/30 rounded pointer-events-none"
                style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
              />

              <div
                className="absolute top-0 h-full w-1 bg-primary rounded pointer-events-none"
                style={{ left: `calc(${duration > 0 ? (currentTime / duration) * 100 : 0}% - 2px)` }}
              />

              {filteredComments.map((comment) => {
                const markerColor = comment.tag?.color || (comment.isResolved ? '#22C55E' : '#22D3EE');
                return (
                  <button
                    key={comment.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSeekToTimestamp(comment.timestamp, comment.annotationData);
                    }}
                    className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full transition-transform hover:scale-150 z-10"
                    style={{
                      left: `calc(${duration > 0 ? (comment.timestamp / duration) * 100 : 0}% - 6px)`,
                      backgroundColor: markerColor,
                    }}
                    title={`${formatTime(comment.timestamp)}${comment.tag ? ` [${comment.tag.name}]` : ''} - ${comment.content?.substring(0, 30) || '(voice note)'}...`}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Mobile Backdrop */}
        <div
          className={cn(
            "fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden transition-opacity duration-300",
            isMobileCommentsOpen ? "opacity-100" : "opacity-0 pointer-events-none"
          )}
          onClick={() => setIsMobileCommentsOpen(false)}
        />

        <div className={cn(
          "bg-card flex flex-col overflow-hidden z-50",
          "fixed inset-y-0 right-0 w-[85%] sm:w-[400px] shadow-2xl transition-transform duration-300 transform",
          isMobileCommentsOpen ? "translate-x-0" : "translate-x-full",
          "lg:static lg:w-80 lg:shrink-0 lg:border-l lg:transition-none lg:translate-x-0 lg:shadow-none lg:z-auto",
          isFullscreenMode && !showComments ? "hidden" : ""
        )}>
          <div
            className="shrink-0 flex items-center justify-between p-4 border-b lg:cursor-default"
          >
            <div className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              <span className="font-medium">Comments</span>
              <Badge variant="secondary">{comments.length}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleToggleShowResolved(); }}>
                {showResolved ? 'Hide' : 'Show'} Resolved
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={!activeVersion || isGuest || isExportingCsv || isExportingPdf}
                onClick={(e) => {
                  e.stopPropagation();
                  handleExportComments('csv');
                }}
                title={isGuest ? 'CSV export requires an authenticated account' : 'Download comments as CSV'}
              >
                {isExportingCsv ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={!activeVersion || isExportingCsv || isExportingPdf}
                onClick={(e) => {
                  e.stopPropagation();
                  handleExportComments('pdf');
                }}
                title="Download comments as PDF"
              >
                {isExportingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8 lg:hidden" onClick={() => setIsMobileCommentsOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {filteredComments.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No comments yet</p>
                <p className="text-sm">Be the first to leave feedback!</p>
              </div>
            ) : (
              sortedComments.map((comment) => {
                const authorName =
                  comment.author?.name || comment.guestName || 'Anonymous';
                const isEditing = editingCommentId === comment.id;
                const isReplying = replyingTo === comment.id;
                const canEditComment = comment.canEdit ?? (comment.author?.id === currentUserId);
                const canDeleteComment = comment.canDelete ?? (comment.author?.id === currentUserId || video.project.ownerId === currentUserId);
                const canManageComment = canEditComment || canDeleteComment;
                return (
                  <div
                    key={comment.id}
                    className={cn(
                      'group rounded-lg border p-3 transition-colors hover:bg-accent/50',
                      comment.isResolved && 'opacity-60'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Avatar className="h-6 w-6 shrink-0">
                          <AvatarImage src={comment.author?.image ?? undefined} />
                          <AvatarFallback className="text-xs">
                            {authorName.charAt(0)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm font-medium truncate">{authorName}</span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleSeekToTimestamp(comment.timestamp, comment.annotationData)}
                          className="flex items-center gap-1 text-xs text-primary hover:underline px-1.5 py-0.5 rounded bg-primary/10 hover:bg-primary/20 transition-colors"
                          title="Jump to this timestamp"
                        >
                          <Clock className="h-3 w-3" />
                          {formatTime(comment.timestamp)}
                          <ArrowUpRight className="h-3 w-3" />
                        </button>
                        {canResolveComments && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() =>
                              handleResolveComment(comment.id, comment.isResolved)
                            }
                          >
                            {comment.isResolved ? (
                              <CheckCircle2 className="h-4 w-4 text-green-500" />
                            ) : (
                              <Circle className="h-4 w-4" />
                            )}
                          </Button>
                        )}
                        {canManageComment && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => {
                                setReplyingTo(comment.id);
                                setReplyText('');
                              }}>
                                <Reply className="h-4 w-4 mr-2" />
                                Reply
                              </DropdownMenuItem>
                              {canEditComment && (
                                <DropdownMenuItem onClick={() => {
                                  setEditingCommentId(comment.id);
                                  setEditText(comment.content || '');
                                  setEditTagId(comment.tag?.id || null);
                                }}>
                                  <Pencil className="h-4 w-4 mr-2" />
                                  Edit
                                </DropdownMenuItem>
                              )}
                              {canDeleteComment && (
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => handleDeleteComment(comment.id)}
                                >
                                  <Trash2 className="h-4 w-4 mr-2" />
                                  Delete
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </div>

                    {isEditing ? (
                      <div className="mb-2">
                        <Textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          rows={2}
                          className="resize-none text-sm mb-1"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                              handleEditComment(comment.id);
                            }
                            if (e.key === 'Escape') {
                              setEditingCommentId(null);
                              setEditText('');
                              setEditTagId(null);
                              setEditAnnotationData(undefined);
                              setIsEditingAnnotation(false);
                            }
                          }}
                        />
                        <div className="flex items-center gap-1 flex-wrap">
                          <Button
                            size="sm"
                            onClick={() => handleEditComment(comment.id)}
                            disabled={!editText.trim() || isSubmittingEdit}
                            className="h-7 text-xs"
                          >
                            {isSubmittingEdit ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => { setEditingCommentId(null); setEditText(''); setEditTagId(null); setEditAnnotationData(undefined); setIsEditingAnnotation(false); }}
                            className="h-7 text-xs"
                          >
                            Cancel
                          </Button>
                          <Button
                            size="icon"
                            variant={comment.annotationData || editAnnotationData ? 'default' : 'outline'}
                            className={`h-7 w-7 ${comment.annotationData || editAnnotationData ? 'bg-violet-500 hover:bg-violet-600' : ''}`}
                            onClick={() => {
                              if (playerRef.current?.pauseVideo) playerRef.current.pauseVideo();
                              setIsEditingAnnotation(true);
                              setIsAnnotating(false);
                            }}
                            title={comment.annotationData ? 'Redraw annotation' : 'Add annotation'}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          {availableTags.length > 0 && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="sm"
                                  variant={editTagId ? 'default' : 'outline'}
                                  className="h-7 text-xs ml-auto"
                                  style={editTagId ? {
                                    backgroundColor: availableTags.find(t => t.id === editTagId)?.color
                                  } : undefined}
                                >
                                  <Tag className="h-3 w-3 mr-1" />
                                  {editTagId ? availableTags.find(t => t.id === editTagId)?.name || 'Tag' : 'Tag'}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => setEditTagId(null)} className="gap-2">
                                  <X className="h-3 w-3" />
                                  No Tag
                                  {!editTagId && <span className="ml-auto">✓</span>}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                {availableTags.map((tag) => (
                                  <DropdownMenuItem
                                    key={tag.id}
                                    onClick={() => setEditTagId(tag.id)}
                                    className="gap-2"
                                  >
                                    <span
                                      className="w-3 h-3 rounded-full shrink-0"
                                      style={{ backgroundColor: tag.color }}
                                    />
                                    {tag.name}
                                    {editTagId === tag.id && <span className="ml-auto">✓</span>}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="mb-2">
                        {comment.content && <p className="text-sm mb-2"><Linkify>{comment.content}</Linkify></p>}
                        {comment.imageUrl && (
                          <div
                            className="rounded-md overflow-hidden bg-muted mb-2 max-h-60 flex items-center justify-center cursor-pointer hover:opacity-90 transition-opacity"
                            onClick={() => setPreviewImage(comment.imageUrl)}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={comment.imageUrl} alt="Attachment" className="max-h-60 w-auto object-contain" />
                          </div>
                        )}
                      </div>
                    )}

                    {comment.voiceUrl && (
                      <div className="flex items-center gap-2 p-2 bg-muted rounded mb-2">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 shrink-0"
                          onClick={() => playVoice(comment.id, comment.voiceUrl!, comment.voiceDuration || 0)}
                        >
                          {playingVoiceId === comment.id ? (
                            <Pause className="h-4 w-4" />
                          ) : (
                            <Play className="h-4 w-4" />
                          )}
                        </Button>
                        <div className="flex-1 h-2 bg-primary/20 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary rounded-full"
                            style={{ width: playingVoiceId === comment.id ? `${voiceProgress}%` : '0%' }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                          {playingVoiceId === comment.id
                            ? `${formatTime(voiceCurrentTime)} / ${formatTime(comment.voiceDuration || 0)}`
                            : formatTime(comment.voiceDuration || 0)}
                        </span>
                        {playingVoiceId === comment.id && (
                          <button
                            onClick={toggleVoiceSpeed}
                            className="text-[10px] font-bold px-1 py-0.5 rounded bg-muted hover:bg-muted-foreground/20 tabular-nums shrink-0"
                          >
                            {voicePlaybackRate}x
                          </button>
                        )}
                      </div>
                    )}

                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        {new Date(comment.createdAt).toLocaleDateString()}
                      </p>
                      {comment.annotationData && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-violet-500 text-white shrink-0 flex items-center gap-1">
                          <Pencil className="h-2.5 w-2.5" />
                          Annotated
                        </span>
                      )}
                      {comment.tag && (
                        <span
                          className="text-[10px] font-medium px-2 py-0.5 rounded-full text-white shrink-0"
                          style={{ backgroundColor: comment.tag.color }}
                        >
                          {comment.tag.name}
                        </span>
                      )}
                    </div>

                    {comment.replies && comment.replies.length > 0 && (
                      <div className="mt-3 pl-3 border-l-2 space-y-2">
                        {comment.replies.map((reply) => {
                          const replyAuthor =
                            reply.author?.name || reply.guestName || 'Anonymous';
                          const isEditingReply = editingCommentId === reply.id;
                          const canEditReply = reply.canEdit ?? (reply.author?.id === currentUserId);
                          const canDeleteReply = reply.canDelete ?? (reply.author?.id === currentUserId || video.project.ownerId === currentUserId);
                          const canManageReply = canEditReply || canDeleteReply;
                          return (
                            <div key={reply.id} className="group/reply text-sm">
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <div className="flex items-center gap-2">
                                  <Avatar className="h-5 w-5">
                                    <AvatarFallback className="text-xs">
                                      {replyAuthor.charAt(0)}
                                    </AvatarFallback>
                                  </Avatar>
                                  <span className="font-medium text-xs">{replyAuthor}</span>
                                  <span className="text-xs text-muted-foreground">
                                    {new Date(reply.createdAt).toLocaleDateString()}
                                  </span>
                                </div>
                                {canManageReply && (
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-5 w-5 shrink-0"
                                      >
                                        <MoreVertical className="h-3 w-3" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      {canEditReply && (
                                        <DropdownMenuItem onClick={() => {
                                          setEditingCommentId(reply.id);
                                          setEditText(reply.content || '');
                                        }}>
                                          <Pencil className="h-4 w-4 mr-2" />
                                          Edit
                                        </DropdownMenuItem>
                                      )}
                                      {canDeleteReply && (
                                        <DropdownMenuItem
                                          className="text-destructive"
                                          onClick={() => handleDeleteComment(reply.id)}
                                        >
                                          <Trash2 className="h-4 w-4 mr-2" />
                                          Delete
                                        </DropdownMenuItem>
                                      )}
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                )}
                              </div>
                              {isEditingReply ? (
                                <div className="mb-1">
                                  <Textarea
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    rows={2}
                                    className="resize-none text-sm mb-1"
                                    autoFocus
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                        handleEditComment(reply.id);
                                      }
                                      if (e.key === 'Escape') {
                                        setEditingCommentId(null);
                                        setEditText('');
                                      }
                                    }}
                                  />
                                  <div className="flex gap-1">
                                    <Button
                                      size="sm"
                                      onClick={() => handleEditComment(reply.id)}
                                      disabled={!editText.trim() || isSubmittingEdit}
                                      className="h-7 text-xs"
                                    >
                                      {isSubmittingEdit ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => { setEditingCommentId(null); setEditText(''); }}
                                      className="h-7 text-xs"
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <div className="mb-1">
                                  {reply.content && <p className="text-sm"><Linkify>{reply.content}</Linkify></p>}
                                  {reply.imageUrl && (
                                    <div
                                      className="rounded-md overflow-hidden bg-muted mt-2 max-h-40 flex items-center justify-center cursor-pointer hover:opacity-90 transition-opacity"
                                      onClick={() => setPreviewImage(reply.imageUrl)}
                                    >
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img src={reply.imageUrl} alt="Attachment" className="max-h-40 w-auto object-contain" />
                                    </div>
                                  )}
                                </div>
                              )}
                              {reply.voiceUrl && (
                                <div className="flex items-center gap-2 p-1.5 bg-muted rounded mt-1">
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-6 w-6 shrink-0"
                                    onClick={() => playVoice(reply.id, reply.voiceUrl!, reply.voiceDuration || 0)}
                                  >
                                    {playingVoiceId === reply.id ? (
                                      <Pause className="h-3 w-3" />
                                    ) : (
                                      <Play className="h-3 w-3" />
                                    )}
                                  </Button>
                                  <div className="flex-1 h-1.5 bg-primary/20 rounded-full overflow-hidden">
                                    <div
                                      className="h-full bg-primary rounded-full"
                                      style={{ width: playingVoiceId === reply.id ? `${voiceProgress}%` : '0%' }}
                                    />
                                  </div>
                                  <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                                    {playingVoiceId === reply.id
                                      ? `${formatTime(voiceCurrentTime)} / ${formatTime(reply.voiceDuration || 0)}`
                                      : formatTime(reply.voiceDuration || 0)}
                                  </span>
                                  {playingVoiceId === reply.id && (
                                    <button
                                      onClick={toggleVoiceSpeed}
                                      className="text-[10px] font-bold px-1 py-0.5 rounded bg-muted hover:bg-muted-foreground/20 tabular-nums shrink-0"
                                    >
                                      {voicePlaybackRate}x
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {isReplying && (
                      <div className="mt-3 pl-3 border-l-2">
                        {isReplyRecording ? (
                          <div className="flex items-center gap-2 p-2 bg-destructive/10 border border-destructive/30 rounded-lg mb-1">
                            <div className="h-2 w-2 rounded-full bg-destructive animate-pulse" />
                            <span className="text-xs font-medium text-destructive">
                              {formatTime(replyRecordingTime)}
                            </span>
                            <div className="flex-1" />
                            <Button size="sm" variant="destructive" onClick={stopReplyRecording} className="h-6 text-xs">
                              Stop
                            </Button>
                            <Button size="sm" variant="ghost" onClick={cancelReplyRecording} className="h-6 text-xs">
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : replyAudioBlob ? (
                          <div className="space-y-1 mb-1">
                            <div className="flex items-center gap-2 p-2 bg-muted rounded-lg">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6"
                                onClick={() => {
                                  const url = URL.createObjectURL(replyAudioBlob);
                                  playVoice('reply-preview', url, replyRecordingTime);
                                }}
                              >
                                {playingVoiceId === 'reply-preview' ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                              </Button>
                              <div className="flex-1 h-1.5 bg-primary/20 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-primary rounded-full"
                                  style={{ width: playingVoiceId === 'reply-preview' ? `${voiceProgress}%` : '0%' }}
                                />
                              </div>
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {playingVoiceId === 'reply-preview'
                                  ? `${formatTime(voiceCurrentTime)} / ${formatTime(replyRecordingTime)}`
                                  : formatTime(replyRecordingTime)}
                              </span>
                              {playingVoiceId === 'reply-preview' && (
                                <button
                                  onClick={toggleVoiceSpeed}
                                  className="text-[10px] font-bold px-1 py-0.5 rounded bg-muted hover:bg-muted-foreground/20 tabular-nums shrink-0"
                                >
                                  {voicePlaybackRate}x
                                </button>
                              )}
                              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={cancelReplyRecording}>
                                <X className="h-3 w-3" />
                              </Button>
                            </div>

                            {replyImageBlob && (
                              <div className="relative group rounded-md overflow-hidden bg-muted flex items-center justify-center h-20 mb-2">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={URL.createObjectURL(replyImageBlob)} alt="Preview" className="h-full object-contain" />
                                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                  <Button size="icon" variant="destructive" className="h-6 w-6" onClick={() => {
                                    setReplyImageBlob(null);
                                    if (replyImageInputRef.current) replyImageInputRef.current.value = '';
                                  }}>
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                            )}

                            <Textarea
                              value={replyText}
                              onChange={(e) => setReplyText(e.target.value)}
                              placeholder="Add a note (optional)..."
                              rows={1}
                              className="resize-none text-sm"
                            />
                            <div className="flex gap-1 mt-2">
                              <Button
                                size="sm"
                                onClick={() => submitReplyWithMedia(comment.id)}
                                disabled={isUploadingReplyAudio || isUploadingReplyImage}
                                className="h-7 text-xs"
                              >
                                {isUploadingReplyAudio || isUploadingReplyImage ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Send Reply'}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={cancelReplyRecording} className="h-7 text-xs">Cancel</Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {replyImageBlob && (
                              <div className="relative group rounded-md overflow-hidden bg-muted flex items-center justify-center h-20 mb-2">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={URL.createObjectURL(replyImageBlob)} alt="Preview" className="h-full object-contain" />
                                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                  <Button size="icon" variant="destructive" className="h-6 w-6" onClick={() => {
                                    setReplyImageBlob(null);
                                    if (replyImageInputRef.current) replyImageInputRef.current.value = '';
                                  }}>
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                            )}
                            <div className="flex gap-1">
                              <Textarea
                                value={replyText}
                                onChange={(e) => setReplyText(e.target.value)}
                                placeholder="Write a reply..."
                                rows={2}
                                className="resize-none text-sm flex-1"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                    handleReplyComment(comment.id);
                                  }
                                  if (e.key === 'Escape') {
                                    setReplyingTo(null);
                                    setReplyText('');
                                  }
                                }}
                                onPaste={(e) => handlePaste(e, true)}
                              />
                              <Button
                                size="icon"
                                variant="outline"
                                onClick={startReplyRecording}
                                title="Record voice reply"
                                className="h-8 w-8 shrink-0 self-end"
                              >
                                <Mic className="h-3 w-3" />
                              </Button>
                              <Button
                                size="icon"
                                variant="outline"
                                onClick={() => replyImageInputRef.current?.click()}
                                title="Attach Image"
                                className="h-8 w-8 shrink-0 self-end"
                              >
                                <ImageIcon className="h-3 w-3" />
                              </Button>
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                ref={replyImageInputRef}
                                onChange={(e) => handleImageSelect(e, true)}
                              />
                            </div>
                            <div className="flex gap-1 mt-1">
                              <Button
                                size="sm"
                                onClick={() => handleReplyComment(comment.id)}
                                disabled={(!replyText.trim() && !replyImageBlob) || isSubmittingReply || isUploadingReplyImage}
                                className="h-7 text-xs"
                              >
                                {isSubmittingReply || isUploadingReplyImage ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Reply'}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => { setReplyingTo(null); setReplyText(''); }}
                                className="h-7 text-xs"
                              >
                                Cancel
                              </Button>
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {!isReplying && !isEditing && (
                      <button
                        onClick={() => { setReplyingTo(comment.id); setReplyText(''); }}
                        className="mt-2 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                      >
                        <Reply className="h-3 w-3" />
                        Reply
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="shrink-0 p-4 border-t bg-background">
            <div className="flex items-center gap-2 mb-2">
              <Button
                variant={selectedTimestamp !== null ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  if (selectedTimestamp !== null) {
                    setSelectedTimestamp(null);
                  } else {
                    setSelectedTimestamp(currentTime);
                  }
                }}
              >
                <Clock className="h-4 w-4 mr-1" />
                {selectedTimestamp !== null ? formatTime(selectedTimestamp) : formatTime(currentTime)}
                {selectedTimestamp !== null && <X className="h-3 w-3 ml-1" />}
              </Button>
              <span className="text-xs text-muted-foreground">
                {selectedTimestamp !== null ? 'Pinned — click to unpin' : 'Pin to this time'}
              </span>
            </div>

            {isRecording ? (
              <div className="flex items-center gap-3 p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
                <div className="h-3 w-3 rounded-full bg-destructive animate-pulse" />
                <span className="text-sm font-medium text-destructive">
                  Recording {formatTime(recordingTime)}
                </span>
                <div className="flex-1" />
                <Button size="sm" variant="destructive" onClick={stopRecording}>
                  Stop
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelRecording}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : audioBlob ? (
              <div className="space-y-2">
                <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => {
                      const url = URL.createObjectURL(audioBlob);
                      playVoice('preview', url, recordingTime);
                    }}
                  >
                    {playingVoiceId === 'preview' ? (
                      <Pause className="h-4 w-4" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </Button>
                  <div className="flex-1 h-2 bg-primary/20 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full"
                      style={{ width: playingVoiceId === 'preview' ? `${voiceProgress}%` : '0%' }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {playingVoiceId === 'preview'
                      ? `${formatTime(voiceCurrentTime)} / ${formatTime(recordingTime)}`
                      : formatTime(recordingTime)}
                  </span>
                  {playingVoiceId === 'preview' && (
                    <button
                      onClick={toggleVoiceSpeed}
                      className="text-[10px] font-bold px-1 py-0.5 rounded bg-muted hover:bg-muted-foreground/20 tabular-nums shrink-0"
                    >
                      {voicePlaybackRate}x
                    </button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={cancelRecording}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                {imageBlob && (
                  <div className="relative group rounded-md overflow-hidden bg-muted flex items-center justify-center max-h-40 mb-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={URL.createObjectURL(imageBlob)} alt="Preview" className="max-h-40 w-auto object-contain" />
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Button size="icon" variant="destructive" onClick={() => {
                        setImageBlob(null);
                        if (imageInputRef.current) imageInputRef.current.value = '';
                      }}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}

                <Textarea
                  placeholder="Add a note to your voice comment (optional)..."
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  rows={1}
                  className="resize-none text-sm"
                />
                <Button
                  size="sm"
                  onClick={submitCommentWithMedia}
                  disabled={isUploadingAudio || isUploadingImage}
                  className="w-full"
                >
                  {isUploadingAudio || isUploadingImage ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Uploading Media...
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4 mr-2" />
                      Send Voice Comment
                    </>
                  )}
                </Button>
              </div>
            ) : (
              <>
                {(annotationStrokes || isAnnotating) && (
                  <div className="flex items-center gap-2 px-2 py-1.5 mb-2 rounded-md bg-violet-500/10 border border-violet-500/30">
                    <Pencil className="h-3.5 w-3.5 text-violet-500 shrink-0" />
                    <span className="text-xs text-violet-400 font-medium">Annotation attached</span>
                    <button
                      className="ml-auto text-xs text-muted-foreground hover:text-destructive transition-colors"
                      onClick={() => { setAnnotationStrokes(null); setIsAnnotating(false); }}
                    >
                      Remove
                    </button>
                  </div>
                )}
                {imageBlob && (
                  <div className="relative group rounded-md overflow-hidden bg-muted flex items-center justify-center max-h-40 mb-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={URL.createObjectURL(imageBlob)} alt="Preview" className="max-h-40 w-auto object-contain" />
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Button size="icon" variant="destructive" onClick={() => {
                        setImageBlob(null);
                        if (imageInputRef.current) imageInputRef.current.value = '';
                      }}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
                <div className="flex gap-2">
                  <Textarea
                    placeholder="Add a comment..."
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    rows={2}
                    className="resize-none text-sm"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        handleAddComment();
                      }
                    }}
                    onPaste={(e) => handlePaste(e, false)}
                  />
                  <div className="flex flex-col gap-1">
                    <Button
                      size="icon"
                      onClick={() => handleAddComment()}
                      disabled={(!commentText.trim() && !imageBlob && !annotationStrokes) || isSubmittingComment || isUploadingImage}
                    >
                      {isSubmittingComment || isUploadingImage ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={startRecording}
                      title="Record voice comment"
                    >
                      <Mic className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={() => imageInputRef.current?.click()}
                      title="Attach Image"
                    >
                      <ImageIcon className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant={annotationStrokes ? 'default' : 'outline'}
                      className={annotationStrokes ? 'bg-violet-500 hover:bg-violet-600' : ''}
                      onClick={() => {
                        if (isAnnotating) return;
                        // Pause video when opening annotation tool
                        if (playerRef.current?.pauseVideo) {
                          playerRef.current.pauseVideo();
                        }
                        setIsAnnotating(true);
                      }}
                      title={annotationStrokes ? 'Annotation added ✓ (click to redraw)' : 'Draw annotation on video'}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      ref={imageInputRef}
                      onChange={handleImageSelect}
                    />
                    {availableTags.length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant={selectedTagId ? 'default' : 'outline'}
                            title="Select tag"
                            style={selectedTagId ? {
                              backgroundColor: availableTags.find(t => t.id === selectedTagId)?.color
                            } : undefined}
                          >
                            <Tag className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {availableTags.map((tag) => (
                            <DropdownMenuItem
                              key={tag.id}
                              onClick={() => setSelectedTagId(tag.id)}
                              className="gap-2"
                            >
                              <span
                                className="w-3 h-3 rounded-full shrink-0"
                                style={{ backgroundColor: tag.color }}
                              />
                              {tag.name}
                              {selectedTagId === tag.id && <span className="ml-auto">✓</span>}
                            </DropdownMenuItem>
                          ))}
                          {video.canManageTags && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem asChild>
                                <Link href={`/projects/${projectId}/settings#comment-tags`} className="gap-2 text-muted-foreground">
                                  <Tag className="h-3 w-3" />
                                  Manage Tags
                                </Link>
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Cmd+Enter to submit</p>
              </>
            )}
          </div>
        </div>
      </div >

      <Dialog open={!!previewImage} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <DialogContent
          showCloseButton={false}
          className="max-w-none sm:max-w-none w-screen h-screen max-h-screen p-0 overflow-hidden bg-black/90 border-none shadow-none flex flex-col items-center justify-center rounded-none"
        >
          <DialogTitle className="sr-only">Image Preview</DialogTitle>
          <div className="absolute top-4 right-4 flex gap-3 z-50">
            <Button
              variant="outline"
              size="icon"
              className="rounded-full bg-black/40 hover:bg-black/80 border-white/20 text-white h-10 w-10 backdrop-blur-md transition-all shrink-0"
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  const response = await fetch(previewImage!);
                  const blob = await response.blob();
                  const url = window.URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = previewImage!.split('/').pop() || 'attachment.png';
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  window.URL.revokeObjectURL(url);
                } catch (error) {
                  console.error('Failed to download image:', error);
                  toast.error('Failed to download image');
                }
              }}
            >
              <Download className="h-5 w-5" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="rounded-full bg-black/40 hover:bg-black/80 border-white/20 text-white h-10 w-10 backdrop-blur-md transition-all shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                setPreviewImage(null);
              }}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
          <div
            className="relative w-full h-full flex items-center justify-center p-4 cursor-zoom-out"
            onClick={() => setPreviewImage(null)}
          >
            {previewImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewImage}
                alt="Preview"
                className="max-w-[95vw] max-h-[90vh] object-contain rounded-md select-none cursor-default"
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Compare Version Selection Dialog */}
      <Dialog open={showCompareDialog} onOpenChange={setShowCompareDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Select Versions to Compare</DialogTitle>
            <DialogDescription>
              Choose 2 or more versions to compare side by side.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 mt-2 max-h-64 overflow-y-auto">
            {video.versions
              .slice()
              .sort((a, b) => a.versionNumber - b.versionNumber)
              .map((v) => {
                const isSelected = selectedCompareVersions.has(v.id);
                return (
                  <button
                    key={v.id}
                    type="button"
                    className={cn(
                      'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors',
                      isSelected
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-accent/50'
                    )}
                    onClick={() => {
                      setSelectedCompareVersions((prev) => {
                        const next = new Set(prev);
                        if (next.has(v.id)) {
                          next.delete(v.id);
                        } else {
                          next.add(v.id);
                        }
                        return next;
                      });
                    }}
                  >
                    <div
                      className={cn(
                        'h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors',
                        isSelected
                          ? 'bg-primary border-primary text-primary-foreground'
                          : 'border-muted-foreground/40'
                      )}
                    >
                      {isSelected && (
                        <CheckCircle2 className="h-3 w-3" />
                      )}
                    </div>
                    <Badge variant="secondary">v{v.versionNumber}</Badge>
                    <span className="text-sm font-medium truncate">
                      {v.versionLabel || `Version ${v.versionNumber}`}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground shrink-0">
                      {v._count.comments} comments
                    </span>
                  </button>
                );
              })}
          </div>
          <Button
            className="w-full mt-2"
            disabled={selectedCompareVersions.size < 2}
            onClick={() => {
              const ids = Array.from(selectedCompareVersions).join(',');
              setShowCompareDialog(false);
              router.push(
                `/projects/${propProjectId}/videos/${videoId}/compare?versions=${ids}`
              );
            }}
          >
            <GitCompareArrows className="h-4 w-4 mr-2" />
            Compare {selectedCompareVersions.size} Versions
          </Button>
        </DialogContent>
      </Dialog>
    </div >
  );
}
