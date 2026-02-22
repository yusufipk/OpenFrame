'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { List } from 'react-window';
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
  ChevronUp,
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

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export type VideoPageMode = 'dashboard' | 'watch';

interface VideoPageContentProps {
  mode: VideoPageMode;
  videoId: string;
  projectId?: string;
}

export function VideoPageContent({ mode, videoId, projectId: propProjectId }: VideoPageContentProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerRef = useRef<YT.Player | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const [video, setVideo] = useState<VideoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
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

  // Watch progress state
  const [savedProgress, setSavedProgress] = useState<number | null>(null);
  const [showResumePrompt, setShowResumePrompt] = useState(false);
  const progressSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSavedProgressRef = useRef<number>(0);

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
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);
  const isMutatingRef = useRef(false);
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
    const saved = localStorage.getItem('openframe_guest_name');
    if (saved) {
      setGuestName(saved);
      if (mode === 'watch') setGuestNameConfirmed(true);
    }
  }, [mode]);

  const isGuest = video ? !video.isAuthenticated : false;

  const [showVersionDialog, setShowVersionDialog] = useState(false);
  const [newVersionUrl, setNewVersionUrl] = useState('');
  const [newVersionLabel, setNewVersionLabel] = useState('');
  const [newVersionSource, setNewVersionSource] = useState<VideoSource | null>(null);
  const [newVersionUrlError, setNewVersionUrlError] = useState('');
  const [isCreatingVersion, setIsCreatingVersion] = useState(false);

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

  const apiBasePath = mode === 'dashboard'
    ? `/api/projects/${propProjectId}/videos/${videoId}`
    : `/api/watch/${videoId}`;

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
        const data = response.data;
        setVideo(data);
        const active = data.versions?.find((v: Version) => v.isActive) || data.versions?.[0];
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

  // Memoize active version lookup to avoid recalculating on every render
  const activeVersion = useMemo(() => {
    return video?.versions?.find((v) => v.id === activeVersionId) ||
      video?.versions?.find((v) => v.isActive) ||
      video?.versions?.[0];
  }, [video?.versions, activeVersionId]);

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
      return `https://www.youtube.com/embed/${activeVersion.videoId}?enablejsapi=1&rel=0&modestbranding=1&controls=0&showinfo=0&iv_load_policy=3&disablekb=1`;
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

  useEffect(() => {
    if (!projectId) return;
    async function fetchTags() {
      try {
        const res = await fetch(`/api/projects/${projectId}/tags`);
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
  }, [projectId]);

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

  useEffect(() => {
    if (!activeVersion || activeVersion.providerId !== 'youtube') return;
    if (!isApiLoaded) return;

    setIsReady(false);
    setCurrentTime(0);
    setVideoDuration(0);
    setIsPlaying(false);
    setPlaybackSpeed(1);

    if (playerRef.current) {
      try { playerRef.current.destroy(); } catch { /* ignore */ }
      playerRef.current = null;
    }

    const initPlayer = () => {
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

            // Save progress immediately when video is paused
            if (event.data === YT.PlayerState.PAUSED) {
              // Get current time and duration directly from player instance, not from React state (which may be stale)
              const playerCurrentTime = playerRef.current?.getCurrentTime?.() || 0;
              const playerDuration = playerRef.current?.getDuration?.() || 0;

              if (video?.isAuthenticated && playerCurrentTime > 0 && activeVersionId) {
                fetch(`/api/watch/${videoId}/progress`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    progress: playerCurrentTime,
                    duration: playerDuration,
                    versionId: activeVersionId,
                  }),
                }).catch((err) => console.error('Error saving watch progress on pause:', err));
              }
            }

            if (event.data === YT.PlayerState.PLAYING) {
              const dur = event.target.getDuration();
              if (dur > 0) setVideoDuration(dur);
            }
          },
        },
      });
    };

    const timeout = setTimeout(() => {
      if (window.YT?.Player) {
        initPlayer();
      } else {
        window.onYouTubeIframeAPIReady = initPlayer;
      }
    }, 100);

    return () => {
      clearTimeout(timeout);
      window.onYouTubeIframeAPIReady = undefined;
    };
  }, [activeVersionId, isApiLoaded]);

  // Save detected duration to DB if the version doesn't have one stored
  useEffect(() => {
    if (!videoDuration || !activeVersion || !propProjectId) return;
    if (activeVersion.duration && activeVersion.duration > 0) return;

    const roundedDuration = Math.round(videoDuration);
    // Fire-and-forget PATCH to save duration
    fetch(`/api/projects/${propProjectId}/videos/${videoId}/versions/${activeVersion.id}`, {
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
          v.id === activeVersion.id ? { ...v, duration: roundedDuration } : v
        ),
      };
    });
  }, [videoDuration, activeVersion?.id, activeVersion?.duration, propProjectId, videoId]);

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
      const playerCurrentTime = playerRef.current?.getCurrentTime?.() || 0;
      const playerDuration = playerRef.current?.getDuration?.() || 0;

      if (playerCurrentTime > 0 && Math.abs(playerCurrentTime - lastSavedProgressRef.current) >= 2) {
        // Save to API - use player duration directly
        fetch(`/api/watch/${videoId}/progress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            progress: playerCurrentTime,
            duration: playerDuration || videoDuration,
            versionId: activeVersionId,
          }),
        }).catch((err) => console.error('Error saving watch progress:', err));

        lastSavedProgressRef.current = playerCurrentTime;
      }
    }, 5000);

    return () => {
      if (progressSaveTimerRef.current) {
        clearInterval(progressSaveTimerRef.current);
      }
    };
  }, [video?.isAuthenticated, isReady, currentTime, videoDuration, activeVersionId, videoId]);

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

      if (playerCurrentTime > 0 && navigator.sendBeacon) {
        // Use sendBeacon for reliable save on page unload
        const data = new Blob([JSON.stringify({
          progress: playerCurrentTime,
          duration: playerDuration,
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

      if (document.visibilityState === 'hidden' && playerCurrentTime > 0 && activeVersionId) {
        fetch(`/api/watch/${videoId}/progress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            progress: playerCurrentTime,
            duration: playerDuration,
            versionId: activeVersionId,
          }),
        }).catch((err) => console.error('Error saving watch progress on visibility change:', err));
      }
    };

    window.addEventListener('beforeunload', saveProgressOnLeave);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', saveProgressOnLeave);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [video?.isAuthenticated, currentTime, videoDuration, activeVersionId, videoId]);

  // Resume playback from saved position
  const handleResumeFromSaved = useCallback(() => {
    if (savedProgress !== null && playerRef.current?.seekTo) {
      playerRef.current.seekTo(savedProgress, true);
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
      if (playerRef.current?.getCurrentTime && !isDragging) {
        setCurrentTime(playerRef.current.getCurrentTime());
      }
    }, 250);

    return () => clearInterval(interval);
  }, [isReady, isDragging]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
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
          if (playerRef.current?.seekTo) {
            const newTime = Math.max(0, currentTime - 5);
            playerRef.current.seekTo(newTime, true);
            setCurrentTime(newTime);
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (playerRef.current?.seekTo) {
            const newTime = Math.min(duration, currentTime + 5);
            playerRef.current.seekTo(newTime, true);
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
  }, [isPlaying, currentTime, duration, isMuted, playbackSpeed, toggleFullscreen]);

  const handlePlayPause = useCallback(() => {
    if (!playerRef.current) return;
    if (isPlaying) {
      playerRef.current.pauseVideo();
    } else {
      playerRef.current.playVideo();
    }
  }, [isPlaying]);

  const handleSeekToTimestamp = useCallback((timestamp: number, annotation?: string | null) => {
    setCurrentTime(timestamp);
    if (playerRef.current?.seekTo) {
      playerRef.current.seekTo(timestamp, true);
      playerRef.current.pauseVideo();
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
  }, []);

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

  const handleAddComment = useCallback(async (voiceData?: { url: string; duration: number }, imageData?: { url: string }) => {
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
      guestName: isGuest ? guestName : null,
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
          ...(isGuest && guestName && { guestName }),
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
    } catch (err) {
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
  }, [commentText, currentTime, selectedTimestamp, activeVersion, activeVersionId, isGuest, guestName, selectedTagId, availableTags, imageBlob, annotationStrokes, isAnnotating]);

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
  }, [audioBlob, activeVersion, recordingTime, handleAddComment]);

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
  }, []);

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
      let imageData: { url: string } | undefined;

      if (audioBlob) {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');
        const uploadRes = await fetch('/api/upload/audio', { method: 'POST', body: formData });
        if (!uploadRes.ok) throw new Error('Failed to upload audio');
        const uploadData = await uploadRes.json();
        voiceData = { url: uploadData.data.url, duration: recordingTime };
      }

      await handleAddComment(voiceData, imageData); // Image is uploaded inside handleAddComment for both text/image cases

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
  }, [audioBlob, imageBlob, activeVersion, recordingTime, commentText, submitVoiceComment, handleAddComment]);

  const handleResolveComment = useCallback(
    async (commentId: string, currentlyResolved: boolean) => {
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
      } catch (err) {
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
    [activeVersionId]
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
      guestName: isGuest ? guestName : null,
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
          ...(isGuest && guestName && { guestName }),
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
    } catch (err) {
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
  }, [replyText, activeVersion, activeVersionId, comments, currentTime, isGuest, guestName, replyImageBlob]);

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
  }, [replyAudioBlob, activeVersion, replyRecordingTime, handleReplyComment]);

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
  }, [replyAudioBlob, replyImageBlob, activeVersion, replyRecordingTime, replyText, submitVoiceReply, handleReplyComment]);

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
  }, [editText, editTagId, editAnnotationData, isEditingAnnotation, activeVersionId, availableTags]);

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
    if (!activeVersion) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;
    let isPageVisible = true;

    const poll = async () => {
      try {
        if (isMutatingRef.current || !isPageVisible) return;

        const res = await fetch(apiBasePath, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (!isMutatingRef.current) {
            setVideo(data.data);
          }
        }
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
  }, [activeVersion, apiBasePath]);

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
    if (!newVersionSource || !propProjectId) return;
    setIsCreatingVersion(true);

    try {
      const meta = await fetchVideoMetadata(newVersionSource);
      const thumbnailUrl = getThumbnailUrl(newVersionSource, 'large');

      const res = await fetch(`/api/projects/${propProjectId}/videos/${videoId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrl: newVersionSource.originalUrl,
          providerId: newVersionSource.providerId,
          providerVideoId: newVersionSource.videoId,
          versionLabel: newVersionLabel.trim() || null,
          thumbnailUrl,
          duration: meta?.duration || null,
          setActive: true,
        }),
      });

      if (res.ok) {
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
      }
    } catch (err) {
      console.error('Failed to create version:', err);
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

              {mode === 'dashboard' && (
                <>
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
                          <div className="space-y-2">
                            <Label>Version Label (optional)</Label>
                            <Input
                              placeholder="e.g. Final Cut, Review Round 2"
                              value={newVersionLabel}
                              onChange={(e) => setNewVersionLabel(e.target.value)}
                              disabled={isCreatingVersion}
                            />
                          </div>
                          <Button
                            onClick={handleCreateVersion}
                            disabled={!newVersionSource || isCreatingVersion}
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
              <iframe
                key={activeVersionId}
                ref={iframeRef}
                src={embedUrl}
                className="absolute inset-0 w-full h-full pointer-events-none"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />

              <div
                className={cn(
                  'absolute inset-0 flex items-center justify-center bg-black/20 transition-opacity duration-300',
                  isPlaying
                    ? cursorIdle ? 'opacity-0' : 'opacity-0 group-hover:opacity-100'
                    : 'opacity-100'
                )}
              >
                <div className="w-16 h-16 rounded-full bg-black/60 flex items-center justify-center">
                  {isPlaying ? (
                    <Pause className="h-8 w-8 text-white" />
                  ) : (
                    <Play className="h-8 w-8 text-white ml-1" />
                  )}
                </div>
              </div>

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
                        {(comment.author?.id === currentUserId || video.project.ownerId === currentUserId) && (
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
                              {comment.author?.id === currentUserId && (
                                <DropdownMenuItem onClick={() => {
                                  setEditingCommentId(comment.id);
                                  setEditText(comment.content || '');
                                  setEditTagId(comment.tag?.id || null);
                                }}>
                                  <Pencil className="h-4 w-4 mr-2" />
                                  Edit
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => handleDeleteComment(comment.id)}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
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
                                {(reply.author?.id === currentUserId || video.project.ownerId === currentUserId) && (
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
                                      {reply.author?.id === currentUserId && (
                                        <DropdownMenuItem onClick={() => {
                                          setEditingCommentId(reply.id);
                                          setEditText(reply.content || '');
                                        }}>
                                          <Pencil className="h-4 w-4 mr-2" />
                                          Edit
                                        </DropdownMenuItem>
                                      )}
                                      <DropdownMenuItem
                                        className="text-destructive"
                                        onClick={() => handleDeleteComment(reply.id)}
                                      >
                                        <Trash2 className="h-4 w-4 mr-2" />
                                        Delete
                                      </DropdownMenuItem>
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
                          <DropdownMenuSeparator />
                          <DropdownMenuItem asChild>
                            <Link href={`/projects/${projectId}/settings#comment-tags`} className="gap-2 text-muted-foreground">
                              <Tag className="h-3 w-3" />
                              Manage Tags
                            </Link>
                          </DropdownMenuItem>
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
