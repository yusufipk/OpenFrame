'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { parseVideoUrl, getThumbnailUrl, fetchVideoMetadata, type VideoSource } from '@/lib/video-providers';

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
    members: { role: string }[];
  };
  versions: (Version & { comments: Comment[] })[];
  isAuthenticated: boolean;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export default function VideoPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const videoId = params.videoId as string;

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerRef = useRef<YT.Player | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
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

  const [commentText, setCommentText] = useState('');
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [isUploadingAudio, setIsUploadingAudio] = useState(false);
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

  // Reply/Edit/Delete state
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [isSubmittingReply, setIsSubmittingReply] = useState(false);
  const [isReplyRecording, setIsReplyRecording] = useState(false);
  const [replyRecordingTime, setReplyRecordingTime] = useState(0);
  const [replyAudioBlob, setReplyAudioBlob] = useState<Blob | null>(null);
  const [isUploadingReplyAudio, setIsUploadingReplyAudio] = useState(false);
  const replyMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const replyAudioChunksRef = useRef<Blob[]>([]);
  const replyRecordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);

  // Guest name (for unauthenticated users on public projects)
  const [guestName, setGuestName] = useState('');
  useEffect(() => {
    const saved = localStorage.getItem('openframe_guest_name');
    if (saved) setGuestName(saved);
  }, []);
  const isGuest = video ? !video.isAuthenticated : false;

  // New version dialog
  const [showVersionDialog, setShowVersionDialog] = useState(false);
  const [newVersionUrl, setNewVersionUrl] = useState('');
  const [newVersionLabel, setNewVersionLabel] = useState('');
  const [newVersionSource, setNewVersionSource] = useState<VideoSource | null>(null);
  const [newVersionUrlError, setNewVersionUrlError] = useState('');
  const [isCreatingVersion, setIsCreatingVersion] = useState(false);

  // Comment tags state
  const [availableTags, setAvailableTags] = useState<CommentTag[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);

  // Fetch video data
  useEffect(() => {
    async function fetchVideo() {
      try {
        const res = await fetch(`/api/projects/${projectId}/videos/${videoId}`);
        if (!res.ok) {
          const errorText = await res.text();
          console.error('Failed to load video:', res.status, errorText);
          setError(`Failed to load video: ${res.status} ${errorText}`);
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
  }, [projectId, videoId]);

  const activeVersion = video?.versions?.find((v) => v.id === activeVersionId) || 
    video?.versions?.find((v) => v.isActive) || 
    video?.versions?.[0];
  const comments = activeVersion?.comments || [];
  const filteredComments = comments.filter((c) => showResolved || !c.isResolved);
  const duration = videoDuration || activeVersion?.duration || 0;

  // Fetch tags for the project
  useEffect(() => {
    async function fetchTags() {
      try {
        const res = await fetch(`/api/projects/${projectId}/tags`);
        if (res.ok) {
          const data = await res.json();
          const tags = data.data || [];
          setAvailableTags(tags);
          // Auto-select first tag (Feedback) as default
          if (tags.length > 0 && !selectedTagId) {
            setSelectedTagId(tags[0].id);
          }
        }
      } catch {
        // Silent fail - tags are optional
      }
    }
    fetchTags();
  }, [projectId]);

  // Load YouTube iframe API script once
  useEffect(() => {
    if (window.YT) return;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);
  }, []);

  // Initialize / reinitialize YouTube player when version changes
  useEffect(() => {
    if (!activeVersion || activeVersion.providerId !== 'youtube') return;

    // Reset state for new version
    setIsReady(false);
    setCurrentTime(0);
    setVideoDuration(0);
    setIsPlaying(false);
    setPlaybackSpeed(1);

    // Destroy previous player if it exists
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
            // Update duration when playback starts (more reliable)
            if (event.data === YT.PlayerState.PLAYING) {
              const dur = event.target.getDuration();
              if (dur > 0) setVideoDuration(dur);
            }
          },
        },
      });
    };

    // Wait a tick for the iframe to update its src before binding
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
  }, [activeVersionId]);

  // Update current time periodically
  useEffect(() => {
    if (!isReady || !playerRef.current) return;

    const interval = setInterval(() => {
      if (playerRef.current?.getCurrentTime && !isDragging) {
        setCurrentTime(playerRef.current.getCurrentTime());
      }
    }, 250);

    return () => clearInterval(interval);
  }, [isReady, isDragging]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea
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
        case 'Comma': // < key (Shift+,)
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
        case 'Period': // > key (Shift+.)
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
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, currentTime, duration, isMuted, playbackSpeed]);

  const handlePlayPause = useCallback(() => {
    if (!playerRef.current) return;
    if (isPlaying) {
      playerRef.current.pauseVideo();
    } else {
      playerRef.current.playVideo();
    }
  }, [isPlaying]);

  const handleSeekToTimestamp = useCallback((timestamp: number) => {
    setCurrentTime(timestamp);
    if (playerRef.current?.seekTo) {
      playerRef.current.seekTo(timestamp, true);
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

  const handleAddComment = useCallback(async (voiceData?: { url: string; duration: number }) => {
    if (!voiceData && !commentText.trim()) return;
    if (!activeVersion) return;

    const tempId = `temp-${Date.now()}`;
    const optimisticComment: Comment = {
      id: tempId,
      content: voiceData ? commentText.trim() || null : commentText,
      timestamp: selectedTimestamp ?? currentTime,
      voiceUrl: voiceData?.url ?? null,
      voiceDuration: voiceData?.duration ?? null,
      isResolved: false,
      createdAt: new Date().toISOString(),
      author: isGuest ? null : { id: 'current-user', name: null, image: null },
      guestName: isGuest ? guestName : null,
      tag: availableTags.find(t => t.id === selectedTagId) || null,
      replies: [],
    };

    // Optimistically add comment
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

    // Clear input immediately for better UX
    setCommentText('');
    setSelectedTimestamp(null);
    setSelectedTagId(availableTags.length > 0 ? availableTags[0].id : null);
    setAudioBlob(null);

    setIsSubmittingComment(true);

    try {
      const res = await fetch(`/api/versions/${activeVersion.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: voiceData ? commentText.trim() || null : commentText,
          timestamp: selectedTimestamp ?? currentTime,
          ...(voiceData && { voiceUrl: voiceData.url, voiceDuration: voiceData.duration }),
          ...(isGuest && guestName && { guestName }),
          ...(selectedTagId && { tagId: selectedTagId }),
        }),
      });

      if (res.ok) {
        const newComment = await res.json();
        // Replace temp comment with real one
        setVideo((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            versions: prev.versions.map((v) =>
              v.id === activeVersionId
                ? { ...v, comments: v.comments.map(c => c.id === tempId ? { ...newComment, replies: [] } : c) }
                : v
            ),
          };
        });
      } else {
        // Remove optimistic comment on failure
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
      // Remove optimistic comment on error
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
    }
  }, [commentText, currentTime, selectedTimestamp, activeVersion, activeVersionId, isGuest, guestName, selectedTagId, availableTags]);

  // Voice recording handlers
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
      // Upload audio to R2
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');

      const uploadRes = await fetch('/api/upload/audio', {
        method: 'POST',
        body: formData,
      });

      if (!uploadRes.ok) {
        throw new Error('Failed to upload audio');
      }

      const { url } = await uploadRes.json();

      // Submit comment with voice URL
      await handleAddComment({ url, duration: recordingTime });
      setAudioBlob(null);
      setRecordingTime(0);
    } catch (err) {
      console.error('Failed to submit voice comment:', err);
    } finally {
      setIsUploadingAudio(false);
    }
  }, [audioBlob, activeVersion, recordingTime, handleAddComment]);

  // Voice playback
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

  // Cleanup audio on unmount
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

  const handleResolveComment = useCallback(
    async (commentId: string, currentlyResolved: boolean) => {
      // Optimistically toggle
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
          // Rollback on failure
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
        // Rollback on error
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
    },
    [activeVersionId]
  );

  // Reply to a comment
  const handleReplyComment = useCallback(async (parentId: string, voiceData?: { url: string; duration: number }) => {
    if (!voiceData && !replyText.trim()) return;
    if (!activeVersion) return;

    const tempId = `temp-reply-${Date.now()}`;
    const parentComment = comments.find((c) => c.id === parentId);
    const optimisticReply = {
      id: tempId,
      content: voiceData ? replyText.trim() || null : replyText,
      voiceUrl: voiceData?.url ?? null,
      voiceDuration: voiceData?.duration ?? null,
      createdAt: new Date().toISOString(),
      author: isGuest ? null : { id: 'current-user', name: null, image: null },
      guestName: isGuest ? guestName : null,
      tag: null,
    };

    // Optimistically add reply
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
                    ? { ...c, replies: [...c.replies, optimisticReply] }
                    : c
                ),
              }
            : v
        ),
      };
    });

    // Clear input immediately
    setReplyText('');
    setReplyingTo(null);
    setReplyAudioBlob(null);
    setReplyRecordingTime(0);

    setIsSubmittingReply(true);

    try {
      const res = await fetch(`/api/versions/${activeVersion.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: voiceData ? replyText.trim() || null : replyText,
          timestamp: parentComment?.timestamp ?? currentTime,
          parentId,
          ...(voiceData && { voiceUrl: voiceData.url, voiceDuration: voiceData.duration }),
          ...(isGuest && guestName && { guestName }),
        }),
      });

      if (res.ok) {
        const newReply = await res.json();
        // Replace temp reply with real one
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
                        ? { ...c, replies: c.replies.map(r => r.id === tempId ? newReply : r) }
                        : c
                    ),
                  }
                : v
            ),
          };
        });
      } else {
        // Remove optimistic reply on failure
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
                        ? { ...c, replies: c.replies.filter(r => r.id !== tempId) }
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
      // Remove optimistic reply on error
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
                      ? { ...c, replies: c.replies.filter(r => r.id !== tempId) }
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
    }
  }, [replyText, activeVersion, activeVersionId, comments, currentTime, isGuest, guestName]);

  // Voice recording for replies
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
      const { url } = await uploadRes.json();
      await handleReplyComment(parentId, { url, duration: replyRecordingTime });
    } catch (err) {
      console.error('Failed to submit voice reply:', err);
    } finally {
      setIsUploadingReplyAudio(false);
    }
  }, [replyAudioBlob, activeVersion, replyRecordingTime, handleReplyComment]);

  // Edit a comment
  const handleEditComment = useCallback(async (commentId: string) => {
    if (!editText.trim()) return;
    setIsSubmittingEdit(true);
    try {
      const res = await fetch(`/api/comments/${commentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editText }),
      });
      if (res.ok) {
        setVideo((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            versions: prev.versions.map((v) =>
              v.id === activeVersionId
                ? {
                  ...v,
                  comments: v.comments.map((c) => {
                    if (c.id === commentId) return { ...c, content: editText.trim() };
                    return {
                      ...c,
                      replies: c.replies.map((r) =>
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
      }
    } catch (err) {
      console.error('Failed to edit comment:', err);
    } finally {
      setIsSubmittingEdit(false);
    }
  }, [editText, activeVersionId]);

  // Delete a comment
  const handleDeleteComment = useCallback(async (commentId: string) => {
    setDeletingCommentId(commentId);
    try {
      const res = await fetch(`/api/comments/${commentId}`, { method: 'DELETE' });
      if (res.ok) {
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
                      replies: c.replies.filter((r) => r.id !== commentId),
                    })),
                }
                : v
            ),
          };
        });
      }
    } catch (err) {
      console.error('Failed to delete comment:', err);
    } finally {
      setDeletingCommentId(null);
    }
  }, [activeVersionId]);

  // Poll for new comments every 10 seconds
  useEffect(() => {
    if (!activeVersion) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/videos/${videoId}`);
        if (res.ok) {
          const data = await res.json();
          setVideo(data.data);
        }
      } catch { /* silent */ }
    }, 10000);
    return () => clearInterval(interval);
  }, [activeVersion, projectId, videoId]);

  // New version URL handler
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
    if (!newVersionSource) return;
    setIsCreatingVersion(true);

    try {
      const meta = await fetchVideoMetadata(newVersionSource);
      const thumbnailUrl = getThumbnailUrl(newVersionSource, 'large');

      const res = await fetch(`/api/projects/${projectId}/videos/${videoId}/versions`, {
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
        const videoRes = await fetch(`/api/projects/${projectId}/videos/${videoId}`);
        if (videoRes.ok) {
          const data = await videoRes.json();
          setVideo(data);
          const active = data.versions.find((v: Version) => v.isActive) || data.versions[0];
          if (active) setActiveVersionId(active.id);
        }
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

  const getEmbedUrl = (version: Version) => {
    if (version.providerId === 'youtube') {
      return `https://www.youtube.com/embed/${version.videoId}?enablejsapi=1&rel=0&modestbranding=1&controls=0&showinfo=0&iv_load_policy=3&disablekb=1`;
    }
    if (version.providerId === 'vimeo') {
      return `https://player.vimeo.com/video/${version.videoId}`;
    }
    // Security: Only allow http/https URLs to prevent XSS via javascript: URIs
    try {
      const url = new URL(version.originalUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return '';
      }
      return version.originalUrl;
    } catch {
      return '';
    }
  };

  if (loading) {
    return (
      <div className="h-[calc(100vh-3.5rem)] flex flex-col bg-background overflow-hidden">
        <div className="flex-1 flex overflow-hidden min-h-0">
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <div className="shrink-0 flex items-center justify-between h-12 px-4 border-b bg-background/50">
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
                <Skeleton className="h-8 w-28 rounded-md" />
              </div>
            </div>
            <div className="flex-1 bg-black min-h-0" />
            <div className="shrink-0 px-4 py-2 bg-background border-t">
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
          <div className="w-80 shrink-0 border-l bg-card flex flex-col overflow-hidden">
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
      <div className="h-[calc(100vh-3.5rem)] flex items-center justify-center bg-background">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">{error || 'Video not found'}</p>
          <Button asChild variant="outline">
            <Link href={`/projects/${projectId}`}>Back to Project</Link>
          </Button>
        </div>
      </div>
    );
  }

  const embedUrl = getEmbedUrl(activeVersion);

  return (
    <div
      className="h-[calc(100vh-3.5rem)] flex flex-col bg-background overflow-hidden"
      onMouseUp={handleTimelineMouseUp}
      onMouseLeave={() => isDragging && handleTimelineMouseUp()}
    >
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Video Area */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {/* Compact Header Bar */}
          <div className="shrink-0 flex items-center justify-between h-12 px-4 border-b bg-background/50">
            <div className="flex items-center gap-3">
              <Link
                href={`/projects/${projectId}`}
                className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-4 w-4 mr-1" />
                Back
              </Link>
              <Separator orientation="vertical" className="h-5" />
              <div className="min-w-0">
                <span className="text-sm font-medium">{video.title}</span>
                <span className="text-xs text-muted-foreground ml-2">• {video.project.name}</span>
              </div>
            </div>

            {/* Version Selector + Add Version */}
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
                      onClick={() => setActiveVersionId(version.id)}
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
                </DropdownMenuContent>
              </DropdownMenu>

              <Dialog open={showVersionDialog} onOpenChange={setShowVersionDialog}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Plus className="h-4 w-4 mr-1" />
                    New Version
                  </Button>
                </DialogTrigger>

                {video.versions.length >= 2 && (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/projects/${projectId}/videos/${videoId}/compare`}>
                      <GitCompareArrows className="h-4 w-4 mr-1" />
                      Compare
                    </Link>
                  </Button>
                )}
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
            </div>
          </div>

          {/* Video Player - click to play/pause, YouTube controls hidden */}
          <div
            className="flex-1 bg-black flex items-center justify-center relative cursor-pointer group min-h-0"
            onClick={handlePlayPause}
          >
            <div className="relative w-full h-full">
              <iframe
                key={activeVersionId}
                ref={iframeRef}
                src={embedUrl}
                className="absolute inset-0 w-full h-full pointer-events-none"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />

              {/* Play/Pause overlay */}
              <div
                className={cn(
                  'absolute inset-0 flex items-center justify-center bg-black/20 transition-opacity',
                  isPlaying ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
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
            </div>
          </div>

          {/* Custom Controls Bar */}
          <div className="shrink-0 px-4 py-2 bg-background border-t">
            {/* Control buttons row */}
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

              <div className="ml-auto">
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
              </div>
            </div>

            {/* Timeline with comment markers */}
            <div
              ref={timelineRef}
              className="relative h-8 bg-muted rounded cursor-pointer select-none"
              onMouseDown={handleTimelineMouseDown}
              onMouseMove={handleTimelineMouseMove}
            >
              {/* Progress */}
              <div
                className="absolute left-0 top-0 h-full bg-primary/30 rounded pointer-events-none"
                style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
              />

              {/* Playhead */}
              <div
                className="absolute top-0 h-full w-1 bg-primary rounded pointer-events-none"
                style={{ left: `calc(${duration > 0 ? (currentTime / duration) * 100 : 0}% - 2px)` }}
              />

              {/* Comment markers */}
              {comments.map((comment) => {
                const markerColor = comment.tag?.color || (comment.isResolved ? '#22C55E' : '#22D3EE');
                return (
                  <button
                    key={comment.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSeekToTimestamp(comment.timestamp);
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

        {/* Comments Sidebar */}
        <div className="w-80 shrink-0 border-l bg-card flex flex-col overflow-hidden">
          <div className="shrink-0 flex items-center justify-between p-4 border-b">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              <span className="font-medium">Comments</span>
              <Badge variant="secondary">{comments.length}</Badge>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setShowResolved(!showResolved)}>
              {showResolved ? 'Hide' : 'Show'} Resolved
            </Button>
          </div>

          {/* Comments List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {filteredComments.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No comments yet</p>
                <p className="text-sm">Be the first to leave feedback!</p>
              </div>
            ) : (
              filteredComments
                .sort((a, b) => a.timestamp - b.timestamp)
                .map((comment) => {
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
                        <div className="flex items-center gap-2">
                          <Avatar className="h-6 w-6">
                            <AvatarImage src={comment.author?.image ?? undefined} />
                            <AvatarFallback className="text-xs">
                              {authorName.charAt(0)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="text-sm font-medium">{authorName}</span>
                          {comment.tag && (
                            <span
                              className="text-[10px] font-medium px-2 py-0.5 rounded-full text-white"
                              style={{ backgroundColor: comment.tag.color }}
                            >
                              {comment.tag.name}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleSeekToTimestamp(comment.timestamp)}
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
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 opacity-0 group-hover:opacity-100"
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
                              <DropdownMenuItem onClick={() => {
                                setEditingCommentId(comment.id);
                                setEditText(comment.content || '');
                              }}>
                                <Pencil className="h-4 w-4 mr-2" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => handleDeleteComment(comment.id)}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
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
                              }
                            }}
                          />
                          <div className="flex gap-1">
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
                              onClick={() => { setEditingCommentId(null); setEditText(''); }}
                              className="h-7 text-xs"
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        comment.content && <p className="text-sm mb-2">{comment.content}</p>
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

                      <p className="text-xs text-muted-foreground">
                        {new Date(comment.createdAt).toLocaleDateString()}
                      </p>

                      {/* Replies */}
                      {comment.replies.length > 0 && (
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
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-5 w-5 opacity-0 group-hover/reply:opacity-100 shrink-0"
                                      >
                                        <MoreVertical className="h-3 w-3" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem onClick={() => {
                                        setEditingCommentId(reply.id);
                                        setEditText(reply.content || '');
                                      }}>
                                        <Pencil className="h-4 w-4 mr-2" />
                                        Edit
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        className="text-destructive"
                                        onClick={() => handleDeleteComment(reply.id)}
                                      >
                                        <Trash2 className="h-4 w-4 mr-2" />
                                        Delete
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
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
                                  reply.content && <p className="text-sm">{reply.content}</p>
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

                      {/* Inline reply form */}
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
                              <Textarea
                                value={replyText}
                                onChange={(e) => setReplyText(e.target.value)}
                                placeholder="Add a note (optional)..."
                                rows={1}
                                className="resize-none text-sm"
                              />
                              <div className="flex gap-1">
                                <Button
                                  size="sm"
                                  onClick={() => submitVoiceReply(comment.id)}
                                  disabled={isUploadingReplyAudio}
                                  className="h-7 text-xs"
                                >
                                  {isUploadingReplyAudio ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Send Voice Reply'}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={cancelReplyRecording} className="h-7 text-xs">Cancel</Button>
                              </div>
                            </div>
                          ) : (
                            <>
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
                              </div>
                              <div className="flex gap-1 mt-1">
                                <Button
                                  size="sm"
                                  onClick={() => handleReplyComment(comment.id)}
                                  disabled={!replyText.trim() || isSubmittingReply}
                                  className="h-7 text-xs"
                                >
                                  {isSubmittingReply ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Reply'}
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

                      {/* Quick reply button */}
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

          {/* Comment Input */}
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

            {/* Recording state UI */}
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
                <Textarea
                  placeholder="Add a note to your voice comment (optional)..."
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  rows={1}
                  className="resize-none text-sm"
                />
                <Button
                  size="sm"
                  onClick={submitVoiceComment}
                  disabled={isUploadingAudio}
                  className="w-full"
                >
                  {isUploadingAudio ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Uploading...
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
                  />
                  <div className="flex flex-col gap-1">
                    <Button
                      size="icon"
                      onClick={() => handleAddComment()}
                      disabled={!commentText.trim() || isSubmittingComment}
                    >
                      {isSubmittingComment ? (
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
      </div>
    </div>
  );
}
