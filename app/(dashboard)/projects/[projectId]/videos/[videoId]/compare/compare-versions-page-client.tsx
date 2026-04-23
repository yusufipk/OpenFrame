'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Hls from 'hls.js';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  MessageSquare,
  ChevronDown,
  Loader2,
  GitCompareArrows,
  Clock,
  X,
  Play,
  Pause,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import { cn } from '@/lib/utils';

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
  setPlaybackRate?: (rate: number) => void;
  destroy: () => void;
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
  tag: { id: string; name: string; color: string } | null;
}

interface VideoData {
  id: string;
  title: string;
  description: string | null;
  projectId: string;
  project: {
    name: string;
  };
  versions: Version[];
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const isSafeUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

export default function CompareVersionsPageClient({
  projectId,
  videoId,
}: {
  projectId: string;
  videoId: string;
}) {
  const searchParams = useSearchParams();

  const [video, setVideo] = useState<VideoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isApiLoaded, setIsApiLoaded] = useState(false);

  // Panel version IDs
  const [panelVersionIds, setPanelVersionIds] = useState<string[]>([]);

  // Shared playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [cursorIdle, setCursorIdle] = useState(false);
  const cursorIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // Map of versionId -> YT.Player or Custom Adapter
  const playersRef = useRef<Map<string, YT.Player | PlayerAdapter>>(new Map());
  const rafRef = useRef<number | null>(null);

  // Comments state per panel
  const [openCommentsPanel, setOpenCommentsPanel] = useState<string | null>(null);
  const [commentsCache, setCommentsCache] = useState<Map<string, Comment[]>>(new Map());
  const [commentsLoading, setCommentsLoading] = useState<string | null>(null);

  // Per-panel mute state
  const [mutedPanels, setMutedPanels] = useState<Set<string>>(new Set());

  // Refs for fast-changing playback values — avoids React re-renders on every frame
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);
  const lastCommitRef = useRef(0);

  // Direct DOM refs for progress bar / playhead / timecode — updated in the RAF loop
  const progressBarRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timecodeRef = useRef<HTMLSpanElement>(null);

  // Load YouTube IFrame API
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.YT) {
      setIsApiLoaded(true);
      return;
    }

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag?.parentNode?.insertBefore(tag, firstScriptTag);

    window.onYouTubeIframeAPIReady = () => {
      setIsApiLoaded(true);
    };
  }, []);

  // Fetch video data
  useEffect(() => {
    async function fetchVideo() {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/videos/${videoId}?includeComments=false`
        );
        if (!res.ok) {
          setError('Failed to load video');
          setLoading(false);
          return;
        }
        const response = await res.json();
        const data = response.data;
        setVideo(data);

        const versionsParam = searchParams.get('versions');
        if (versionsParam) {
          const ids = versionsParam
            .split(',')
            .filter((id) => data.versions.some((v: Version) => v.id === id));
          if (ids.length >= 2) {
            setPanelVersionIds(ids);
          } else {
            const sorted = [...data.versions].sort(
              (a: Version, b: Version) => a.versionNumber - b.versionNumber
            );
            setPanelVersionIds([sorted[sorted.length - 2].id, sorted[sorted.length - 1].id]);
          }
        } else if (data.versions.length >= 2) {
          const sorted = [...data.versions].sort(
            (a: Version, b: Version) => a.versionNumber - b.versionNumber
          );
          setPanelVersionIds([sorted[sorted.length - 2].id, sorted[sorted.length - 1].id]);
        } else if (data.versions.length === 1) {
          setPanelVersionIds([data.versions[0].id]);
        }
      } catch {
        setError('Failed to load video');
      } finally {
        setLoading(false);
      }
    }
    fetchVideo();
  }, [projectId, videoId, searchParams]);

  // Auto-fetch comments for all panels so timeline markers appear immediately
  useEffect(() => {
    if (panelVersionIds.length === 0) return;

    panelVersionIds.forEach(async (versionId) => {
      if (commentsCache.has(versionId)) return;
      try {
        const res = await fetch(`/api/versions/${versionId}/comments`);
        const json = await res.json();
        const data = json.data;
        const commentsList = Array.isArray(data) ? data : (data?.comments ?? []);
        setCommentsCache((prev) => new Map(prev).set(versionId, commentsList));
      } catch {
        setCommentsCache((prev) => new Map(prev).set(versionId, []));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelVersionIds]);

  // RAF loop: update refs + DOM every frame, throttle React state commits to ~250ms
  useEffect(() => {
    const tick = (timestamp: number) => {
      if (!isDragging) {
        const players = Array.from(playersRef.current.values());
        const sourcePlayer = players[0];
        if (sourcePlayer) {
          try {
            const t = sourcePlayer.getCurrentTime();
            const d = sourcePlayer.getDuration();
            const playing = sourcePlayer.getPlayerState() === window.YT?.PlayerState?.PLAYING;

            // Update refs immediately — zero React overhead
            if (t !== undefined) currentTimeRef.current = t;
            if (d > 0) durationRef.current = d;
            // Directly mutate DOM for smooth timeline visuals without re-renders
            const dur = durationRef.current;
            if (t !== undefined && dur > 0) {
              const pct = (t / dur) * 100;
              if (progressBarRef.current) progressBarRef.current.style.width = `${pct}%`;
              if (playheadRef.current) playheadRef.current.style.left = `calc(${pct}% - 2px)`;
              if (timecodeRef.current) {
                timecodeRef.current.textContent = `${formatTime(t)} / ${formatTime(dur)}`;
              }
            }

            // Throttle React state commits to ~4 updates/sec
            if (timestamp - lastCommitRef.current >= 250) {
              lastCommitRef.current = timestamp;
              if (t !== undefined) setCurrentTime(t);
              if (d > 0) setDuration(d);
              setIsPlaying(playing);
            }
          } catch {
            // Player not ready
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isDragging]);

  // Register/unregister players
  const registerPlayer = useCallback((versionId: string, player: YT.Player | PlayerAdapter) => {
    playersRef.current.set(versionId, player);
  }, []);

  const unregisterPlayer = useCallback((versionId: string) => {
    playersRef.current.delete(versionId);
  }, []);

  // =====================
  // Shared playback controls — always synced
  // =====================
  const handlePlayPause = useCallback(() => {
    const players = Array.from(playersRef.current.values());
    if (players.length === 0) return;

    try {
      const firstPlayer = players[0];
      const state = firstPlayer.getPlayerState();
      const playing = state === window.YT?.PlayerState?.PLAYING;

      if (playing) {
        players.forEach((p) => {
          try {
            p.pauseVideo();
          } catch {
            /* */
          }
        });
        setIsPlaying(false);
      } else {
        const t = firstPlayer.getCurrentTime();
        players.forEach((p) => {
          try {
            p.seekTo(t, true);
            p.playVideo();
          } catch {
            /* */
          }
        });
        setIsPlaying(true);
      }
    } catch {
      // Player not ready
    }
  }, []);

  const handleSeek = useCallback((time: number) => {
    const players = Array.from(playersRef.current.values());
    players.forEach((p) => {
      try {
        p.seekTo(time, true);
      } catch {
        /* */
      }
    });
    setCurrentTime(time);
  }, []);

  const handleTimelineMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!timelineRef.current || durationRef.current <= 0) return;
      setIsDragging(true);
      const rect = timelineRef.current.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const time = fraction * durationRef.current;
      currentTimeRef.current = time;
      setCurrentTime(time);
      handleSeek(time);
    },
    [handleSeek]
  );

  const handleTimelineMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging || !timelineRef.current || durationRef.current <= 0) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const time = fraction * durationRef.current;
      currentTimeRef.current = time;
      setCurrentTime(time);
      // Keep DOM in sync while the RAF loop is paused during drag
      const pct = fraction * 100;
      if (progressBarRef.current) progressBarRef.current.style.width = `${pct}%`;
      if (playheadRef.current) playheadRef.current.style.left = `calc(${pct}% - 2px)`;
      if (timecodeRef.current) {
        timecodeRef.current.textContent = `${formatTime(time)} / ${formatTime(durationRef.current)}`;
      }
    },
    [isDragging]
  );

  const handleTimelineMouseUp = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);
    handleSeek(currentTimeRef.current);
  }, [isDragging, handleSeek]);

  const handleVideoMouseMove = useCallback(() => {
    setCursorIdle(false);
    if (cursorIdleTimerRef.current) {
      clearTimeout(cursorIdleTimerRef.current);
    }

    if (isPlaying) {
      cursorIdleTimerRef.current = setTimeout(() => {
        setCursorIdle(true);
      }, 1000);
    }
  }, [isPlaying]);

  const handleVideoMouseLeave = useCallback(() => {
    if (cursorIdleTimerRef.current) {
      clearTimeout(cursorIdleTimerRef.current);
    }
    setCursorIdle(false);
  }, []);

  useEffect(() => {
    return () => {
      if (cursorIdleTimerRef.current) {
        clearTimeout(cursorIdleTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (cursorIdleTimerRef.current) {
      clearTimeout(cursorIdleTimerRef.current);
      cursorIdleTimerRef.current = null;
    }

    if (!isPlaying) {
      setCursorIdle(false);
      return;
    }

    cursorIdleTimerRef.current = setTimeout(() => {
      setCursorIdle(true);
    }, 1000);

    return () => {
      if (cursorIdleTimerRef.current) {
        clearTimeout(cursorIdleTimerRef.current);
        cursorIdleTimerRef.current = null;
      }
    };
  }, [isPlaying]);

  // Keyboard shortcuts (matching video page)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return;

      const players = Array.from(playersRef.current.values());
      if (players.length === 0) return;

      switch (e.code) {
        case 'Space':
        case 'KeyK':
          e.preventDefault();
          handlePlayPause();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          handleSeek(Math.max(0, currentTimeRef.current - 5));
          break;
        case 'ArrowRight':
          e.preventDefault();
          handleSeek(Math.min(durationRef.current, currentTimeRef.current + 5));
          break;
        case 'KeyJ':
          e.preventDefault();
          handleSeek(Math.max(0, currentTimeRef.current - 10));
          break;
        case 'KeyL':
          e.preventDefault();
          handleSeek(Math.min(durationRef.current, currentTimeRef.current + 10));
          break;
        case 'KeyM':
          e.preventDefault();
          players.forEach((p) => {
            try {
              if (p.isMuted?.()) {
                p.unMute?.();
              } else {
                p.mute?.();
              }
            } catch {
              /* */
            }
          });
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlePlayPause, handleSeek]);

  // Fetch comments for a version
  const toggleComments = useCallback(
    async (versionId: string) => {
      if (openCommentsPanel === versionId) {
        setOpenCommentsPanel(null);
        return;
      }
      setOpenCommentsPanel(versionId);

      if (!commentsCache.has(versionId)) {
        setCommentsLoading(versionId);
        try {
          const res = await fetch(`/api/versions/${versionId}/comments`);
          const json = await res.json();
          const data = json.data;
          const commentsList = Array.isArray(data) ? data : (data?.comments ?? []);
          setCommentsCache((prev) => new Map(prev).set(versionId, commentsList));
        } catch {
          setCommentsCache((prev) => new Map(prev).set(versionId, []));
        } finally {
          setCommentsLoading(null);
        }
      }
    },
    [openCommentsPanel, commentsCache]
  );

  const handleChangeVersion = useCallback((panelIndex: number, newVersionId: string) => {
    setPanelVersionIds((prev) => {
      const next = [...prev];
      const oldId = next[panelIndex];
      const oldPlayer = playersRef.current.get(oldId);
      if (oldPlayer) {
        try {
          oldPlayer.destroy();
        } catch {
          /* */
        }
        playersRef.current.delete(oldId);
      }
      next[panelIndex] = newVersionId;
      return next;
    });
    setOpenCommentsPanel(null);
  }, []);

  // Collect all comments from all visible panels for timeline markers
  const allTimelineComments = panelVersionIds.flatMap((vid) => {
    const comments = commentsCache.get(vid) || [];
    const version = video?.versions.find((v) => v.id === vid);
    return comments.map((c) => ({
      ...c,
      versionNumber: version?.versionNumber ?? 0,
    }));
  });

  const usedVersionIds = new Set(panelVersionIds);

  if (loading) {
    return (
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        <div className="shrink-0 flex items-center justify-between h-12 px-4 border-b bg-background/50">
          <div className="flex items-center gap-3">
            <Skeleton className="h-4 w-24" />
            <Separator orientation="vertical" className="h-5" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 w-36" />
            </div>
          </div>
        </div>
        <div className="flex-1 flex overflow-hidden">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="flex-1 flex flex-col overflow-hidden border-r last:border-r-0">
              <div className="shrink-0 flex items-center justify-center h-10 px-4 border-b bg-muted/30">
                <Skeleton className="h-6 w-40 rounded-md" />
              </div>
              <div className="flex-1 bg-black" />
            </div>
          ))}
        </div>
        <div className="shrink-0 px-4 py-2 border-t">
          <Skeleton className="h-8 w-full rounded" />
        </div>
      </div>
    );
  }

  if (error || !video || video.versions.length < 2) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">
            {error || 'Need at least 2 versions to compare'}
          </p>
          <Button asChild variant="outline">
            <Link href={`/projects/${projectId}/videos/${videoId}`}>Back to Video</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-screen flex flex-col bg-background overflow-hidden"
      onMouseUp={handleTimelineMouseUp}
      onMouseLeave={() => isDragging && handleTimelineMouseUp()}
    >
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between h-12 px-4 border-b bg-background/50">
        <div className="flex items-center gap-3">
          <Link
            href={`/projects/${projectId}/videos/${videoId}`}
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Link>
          <Separator orientation="vertical" className="h-5" />
          <div className="flex items-center gap-2">
            <GitCompareArrows className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Compare Versions</span>
            <span className="text-xs text-muted-foreground hidden sm:inline">• {video.title}</span>
          </div>
        </div>
      </div>

      {/* Video panels */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {panelVersionIds.map((versionId, index) => {
          const version = video.versions.find((v) => v.id === versionId);
          if (!version) return null;
          const panelComments = commentsCache.get(versionId) || [];
          const isCommentsOpen = openCommentsPanel === versionId;
          const isLoadingComments = commentsLoading === versionId;

          return (
            <div
              key={`${versionId}-${index}`}
              className="flex-1 flex flex-col border-r last:border-r-0 min-w-0 overflow-hidden"
            >
              {/* Panel header */}
              <div className="shrink-0 flex items-center justify-between p-2 border-b bg-muted/30">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Badge variant="secondary" className="mr-1.5">
                        v{version.versionNumber}
                      </Badge>
                      <span className="truncate max-w-[100px]">
                        {version.versionLabel || `Version ${version.versionNumber}`}
                      </span>
                      <ChevronDown className="h-3.5 w-3.5 ml-1.5 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    {video.versions.map((v) => (
                      <DropdownMenuItem
                        key={v.id}
                        onClick={() => handleChangeVersion(index, v.id)}
                        disabled={usedVersionIds.has(v.id) && v.id !== version.id}
                      >
                        <Badge
                          variant={v.id === version.id ? 'default' : 'secondary'}
                          className="mr-2"
                        >
                          v{v.versionNumber}
                        </Badge>
                        {v.versionLabel || `Version ${v.versionNumber}`}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => {
                      const player = playersRef.current.get(versionId);
                      if (!player) return;
                      const isMuted = mutedPanels.has(versionId);
                      try {
                        if (isMuted) {
                          player.unMute();
                        } else {
                          player.mute();
                        }
                      } catch {
                        /* */
                      }
                      setMutedPanels((prev) => {
                        const next = new Set(prev);
                        if (isMuted) {
                          next.delete(versionId);
                        } else {
                          next.add(versionId);
                        }
                        return next;
                      });
                    }}
                    title={mutedPanels.has(versionId) ? 'Unmute' : 'Mute'}
                  >
                    {mutedPanels.has(versionId) ? (
                      <VolumeX className="h-3.5 w-3.5" />
                    ) : (
                      <Volume2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    variant={isCommentsOpen ? 'secondary' : 'ghost'}
                    size="sm"
                    className="gap-1.5 text-xs"
                    onClick={() => toggleComments(versionId)}
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    {version._count.comments}
                  </Button>
                </div>
              </div>

              {/* Video embed with click-to-play overlay */}
              <div
                className={cn(
                  'bg-black flex items-center justify-center relative cursor-pointer group',
                  cursorIdle && isPlaying && 'cursor-none',
                  isCommentsOpen ? 'h-[55%]' : 'flex-1'
                )}
                onClick={handlePlayPause}
                onMouseMove={handleVideoMouseMove}
                onMouseLeave={handleVideoMouseLeave}
              >
                {version.providerId === 'youtube' ? (
                  <YouTubePanel
                    key={versionId}
                    version={version}
                    isApiLoaded={isApiLoaded}
                    onRegister={registerPlayer}
                    onUnregister={unregisterPlayer}
                  />
                ) : version.providerId === 'bunny' ? (
                  <BunnyPanel
                    key={versionId}
                    version={version}
                    onRegister={registerPlayer}
                    onUnregister={unregisterPlayer}
                  />
                ) : isSafeUrl(version.originalUrl) ? (
                  <iframe
                    src={version.originalUrl}
                    className="w-full h-full pointer-events-none"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                ) : null}

                {/* Play/pause overlay */}
                <div
                  className={cn(
                    'absolute inset-0 flex items-center justify-center bg-black/20 transition-opacity duration-300 pointer-events-none',
                    isPlaying
                      ? cursorIdle
                        ? 'opacity-0'
                        : 'opacity-0 group-hover:opacity-100'
                      : 'opacity-100'
                  )}
                >
                  <div className="w-14 h-14 rounded-full bg-black/60 flex items-center justify-center">
                    {isPlaying ? (
                      <Pause className="h-7 w-7 text-white" />
                    ) : (
                      <Play className="h-7 w-7 text-white ml-1" />
                    )}
                  </div>
                </div>
              </div>

              {/* Read-only comments panel */}
              {isCommentsOpen && (
                <div className="h-[45%] flex flex-col border-t bg-card overflow-hidden">
                  <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b">
                    <div className="flex items-center gap-1.5">
                      <MessageSquare className="h-3.5 w-3.5" />
                      <span className="text-xs font-medium">Comments</span>
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        {panelComments.length}
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => setOpenCommentsPanel(null)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {isLoadingComments ? (
                      <div className="flex items-center justify-center py-6">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : panelComments.length === 0 ? (
                      <div className="text-center py-6 text-muted-foreground text-xs">
                        No comments on this version
                      </div>
                    ) : (
                      [...panelComments]
                        .sort((a, b) => a.timestamp - b.timestamp)
                        .map((comment) => {
                          const authorName =
                            comment.author?.name || comment.guestName || 'Anonymous';
                          return (
                            <div
                              key={comment.id}
                              className={cn(
                                'rounded-lg border p-2 text-xs',
                                comment.isResolved && 'opacity-60'
                              )}
                            >
                              <div className="flex items-center gap-1.5 mb-1">
                                <Avatar className="h-4 w-4">
                                  <AvatarImage src={comment.author?.image ?? undefined} />
                                  <AvatarFallback className="text-[8px]">
                                    {authorName.charAt(0)}
                                  </AvatarFallback>
                                </Avatar>
                                <span className="font-medium truncate">{authorName}</span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleSeek(comment.timestamp);
                                  }}
                                  className="ml-auto flex items-center gap-0.5 text-primary bg-primary/10 px-1 py-0.5 rounded text-[10px] hover:bg-primary/20 transition-colors"
                                >
                                  <Clock className="h-2.5 w-2.5" />
                                  {formatTime(comment.timestamp)}
                                </button>
                              </div>
                              {comment.content && (
                                <p className="text-muted-foreground leading-relaxed">
                                  {comment.content}
                                </p>
                              )}
                              {comment.tag && (
                                <Badge
                                  variant="outline"
                                  className="mt-1 text-[10px] px-1.5 py-0"
                                  style={{
                                    borderColor: comment.tag.color,
                                    color: comment.tag.color,
                                  }}
                                >
                                  {comment.tag.name}
                                </Badge>
                              )}
                            </div>
                          );
                        })
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Shared playback controls */}
      <div className="shrink-0 px-4 py-2 bg-background border-t">
        <div className="flex items-center gap-2 mb-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handlePlayPause}>
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
          </Button>
          <span ref={timecodeRef} className="text-xs text-muted-foreground tabular-nums">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>

        <div
          ref={timelineRef}
          className="relative h-8 bg-muted rounded cursor-pointer select-none"
          onMouseDown={handleTimelineMouseDown}
          onMouseMove={handleTimelineMouseMove}
        >
          {/* Progress bar */}
          <div
            ref={progressBarRef}
            className="absolute left-0 top-0 h-full bg-primary/30 rounded pointer-events-none"
            style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
          />
          {/* Playhead */}
          <div
            ref={playheadRef}
            className="absolute top-0 h-full w-1 bg-primary rounded pointer-events-none"
            style={{ left: `calc(${duration > 0 ? (currentTime / duration) * 100 : 0}% - 2px)` }}
          />

          {/* Comment markers on timeline */}
          {allTimelineComments.map((comment) => {
            const markerColor = comment.tag?.color || (comment.isResolved ? '#22C55E' : '#22D3EE');
            return (
              <button
                key={comment.id}
                onClick={(e) => {
                  e.stopPropagation();
                  handleSeek(comment.timestamp);
                }}
                className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full transition-transform hover:scale-150 z-10"
                style={{
                  left: `calc(${duration > 0 ? (comment.timestamp / duration) * 100 : 0}% - 6px)`,
                  backgroundColor: markerColor,
                }}
                title={`v${comment.versionNumber} • ${formatTime(comment.timestamp)} - ${comment.content?.substring(0, 30) || '(comment)'}...`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Isolated YouTube player component per panel
function YouTubePanel({
  version,
  isApiLoaded,
  onRegister,
  onUnregister,
}: {
  version: Version;
  isApiLoaded: boolean;
  onRegister: (versionId: string, player: YT.Player) => void;
  onUnregister: (versionId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YT.Player | null>(null);

  useEffect(() => {
    if (!isApiLoaded || !containerRef.current) return;

    const initPlayer = () => {
      if (!containerRef.current) return;
      const player = new window.YT.Player(containerRef.current, {
        videoId: version.videoId,
        playerVars: {
          rel: 0,
          modestbranding: 1,
          enablejsapi: 1,
          controls: 0,
          showinfo: 0,
          iv_load_policy: 3,
          disablekb: 1,
        } as YT.PlayerVars,
        events: {
          onReady: () => {
            onRegister(version.id, player);
          },
        },
      });
      playerRef.current = player;
    };

    if (window.YT?.Player) {
      const timeout = setTimeout(initPlayer, 50);
      return () => {
        clearTimeout(timeout);
        onUnregister(version.id);
        if (playerRef.current) {
          try {
            playerRef.current.destroy();
          } catch {
            /* */
          }
          playerRef.current = null;
        }
      };
    }

    return () => {
      onUnregister(version.id);
      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch {
          /* */
        }
        playerRef.current = null;
      }
    };
  }, [version.id, version.videoId, isApiLoaded, onRegister, onUnregister]);

  return <div ref={containerRef} className="w-full h-full pointer-events-none" />;
}

// Isolated Bunny Stream player component per panel mapped to the shared adapter interface
function BunnyPanel({
  version,
  onRegister,
  onUnregister,
}: {
  version: Version;
  onRegister: (versionId: string, player: YT.Player | PlayerAdapter) => void;
  onUnregister: (versionId: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const bunnyCdnHostname = useMemo(() => resolvePublicBunnyCdnHostname(), []);
  const [portraitFrameWidth, setPortraitFrameWidth] = useState<number>(0);
  const [isPortraitSource, setIsPortraitSource] = useState(false);

  useEffect(() => {
    const panelEl = panelRef.current;
    if (!panelEl || typeof ResizeObserver === 'undefined') return;

    const updateFrameWidth = () => {
      const panelWidth = panelEl.clientWidth;
      const panelHeight = panelEl.clientHeight;
      if (panelWidth <= 0 || panelHeight <= 0) return;
      setPortraitFrameWidth(Math.min(panelWidth, panelHeight * (9 / 16)));
    };

    updateFrameWidth();
    const observer = new ResizeObserver(updateFrameWidth);
    observer.observe(panelEl);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    let cachedTime = 0;
    let cachedDuration = 0;
    let isPlaying = false;
    let destroyed = false;
    let retryAttempt = 0;
    let sourceMode: 'hls' | 'original' = 'hls';
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetryTimer = () => {
      if (!retryTimer) return;
      clearTimeout(retryTimer);
      retryTimer = null;
    };
    const getRetryUrl = (baseUrl: string) => {
      retryAttempt += 1;
      const separator = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${separator}retry=${Date.now()}-${retryAttempt}`;
    };
    const scheduleRetry = (retryFn: () => void) => {
      clearRetryTimer();
      retryTimer = setTimeout(() => {
        if (!destroyed) {
          retryFn();
        }
      }, 3000);
    };

    const adapter: PlayerAdapter = {
      playVideo: () => {
        videoEl.play().catch((err) => console.error('Error playing Bunny panel video:', err));
      },
      pauseVideo: () => videoEl.pause(),
      seekTo: (time: number) => {
        cachedTime = time;
        videoEl.currentTime = time;
      },
      mute: () => {
        videoEl.muted = true;
      },
      unMute: () => {
        videoEl.muted = false;
      },
      isMuted: () => videoEl.muted,
      getCurrentTime: () => videoEl.currentTime || cachedTime,
      getDuration: () => {
        if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
          cachedDuration = videoEl.duration;
        }
        return cachedDuration;
      },
      getPlayerState: () =>
        isPlaying ? (window.YT?.PlayerState?.PLAYING ?? 1) : (window.YT?.PlayerState?.PAUSED ?? 2),
      setPlaybackRate: (rate: number) => {
        videoEl.playbackRate = rate;
      },
      destroy: () => {
        destroyed = true;
        clearRetryTimer();
        videoEl.removeEventListener('timeupdate', onTimeUpdate);
        videoEl.removeEventListener('play', onPlay);
        videoEl.removeEventListener('pause', onPause);
        videoEl.removeEventListener('ended', onEnded);
        videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
        videoEl.removeEventListener('error', onError);
        if (hlsRef.current) {
          try {
            hlsRef.current.destroy();
          } catch {
            /* ignore */
          }
          hlsRef.current = null;
        }
        videoEl.removeAttribute('src');
        videoEl.load();
      },
    };

    const onLoadedMetadata = () => {
      clearRetryTimer();
      if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
        cachedDuration = videoEl.duration;
      }
      if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        setIsPortraitSource(videoEl.videoHeight > videoEl.videoWidth);
      }
    };
    const onTimeUpdate = () => {
      cachedTime = videoEl.currentTime || 0;
    };
    const onPlay = () => {
      isPlaying = true;
    };
    const onPause = () => {
      isPlaying = false;
    };
    const onEnded = () => {
      isPlaying = false;
    };
    if (!bunnyCdnHostname) {
      return;
    }
    const hlsUrl = `https://${bunnyCdnHostname}/${version.videoId}/playlist.m3u8`;
    const originalUrl = `https://${bunnyCdnHostname}/${version.videoId}/original`;
    const activateOriginalFallback = (): void => {
      sourceMode = 'original';
      clearRetryTimer();
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch {
          /* ignore */
        }
        hlsRef.current = null;
      }
      videoEl.src = getRetryUrl(originalUrl);
      videoEl.load();
    };
    const onError = () => {
      if (destroyed) return;
      if (videoEl.readyState >= HTMLMediaElement.HAVE_METADATA) {
        return;
      }
      if (sourceMode === 'hls') {
        activateOriginalFallback();
        return;
      }
      scheduleRetry(() => {
        videoEl.src = getRetryUrl(originalUrl);
        videoEl.load();
      });
    };

    videoEl.addEventListener('loadedmetadata', onLoadedMetadata);
    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('play', onPlay);
    videoEl.addEventListener('pause', onPause);
    videoEl.addEventListener('ended', onEnded);
    videoEl.addEventListener('error', onError);
    if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      sourceMode = 'hls';
      videoEl.src = hlsUrl;
      videoEl.load();
    } else if (Hls.isSupported()) {
      sourceMode = 'hls';
      const hls = new Hls();
      hlsRef.current = hls;
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        if (!destroyed) {
          hls.loadSource(hlsUrl);
        }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (destroyed) return;
        clearRetryTimer();
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (destroyed) return;
        const responseCode = (data as { response?: { code?: number } }).response?.code;
        const isManifestLoadFailure =
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT;
        const hasProcessingLikeStatus =
          responseCode === undefined ||
          responseCode === 0 ||
          responseCode === 403 ||
          responseCode === 404 ||
          responseCode === 423 ||
          responseCode === 429 ||
          responseCode === 503;
        const isLikelyProcessing = isManifestLoadFailure && hasProcessingLikeStatus;
        const isNetworkPreMetadataProcessing =
          data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          hasProcessingLikeStatus &&
          videoEl.readyState < HTMLMediaElement.HAVE_METADATA;
        const isUnknownPreMetadataProcessing =
          !data.details && !data.type && videoEl.readyState < HTMLMediaElement.HAVE_METADATA;

        if (
          isLikelyProcessing ||
          isNetworkPreMetadataProcessing ||
          isUnknownPreMetadataProcessing
        ) {
          if (sourceMode === 'hls') {
            activateOriginalFallback();
            return;
          }
          scheduleRetry(() => {
            if (sourceMode === 'original') {
              videoEl.src = getRetryUrl(originalUrl);
              videoEl.load();
              return;
            }
            const retryUrl = getRetryUrl(hlsUrl);
            try {
              hls.stopLoad();
            } catch {
              // ignore stop-load failures; loadSource is the important part
            }
            hls.loadSource(retryUrl);
            hls.startLoad(-1);
          });
          return;
        }

        if (data.fatal) {
          console.error('Fatal HLS error in compare panel:', data);
        }
      });
    } else {
      console.error('HLS is not supported in this browser.');
    }

    onRegister(version.id, adapter);

    return () => {
      onUnregister(version.id);
      adapter.destroy();
    };
  }, [version.id, version.videoId, onRegister, onUnregister, bunnyCdnHostname]);

  return (
    <div
      ref={panelRef}
      className="relative w-full h-full group flex items-center justify-center bg-black"
    >
      <div
        className={cn(
          'relative flex items-center justify-center bg-black',
          isPortraitSource ? 'h-full overflow-hidden' : 'w-full h-full'
        )}
        style={
          isPortraitSource && portraitFrameWidth > 0
            ? { width: `${portraitFrameWidth}px` }
            : undefined
        }
      >
        <video
          ref={videoRef}
          className="w-full h-full object-contain pointer-events-none border-0 bg-black"
          style={{
            pointerEvents: 'none',
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
  );
}
