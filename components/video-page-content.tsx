'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import Hls from 'hls.js';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { type AnnotationStroke, type AnnotationCanvasHandle } from '@/components/annotation-canvas';
import { useLiveReview } from '@/components/video-page/hooks/use-live-review';
import { LiveReviewBar, LiveReviewEntryControl } from '@/components/video-page/live-review-bar';
import {
  LiveReviewCanvas,
  type LiveReviewCanvasHandle,
} from '@/components/video-page/live-review-canvas';
import type { LiveStroke } from '@/lib/live-review/protocol';
import { versionCommentsPath } from '@/lib/client/version-comments';
import { PlayerCore } from '@/components/video-page/player-core';
import { VideoPageHeader } from '@/components/video-page/video-page-header';
import { ImagePreviewDialog } from '@/components/video-page/image-preview-dialog';
import { CompareVersionsDialog } from '@/components/video-page/compare-versions-dialog';
import { VideoPageLoading } from '@/components/video-page/video-page-loading';
import { VideoPageError } from '@/components/video-page/video-page-error';
import { GuestNameGate } from '@/components/video-page/guest-name-gate';
import { useCommentMedia } from '@/components/video-page/hooks/use-comment-media';
import { validateAnnotationStrokes } from '@/lib/validation';
import { resolveR2PlaybackUrl } from '@/lib/video-upload-validation';
import { useVersionActions } from '@/components/video-page/hooks/use-version-actions';
import { useWatchProgress } from '@/components/video-page/hooks/use-watch-progress';
import { useVideoPlayer } from '@/components/video-page/hooks/use-video-player';
import { useCommentActions } from '@/components/video-page/hooks/use-comment-actions';
import { useVideoPageData } from '@/components/video-page/hooks/use-video-page-data';
import { useCommentExport } from '@/components/video-page/hooks/use-comment-export';
import { useDownloadActions } from '@/components/video-page/hooks/use-download-actions';
import { useVersionDurationSync } from '@/components/video-page/hooks/use-version-duration-sync';
import { CommentComposer } from '@/components/video-page/comment-composer';
import { CommentsPane } from '@/components/video-page/comments-pane';
import { AssetsPane } from '@/components/video-page/assets-pane';
import { ApprovalRequestDialog } from '@/components/video-page/approval-request-dialog';
import { ApprovalRequestsPanel } from '@/components/video-page/approval-requests-panel';
import type {
  CommentMarker,
  PlayerAdapter,
  VideoPageCommentsActions,
  VideoPageCompareActions,
  VideoPageComposerActions,
  VideoPageHeaderActions,
} from '@/components/video-page/types';
import { useApprovals } from '@/components/video-page/hooks/use-approvals';
import { useVideoAssets } from '@/components/video-page/hooks/use-video-assets';
import { useSubtitles } from '@/components/video-page/hooks/use-subtitles';
import { useYoutubeCaptions } from '@/components/video-page/hooks/use-youtube-captions';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import { getSpeedOptionsForProvider } from '@/components/video-page/hooks/video-player-utils';

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

function formatBunnyQualityLabel(
  level: { height?: number; bitrate?: number },
  index: number
): string {
  if (typeof level.height === 'number' && level.height > 0) {
    return `${level.height}p`;
  }
  if (typeof level.bitrate === 'number' && level.bitrate > 0) {
    return `${Math.round(level.bitrate / 1000)} kbps`;
  }
  return `Level ${index + 1}`;
}

export type VideoPageMode = 'dashboard' | 'watch';

interface VideoPageContentProps {
  mode: VideoPageMode;
  videoId: string;
  projectId?: string;
  directUploadsEnabled?: boolean;
  directUploadProvider?: import('@/components/video-page/types').DirectUploadProvider;
}

export function VideoPageContent({
  mode,
  videoId,
  projectId: propProjectId,
  directUploadsEnabled = false,
  directUploadProvider = 'bunny',
}: VideoPageContentProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const bunnyViewportRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const playerRef = useRef<YT.Player | PlayerAdapter | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const scrubReadoutRef = useRef<HTMLDivElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const scheduleWatchProgressSaveRef = useRef<
    (input: { progress: number; duration?: number; immediate?: boolean; force?: boolean }) => void
  >(() => {});

  const {
    playingVoiceId,
    voiceProgress,
    voiceCurrentTime,
    voicePlaybackRate,
    downloadingVoiceIds,
    playVoice,
    toggleVoiceSpeed,
    downloadVoice,
  } = useCommentMedia();
  const [showResolved, setShowResolved] = useState(false);
  const [activeSidePane, setActiveSidePane] = useState<'comments' | 'assets'>('comments');
  const [highlightedAssetId, setHighlightedAssetId] = useState<string | null>(null);

  const editAnnotationCanvasRef = useRef<AnnotationCanvasHandle>(null);

  // Annotation state
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [annotationStrokes, setAnnotationStrokes] = useState<AnnotationStroke[] | null>(null);
  const [viewingAnnotation, setViewingAnnotation] = useState<AnnotationStroke[] | null>(null);
  const annotationCanvasRef = useRef<AnnotationCanvasHandle>(null);

  const [guestName, setGuestName] = useState(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem('openframe_guest_name') || '';
  });
  const [guestNameConfirmed, setGuestNameConfirmed] = useState(() => {
    if (mode === 'dashboard') return true;
    if (typeof window === 'undefined') return false;
    return !!localStorage.getItem('openframe_guest_name');
  });

  // Compare dialog state
  const [showCompareDialog, setShowCompareDialog] = useState(false);
  const [selectedCompareVersions, setSelectedCompareVersions] = useState<Set<string>>(new Set());
  const [showApprovalRequestDialog, setShowApprovalRequestDialog] = useState(false);
  const [showApprovalsPanel, setShowApprovalsPanel] = useState(false);
  const router = useRouter();

  const {
    video,
    setVideo,
    loading,
    error,
    activeVersionId,
    setActiveVersionId,
    availableTags,
    selectedTagId,
    setSelectedTagId,
    projectId,
    fetchVersionComments,
  } = useVideoPageData({
    mode,
    videoId,
    propProjectId,
  });

  const isGuest = video ? !video.isAuthenticated : false;
  const canInitializePlayer = mode !== 'watch' || !isGuest || guestNameConfirmed;
  const normalizedGuestName = guestName.trim();
  const canUploadAssets = !!video?.canUploadAssets;
  const canDownloadAssets = !!video?.canDownloadAssets;

  const {
    assets,
    isLoadingAssets,
    isCreatingAsset,
    deletingAssetIds,
    activeDownloadAssetId,
    hasMoreAssets,
    isLoadingMoreAssets,
    fetchAssets,
    loadMoreAssets,
    createAsset,
    deleteAsset,
    downloadAsset,
    getGuestUploadToken,
  } = useVideoAssets({
    videoId,
    isAuthenticated: !!video?.isAuthenticated,
    canUploadAssets,
    canDownloadAssets,
    guestName: normalizedGuestName,
  });

  const {
    showVersionDialog,
    setShowVersionDialog,
    newVersionUrl,
    newVersionLabel,
    setNewVersionLabel,
    newVersionSource,
    newVersionUrlError,
    isCreatingVersion,
    newVersionMode,
    setNewVersionMode,
    newVersionFile,
    setNewVersionFile,
    newVersionUploadProgress,
    newVersionUploadStatus,
    handleNewVersionUrlChange,
    handleCreateVersion,
    showDeleteVersionDialog,
    setShowDeleteVersionDialog,
    setVersionToDelete,
    isDeletingVersion,
    handleDeleteVersion,
  } = useVersionActions({
    projectId: propProjectId,
    videoId,
    directUploadsEnabled,
    directUploadProvider,
    setVideo,
    activeVersionId,
    setActiveVersionId,
  });

  // Memoize toggle show resolved handler
  const handleToggleShowResolved = useCallback(() => {
    setShowResolved((prev) => !prev);
  }, []);

  const handleAssetMentionClick = useCallback((assetId: string) => {
    setActiveSidePane('assets');
    setHighlightedAssetId(assetId);
  }, []);

  const { isExportingCsv, isExportingPdf, exportComments } = useCommentExport({
    activeVersionId,
    showResolved,
  });

  // Determine current user info for permission checks and comment display
  const currentUserId = video?.currentUserId || null;
  const currentUserName = video?.currentUserName || null;
  const canResolveComments = !!video?.canResolveComments;
  const canRequestApproval = !!video?.canRequestApproval;
  const canShareVideo = !!video?.canShareVideo;

  const {
    requests: approvalRequests,
    candidates: approvalCandidates,
    isLoadingRequests: isLoadingApprovals,
    isLoadingCandidates: isLoadingApprovalCandidates,
    isSubmittingRequest: isSubmittingApprovalRequest,
    isSubmittingDecision: isSubmittingApprovalDecision,
    isCancelingRequest: isCancelingApprovalRequest,
    activePendingRequest,
    error: approvalError,
    setError: setApprovalError,
    fetchRequests: fetchApprovalRequests,
    fetchCandidates: fetchApprovalCandidates,
    createRequest: createApprovalRequest,
    submitDecision: submitApprovalDecision,
    cancelRequest: cancelApprovalRequest,
  } = useApprovals({
    projectId,
    activeVersionId,
    currentUserId,
  });

  // Memoize active version lookup to avoid recalculating on every render
  const activeVersion = useMemo(() => {
    return (
      video?.versions?.find((v) => v.id === activeVersionId) ||
      video?.versions?.find((v) => v.isActive) ||
      video?.versions?.[0]
    );
  }, [video?.versions, activeVersionId]);
  const activeProviderId = activeVersion?.providerId;
  const speedOptions = getSpeedOptionsForProvider(activeProviderId);
  // Only the providers that play through our own <video> element can carry a <track>.
  // A YouTube version is an iframe we do not control, and it brings its own captions.
  const supportsSubtitles = activeProviderId === 'bunny' || activeProviderId === 'r2';
  const {
    subtitles,
    subtitleTrackKey,
    canManageSubtitles,
    activeSubtitleLanguage,
    selectSubtitleLanguage,
    uploadSubtitle,
    deleteSubtitle,
    isUploadingSubtitle,
  } = useSubtitles({
    videoId,
    versionId: activeVersionId,
    videoRef,
    supportsSubtitles,
  });
  const [liveDrawingControls, setLiveDrawingControls] = useState<HTMLDivElement | null>(null);
  const liveDrawingRef = useRef<LiveReviewCanvasHandle>(null);
  const getLiveAnnotation = useCallback(() => liveDrawingRef.current?.getAnnotation() ?? null, []);
  const refreshLiveComments = useCallback(() => {
    if (activeVersionId) void fetchVersionComments(activeVersionId, false);
  }, [activeVersionId, fetchVersionComments]);
  const liveReview = useLiveReview({
    videoId,
    versionId: activeVersionId,
    providerId: activeProviderId,
    guestName: normalizedGuestName,
    videoRef,
    onCommentsChanged: refreshLiveComments,
    onVersionSelect: setActiveVersionId,
    enabled: !!video && canInitializePlayer,
  });
  const handleVersionSelect = useCallback(
    (versionId: string) => {
      if (!liveReview.isJoined) setActiveVersionId(versionId);
    },
    [liveReview.isJoined, setActiveVersionId]
  );
  const saveLiveDrawing = useCallback(
    async (strokes: LiveStroke[], timestamp: number) => {
      const versionId = liveReview.snapshot?.versionId;
      if (!versionId || !liveReview.canDraw)
        throw new Error('Join the paused room to save a drawing.');
      const response = await fetch(versionCommentsPath(versionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp,
          annotationData: strokes.map(({ points, color, width }) => ({ points, color, width })),
          ...(isGuest ? { guestName: normalizedGuestName } : {}),
        }),
      });
      if (!response.ok) throw new Error('The drawing could not be saved. Please try again.');
      await fetchVersionComments(versionId, false);
    },
    [
      liveReview.snapshot?.versionId,
      liveReview.canDraw,
      isGuest,
      normalizedGuestName,
      fetchVersionComments,
    ]
  );
  const activeVersionDuration = activeVersion?.duration;
  const bunnyCdnHostname = useMemo(() => resolvePublicBunnyCdnHostname(), []);
  const embedUrl = useMemo(() => {
    if (!activeVersion) return '';
    if (activeVersion.providerId === 'youtube') {
      const base = `https://www.youtube.com/embed/${activeVersion.videoId}?enablejsapi=1&rel=0&modestbranding=1&controls=0&showinfo=0&iv_load_policy=3&disablekb=1`;
      if (typeof window === 'undefined') return base;
      const origin = window.location.origin;
      return `${base}&origin=${encodeURIComponent(origin)}`;
    }
    if (activeVersion.providerId === 'bunny') {
      if (!bunnyCdnHostname) return '';
      return `https://${bunnyCdnHostname}/${activeVersion.videoId}/playlist.m3u8`;
    }
    if (activeVersion.providerId === 'r2') {
      return resolveR2PlaybackUrl(activeVersion);
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
  }, [activeVersion, bunnyCdnHostname]);

  const {
    isReady,
    youtubeModuleRevision,
    bunnyPlaybackState,
    currentTime,
    setCurrentTime,
    videoDuration,
    durationVersionId,
    isPlaying,
    isMuted,
    isFrameMode,
    frameStepLabel,
    showScrubReadout,
    playbackSpeed,
    qualityOptions,
    selectedQualityLevel,
    isBunnyPortraitSource,
    bunnyPortraitFrameWidth,
    cursorIdle,
    isFullscreenMode,
    showComments,
    isMobileCommentsOpen,
    setShowComments,
    setIsMobileCommentsOpen,
    handleVideoMouseMove,
    handleVideoMouseLeave,
    handlePlayPause,
    handleSeekToTimestamp: handleLocalSeekToTimestamp,
    handleMuteToggle,
    handleFrameModeToggle,
    handleSkip,
    handleSpeedChange,
    handleQualityChange,
    handleTimelineMouseDown,
    handleTimelineMouseMove,
    toggleFullscreen,
  } = useVideoPlayer({
    activeVersion,
    activeVersionId,
    activeProviderId,
    embedUrl,
    canInitializePlayer,
    iframeRef,
    videoRef,
    bunnyViewportRef,
    timelineRef,
    progressRef,
    playheadRef,
    scrubReadoutRef,
    hlsRef,
    playerRef,
    formatTime,
    formatBunnyQualityLabel,
    speedOptions,
    scheduleWatchProgressSaveRef,
    setViewingAnnotation,
    playbackLocked: liveReview.playbackLocked,
  });

  const { isJoined: isLiveReviewJoined, selectComment: selectLiveComment } = liveReview;
  const handleSeekToTimestamp = useCallback(
    (
      timestamp: number,
      annotation?: string | null,
      options?: { pauseAfterSeek?: boolean; timestampEnd?: number | null; commentId?: string }
    ) => {
      if (isLiveReviewJoined && options?.commentId) {
        setViewingAnnotation(null);
        selectLiveComment(options.commentId, options.pauseAfterSeek);
        return;
      }
      handleLocalSeekToTimestamp(timestamp, annotation, options);
    },
    [handleLocalSeekToTimestamp, isLiveReviewJoined, selectLiveComment]
  );

  const { youtubeCaptionTracks, activeYoutubeCaptionLanguage, selectYoutubeCaptionLanguage } =
    useYoutubeCaptions({
      videoId,
      versionId: activeVersionId,
      playerRef,
      enabled: activeProviderId === 'youtube',
      isReady,
      moduleRevision: youtubeModuleRevision,
    });

  // One CC menu, two sources behind it. A YouTube version can only offer the captions the
  // video already carries, so nothing there is ours to manage.
  const isYoutubeVersion = activeProviderId === 'youtube';
  const subtitleTracks = isYoutubeVersion ? youtubeCaptionTracks : subtitles;
  const activeCaptionLanguage = isYoutubeVersion
    ? activeYoutubeCaptionLanguage
    : activeSubtitleLanguage;
  const selectCaptionLanguage = isYoutubeVersion
    ? selectYoutubeCaptionLanguage
    : selectSubtitleLanguage;

  const {
    savedProgress,
    showResumePrompt,
    scheduleWatchProgressSave,
    handleResumeFromSaved,
    handleDismissResume,
  } = useWatchProgress({
    videoId,
    activeVersionId,
    isAuthenticated: !!video?.isAuthenticated,
    pathname,
    playerRef,
    isReady,
    currentTime,
    videoDuration,
    playbackLocked: liveReview.isJoined,
  });

  useEffect(() => {
    scheduleWatchProgressSaveRef.current = scheduleWatchProgressSave;
  }, [scheduleWatchProgressSave]);

  const handleResumeFromSavedWithSync = useCallback(() => {
    const resumed = handleResumeFromSaved();
    if (typeof resumed === 'number') {
      setCurrentTime(resumed);
    }
  }, [handleResumeFromSaved, setCurrentTime]);

  const { activeDownloadTarget, isDownloadingVideo, startDownload } = useDownloadActions({
    activeVersion,
    video,
  });

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

  const selectedQualityLabel = useMemo(() => {
    if (selectedQualityLevel === -2) return 'Original';
    if (selectedQualityLevel === -1) return 'Auto';
    return qualityOptions.find((option) => option.level === selectedQualityLevel)?.label ?? 'Auto';
  }, [qualityOptions, selectedQualityLevel]);

  useEffect(() => {
    if (!activeVersionId || mode !== 'dashboard') return;
    void fetchApprovalRequests();
  }, [activeVersionId, fetchApprovalRequests, mode]);

  useEffect(() => {
    if (!showApprovalRequestDialog || mode !== 'dashboard') return;
    void fetchApprovalCandidates();
  }, [fetchApprovalCandidates, mode, showApprovalRequestDialog]);

  const {
    commentText,
    setCommentText,
    isSubmittingComment,
    isRecording,
    recordingTime,
    audioBlob,
    isUploadingAudio,
    imageFiles,
    commentRangeStart,
    commentRangeEnd,
    toggleCommentRangeSelection,
    clearCommentRangeSelection,
    isUploadingImage,
    imageInputRef,
    removeImageFile,
    handleAddComment,
    handleImageSelect,
    handlePaste,
    handleDrop,
    startRecording,
    stopRecording,
    cancelRecording,
    submitCommentWithMedia,
    replyingTo,
    setReplyingTo,
    replyText,
    setReplyText,
    isSubmittingReply,
    isReplyRecording,
    replyRecordingTime,
    replyAudioBlob,
    replyImageFiles,
    replyRangeStart,
    replyRangeEnd,
    toggleReplyRangeSelection,
    clearReplyRangeSelection,
    isUploadingReplyAudio,
    isUploadingReplyImage,
    replyImageInputRef,
    handleReplyComment,
    startReplyRecording,
    stopReplyRecording,
    cancelReplyRecording,
    submitReplyWithMedia,
    editingCommentId,
    editText,
    setEditText,
    editTagId,
    setEditTagId,
    editAnnotationData,
    setEditAnnotationData,
    isEditingAnnotation,
    setIsEditingAnnotation,
    editImageUrls,
    editImageFiles,
    editImageInputRef,
    startEditingComment,
    startEditingReply,
    cancelEditingComment,
    removeEditImageUrl,
    isSubmittingEdit,
    handleEditComment,
    handleDeleteComment,
    handleResolveComment,
    previewImage,
    setPreviewImage,
  } = useCommentActions({
    videoId,
    setVideo,
    activeVersionId,
    activeVersion,
    currentTime,
    isGuest,
    normalizedGuestName,
    currentUserName,
    canResolveComments,
    availableTags,
    selectedTagId,
    setSelectedTagId,
    annotationStrokes,
    setAnnotationStrokes,
    isAnnotating,
    setIsAnnotating,
    setViewingAnnotation,
    annotationCanvasRef,
    getAnnotationForComment: liveReview.isJoined ? getLiveAnnotation : undefined,
    editAnnotationCanvasRef,
    fetchVersionComments,
    fetchAssets,
  });

  const commentMarkers = useMemo<CommentMarker[]>(() => {
    return filteredComments.map((comment) => ({
      id: comment.id,
      timestamp: comment.timestamp,
      timestampEnd: comment.timestampEnd,
      color: comment.tag?.color || (comment.isResolved ? '#22C55E' : '#22D3EE'),
      annotationData: comment.annotationData,
      preview: `${comment.tag ? ` [${comment.tag.name}]` : ''} - ${comment.content?.substring(0, 30) || '(voice note)'}...`,
    }));
  }, [filteredComments]);

  const editAnnotationInitialStrokes = useMemo<AnnotationStroke[] | undefined>(() => {
    if (editAnnotationData) {
      try {
        const parsed = JSON.parse(editAnnotationData);
        return (validateAnnotationStrokes(parsed) as AnnotationStroke[] | null) ?? undefined;
      } catch {
        return undefined;
      }
    }

    const editingComment = comments.find((comment) => comment.id === editingCommentId);
    if (!editingComment?.annotationData) return undefined;
    try {
      const parsed = JSON.parse(editingComment.annotationData);
      return (validateAnnotationStrokes(parsed) as AnnotationStroke[] | null) ?? undefined;
    } catch {
      return undefined;
    }
  }, [editAnnotationData, comments, editingCommentId]);

  useVersionDurationSync({
    videoDuration,
    durationVersionId,
    activeVersionDuration,
    activeVersionId,
    propProjectId,
    videoId,
    setVideo,
  });

  const containerHeight = 'h-screen';
  const backHref =
    mode === 'dashboard'
      ? `/projects/${propProjectId}`
      : video?.projectId
        ? `/projects/${video.projectId}`
        : '/';
  const isBunnyVersion = activeVersion?.providerId === 'bunny';
  const showBunnyProcessingOverlay =
    isBunnyVersion && bunnyPlaybackState === 'processing' && !isReady;
  const isR2Version = activeVersion?.providerId === 'r2';
  const showBunnyErrorOverlay = (isBunnyVersion || isR2Version) && bunnyPlaybackState === 'error';

  const confirmGuestName = useCallback(() => {
    if (!guestName.trim()) return;
    localStorage.setItem('openframe_guest_name', guestName.trim());
    setGuestNameConfirmed(true);
  }, [guestName]);

  const handleDeleteCurrentVersionClick = useCallback(() => {
    setVersionToDelete(activeVersionId);
    setShowDeleteVersionDialog(true);
  }, [activeVersionId, setShowDeleteVersionDialog, setVersionToDelete]);

  const handleOpenCompare = useCallback(() => {
    setSelectedCompareVersions(new Set(activeVersionId ? [activeVersionId] : []));
    setShowCompareDialog(true);
  }, [activeVersionId]);

  const handleOpenApprovalRequestDialog = useCallback(() => {
    setApprovalError('');
    setShowApprovalRequestDialog(true);
  }, [setApprovalError]);

  const handleOpenApprovalsPanel = useCallback(() => {
    setApprovalError('');
    setShowApprovalsPanel(true);
    void fetchApprovalRequests();
  }, [fetchApprovalRequests, setApprovalError]);

  const toggleCompareVersion = useCallback((versionId: string) => {
    setSelectedCompareVersions((prev) => {
      const next = new Set(prev);
      if (next.has(versionId)) {
        next.delete(versionId);
      } else {
        next.add(versionId);
      }
      return next;
    });
  }, []);

  const handleCompareConfirm = useCallback(() => {
    const ids = Array.from(selectedCompareVersions).join(',');
    setShowCompareDialog(false);
    router.push(`/projects/${propProjectId}/videos/${videoId}/compare?versions=${ids}`);
  }, [propProjectId, router, selectedCompareVersions, videoId]);

  const handleStartEditAnnotation = useCallback(() => {
    if (playerRef.current?.pauseVideo) {
      playerRef.current.pauseVideo();
    }
    setIsEditingAnnotation(true);
    setIsAnnotating(false);
  }, [setIsEditingAnnotation]);

  const pauseVideoForAnnotation = useCallback(() => {
    if (playerRef.current?.pauseVideo) {
      playerRef.current.pauseVideo();
    }
  }, []);

  const headerActions: VideoPageHeaderActions = useMemo(
    () => ({
      onVersionSelect: handleVersionSelect,
      onDeleteCurrentVersionClick: handleDeleteCurrentVersionClick,
      onDownload: startDownload,
      onOpenCompare: handleOpenCompare,
      onCreateVersion: handleCreateVersion,
    }),
    [
      handleVersionSelect,
      handleDeleteCurrentVersionClick,
      startDownload,
      handleOpenCompare,
      handleCreateVersion,
    ]
  );

  const commentsActions: VideoPageCommentsActions = useMemo(
    () => ({
      onExportComments: exportComments,
      onResolveComment: handleResolveComment,
      onEditComment: handleEditComment,
      onDeleteComment: handleDeleteComment,
      onReplyComment: handleReplyComment,
      onSubmitReplyWithMedia: submitReplyWithMedia,
      onStartEditAnnotation: handleStartEditAnnotation,
    }),
    [
      exportComments,
      handleResolveComment,
      handleEditComment,
      handleDeleteComment,
      handleReplyComment,
      submitReplyWithMedia,
      handleStartEditAnnotation,
    ]
  );

  const composerActions: VideoPageComposerActions = useMemo(
    () => ({
      onSubmitCommentWithMedia: submitCommentWithMedia,
      onAddComment: handleAddComment,
      onPauseVideoForAnnotation: pauseVideoForAnnotation,
    }),
    [submitCommentWithMedia, handleAddComment, pauseVideoForAnnotation]
  );

  const compareActions: VideoPageCompareActions = useMemo(
    () => ({
      onToggleVersion: toggleCompareVersion,
      onCompare: handleCompareConfirm,
    }),
    [toggleCompareVersion, handleCompareConfirm]
  );

  if (loading) {
    return (
      <VideoPageLoading
        containerHeight={containerHeight}
        mode={mode}
        isFullscreenMode={isFullscreenMode}
        cursorIdle={cursorIdle}
        isPlaying={isPlaying}
        showComments={showComments}
      />
    );
  }

  if (error || !video || !activeVersion) {
    return (
      <VideoPageError
        containerHeight={containerHeight}
        error={error}
        mode={mode}
        projectId={propProjectId}
      />
    );
  }

  if (mode === 'watch' && isGuest && !guestNameConfirmed) {
    return (
      <GuestNameGate
        guestName={guestName}
        setGuestName={setGuestName}
        onConfirm={confirmGuestName}
      />
    );
  }

  return (
    <div className={cn(containerHeight, 'flex flex-col bg-background overflow-hidden')}>
      <div className="flex-1 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden min-h-0">
        <div
          className={cn(
            'flex-1 w-full min-w-0 flex flex-col min-h-0',
            isFullscreenMode && 'relative'
          )}
        >
          <VideoPageHeader
            mode={mode}
            backHref={backHref}
            title={video.title}
            projectName={video.project.name}
            isFullscreenMode={isFullscreenMode}
            cursorIdle={cursorIdle}
            isPlaying={isPlaying}
            versions={video.versions}
            activeVersion={activeVersion}
            activeVersionId={activeVersionId}
            onVersionSelect={headerActions.onVersionSelect}
            versionSelectionLocked={liveReview.isJoined}
            liveReviewControl={
              <LiveReviewEntryControl
                discovery={liveReview.discovery}
                provider={activeProviderId}
                isJoined={liveReview.isJoined}
                busy={isCreatingVersion || liveReview.connectionStatus === 'connecting'}
                error={liveReview.error}
                onStart={liveReview.start}
                onJoin={liveReview.join}
              />
            }
            onDeleteCurrentVersionClick={headerActions.onDeleteCurrentVersionClick}
            showDeleteVersionDialog={showDeleteVersionDialog}
            setShowDeleteVersionDialog={setShowDeleteVersionDialog}
            isDeletingVersion={isDeletingVersion}
            onDeleteVersion={handleDeleteVersion}
            videoCanDownload={!!video.canDownload}
            isDownloadingVideo={isDownloadingVideo}
            activeDownloadTarget={activeDownloadTarget}
            onDownload={headerActions.onDownload}
            projectId={projectId}
            videoId={videoId}
            directUploadsEnabled={directUploadsEnabled}
            showVersionDialog={showVersionDialog}
            setShowVersionDialog={setShowVersionDialog}
            newVersionMode={newVersionMode}
            setNewVersionMode={setNewVersionMode}
            newVersionUrl={newVersionUrl}
            handleNewVersionUrlChange={handleNewVersionUrlChange}
            newVersionUrlError={newVersionUrlError}
            newVersionSource={newVersionSource}
            newVersionFile={newVersionFile}
            setNewVersionFile={setNewVersionFile}
            newVersionLabel={newVersionLabel}
            setNewVersionLabel={setNewVersionLabel}
            newVersionUploadStatus={newVersionUploadStatus}
            newVersionUploadProgress={newVersionUploadProgress}
            isCreatingVersion={isCreatingVersion}
            onCreateVersion={headerActions.onCreateVersion}
            onOpenCompare={headerActions.onOpenCompare}
            canRequestApproval={canRequestApproval}
            canShareVideo={canShareVideo}
            hasPendingApprovalRequest={!!activePendingRequest}
            onOpenApprovalRequest={handleOpenApprovalRequestDialog}
            onOpenApprovalsPanel={handleOpenApprovalsPanel}
          />

          <LiveReviewBar
            discovery={liveReview.discovery}
            provider={activeProviderId}
            snapshot={liveReview.snapshot}
            participantId={liveReview.participantId}
            connection={liveReview.connectionStatus}
            isJoined={liveReview.isJoined}
            busy={isCreatingVersion || liveReview.connectionStatus === 'connecting'}
            autoplayBlocked={liveReview.autoplayBlocked}
            error={liveReview.error}
            onStart={liveReview.start}
            onJoin={liveReview.join}
            onLeave={liveReview.leave}
            onTransfer={liveReview.transfer}
            onEnd={liveReview.end}
            onRetryPlayback={liveReview.retryPlayback}
          />
          <PlayerCore
            liveOverlay={
              liveReview.isJoined && liveReview.snapshot ? (
                <LiveReviewCanvas
                  ref={liveDrawingRef}
                  controlsContainer={liveDrawingControls}
                  rejectedStroke={liveReview.rejectedStroke}
                  strokes={liveReview.snapshot.strokes}
                  previewStrokes={liveReview.snapshot.annotation?.strokes}
                  canvasEpoch={liveReview.snapshot.canvasEpoch}
                  participantId={liveReview.participantId}
                  canDraw={liveReview.canDraw}
                  isPaused={!liveReview.snapshot.playback.playing}
                  isManager={liveReview.isManager && liveReview.connectionStatus === 'connected'}
                  videoRef={videoRef}
                  onStroke={liveReview.sendStroke}
                  onUndo={liveReview.undo}
                  onClear={liveReview.clear}
                  onSave={saveLiveDrawing}
                />
              ) : null
            }
            activeVersionId={activeVersionId}
            activeProviderId={activeVersion?.providerId}
            embedUrl={embedUrl}
            videoRef={videoRef}
            iframeRef={iframeRef}
            bunnyViewportRef={bunnyViewportRef}
            timelineRef={timelineRef}
            progressRef={progressRef}
            playheadRef={playheadRef}
            scrubReadoutRef={scrubReadoutRef}
            videoContainerRef={videoContainerRef}
            showScrubReadout={showScrubReadout}
            isFullscreenMode={isFullscreenMode}
            cursorIdle={cursorIdle}
            isPlaying={isPlaying}
            handlePlayPause={handlePlayPause}
            handleVideoMouseMove={handleVideoMouseMove}
            handleVideoMouseLeave={handleVideoMouseLeave}
            isBunnyPortraitSource={isBunnyPortraitSource}
            bunnyPortraitFrameWidth={bunnyPortraitFrameWidth}
            showBunnyProcessingOverlay={showBunnyProcessingOverlay}
            showBunnyErrorOverlay={showBunnyErrorOverlay}
            showResumePrompt={showResumePrompt && !liveReview.isJoined}
            savedProgress={savedProgress}
            formatTime={formatTime}
            handleResumeFromSaved={handleResumeFromSavedWithSync}
            handleDismissResume={handleDismissResume}
            isAnnotating={isAnnotating && !liveReview.isJoined}
            annotationCanvasRef={annotationCanvasRef}
            setAnnotationStrokes={setAnnotationStrokes}
            setIsAnnotating={setIsAnnotating}
            setViewingAnnotation={setViewingAnnotation}
            viewingAnnotation={viewingAnnotation}
            isEditingAnnotation={isEditingAnnotation && !liveReview.isJoined}
            editAnnotationCanvasRef={editAnnotationCanvasRef}
            editAnnotationInitialStrokes={editAnnotationInitialStrokes}
            setEditAnnotationData={setEditAnnotationData}
            setIsEditingAnnotation={setIsEditingAnnotation}
            currentTime={currentTime}
            duration={duration}
            isFrameMode={isFrameMode}
            frameStepLabel={frameStepLabel}
            handleSkip={handleSkip}
            handleFrameModeToggle={handleFrameModeToggle}
            handleMuteToggle={handleMuteToggle}
            isMuted={isMuted}
            selectedQualityLabel={selectedQualityLabel}
            selectedQualityLevel={selectedQualityLevel}
            qualityOptions={qualityOptions}
            handleQualityChange={handleQualityChange}
            subtitles={subtitles}
            subtitleTracks={subtitleTracks}
            subtitleTrackKey={subtitleTrackKey}
            activeSubtitleLanguage={activeCaptionLanguage}
            onSelectSubtitleLanguage={selectCaptionLanguage}
            canManageSubtitles={canManageSubtitles}
            onUploadSubtitle={uploadSubtitle}
            onDeleteSubtitle={deleteSubtitle}
            isUploadingSubtitle={isUploadingSubtitle}
            playbackSpeed={playbackSpeed}
            speedOptions={speedOptions}
            handleSpeedChange={handleSpeedChange}
            toggleFullscreen={toggleFullscreen}
            showComments={showComments}
            setShowComments={setShowComments}
            setIsMobileCommentsOpen={setIsMobileCommentsOpen}
            handleTimelineMouseDown={handleTimelineMouseDown}
            handleTimelineMouseMove={handleTimelineMouseMove}
            handleSeekToTimestamp={handleSeekToTimestamp}
            commentMarkers={commentMarkers}
          />
        </div>

        <CommentsPane
          isMobileCommentsOpen={isMobileCommentsOpen}
          setIsMobileCommentsOpen={setIsMobileCommentsOpen}
          isFullscreenMode={isFullscreenMode}
          showComments={showComments}
          comments={comments}
          filteredComments={filteredComments}
          sortedComments={sortedComments}
          showResolved={showResolved}
          handleToggleShowResolved={handleToggleShowResolved}
          activeVersion={activeVersion}
          isGuest={isGuest}
          isExportingCsv={isExportingCsv}
          isExportingPdf={isExportingPdf}
          handleExportComments={commentsActions.onExportComments}
          canResolveComments={canResolveComments}
          handleResolveComment={commentsActions.onResolveComment}
          handleSeekToTimestamp={handleSeekToTimestamp}
          currentUserId={currentUserId}
          projectOwnerId={video.project.ownerId}
          editingCommentId={editingCommentId}
          startEditingComment={startEditingComment}
          startEditingReply={startEditingReply}
          cancelEditingComment={cancelEditingComment}
          editText={editText}
          setEditText={setEditText}
          editTagId={editTagId}
          setEditTagId={setEditTagId}
          editImageUrls={editImageUrls}
          editImageFiles={editImageFiles}
          editImageInputRef={editImageInputRef}
          removeEditImageUrl={removeEditImageUrl}
          onStartEditAnnotation={commentsActions.onStartEditAnnotation}
          isSubmittingEdit={isSubmittingEdit}
          availableTags={availableTags}
          handleEditComment={commentsActions.onEditComment}
          handleDeleteComment={commentsActions.onDeleteComment}
          playVoice={playVoice}
          downloadVoice={downloadVoice}
          downloadingVoiceIds={downloadingVoiceIds}
          canDownloadVoiceNotes={canDownloadAssets}
          playingVoiceId={playingVoiceId}
          voiceProgress={voiceProgress}
          voiceCurrentTime={voiceCurrentTime}
          voicePlaybackRate={voicePlaybackRate}
          toggleVoiceSpeed={toggleVoiceSpeed}
          formatTime={formatTime}
          setPreviewImage={setPreviewImage}
          replyingTo={replyingTo}
          setReplyingTo={setReplyingTo}
          replyText={replyText}
          setReplyText={setReplyText}
          replyRangeStart={replyRangeStart}
          replyRangeEnd={replyRangeEnd}
          toggleReplyRangeSelection={toggleReplyRangeSelection}
          clearReplyRangeSelection={clearReplyRangeSelection}
          handleReplyComment={commentsActions.onReplyComment}
          startReplyRecording={startReplyRecording}
          isReplyRecording={isReplyRecording}
          replyRecordingTime={replyRecordingTime}
          stopReplyRecording={stopReplyRecording}
          cancelReplyRecording={cancelReplyRecording}
          replyAudioBlob={replyAudioBlob}
          replyImageFiles={replyImageFiles}
          replyImageInputRef={replyImageInputRef}
          removeImageFile={removeImageFile}
          handleImageSelect={handleImageSelect}
          handlePaste={handlePaste}
          handleDrop={handleDrop}
          submitReplyWithMedia={commentsActions.onSubmitReplyWithMedia}
          isSubmittingReply={isSubmittingReply}
          isUploadingReplyAudio={isUploadingReplyAudio}
          isUploadingReplyImage={isUploadingReplyImage}
          assets={assets}
          onAssetMentionClick={handleAssetMentionClick}
          activePane={activeSidePane}
          setActivePane={setActiveSidePane}
          assetsPane={
            <AssetsPane
              videoId={videoId}
              assets={assets}
              isLoadingAssets={isLoadingAssets}
              isCreatingAsset={isCreatingAsset}
              deletingAssetIds={deletingAssetIds}
              activeDownloadAssetId={activeDownloadAssetId}
              canUploadAssets={canUploadAssets}
              canDownloadAssets={canDownloadAssets}
              getGuestUploadToken={getGuestUploadToken}
              createAsset={createAsset}
              deleteAsset={deleteAsset}
              downloadAsset={downloadAsset}
              hasMoreAssets={hasMoreAssets}
              isLoadingMoreAssets={isLoadingMoreAssets}
              loadMoreAssets={loadMoreAssets}
              highlightedAssetId={highlightedAssetId}
              onHighlightedAssetHandled={() => setHighlightedAssetId(null)}
              directUploadProvider={directUploadProvider}
            />
          }
          composer={
            <CommentComposer
              liveReviewActive={liveReview.isJoined}
              liveDrawingControls={
                liveReview.isJoined ? (
                  <div ref={setLiveDrawingControls} aria-label="Live drawing controls" />
                ) : null
              }
              isRecording={isRecording}
              recordingTime={recordingTime}
              stopRecording={stopRecording}
              cancelRecording={cancelRecording}
              audioBlob={audioBlob}
              imageFiles={imageFiles}
              imageInputRef={imageInputRef}
              removeImageFile={(index) => removeImageFile(index, 'comment')}
              commentText={commentText}
              setCommentText={setCommentText}
              commentRangeStart={commentRangeStart}
              commentRangeEnd={commentRangeEnd}
              toggleCommentRangeSelection={toggleCommentRangeSelection}
              clearCommentRangeSelection={clearCommentRangeSelection}
              playVoice={playVoice}
              playingVoiceId={playingVoiceId}
              voiceProgress={voiceProgress}
              voiceCurrentTime={voiceCurrentTime}
              formatTime={formatTime}
              toggleVoiceSpeed={toggleVoiceSpeed}
              voicePlaybackRate={voicePlaybackRate}
              submitCommentWithMedia={composerActions.onSubmitCommentWithMedia}
              isUploadingAudio={isUploadingAudio}
              isUploadingImage={isUploadingImage}
              annotationStrokes={annotationStrokes}
              isAnnotating={isAnnotating}
              setAnnotationStrokes={setAnnotationStrokes}
              setIsAnnotating={setIsAnnotating}
              handleAddComment={composerActions.onAddComment}
              isSubmittingComment={isSubmittingComment}
              startRecording={startRecording}
              handlePaste={handlePaste}
              handleImageSelect={handleImageSelect}
              availableTags={availableTags}
              selectedTagId={selectedTagId}
              setSelectedTagId={setSelectedTagId}
              canManageTags={!!video.canManageTags}
              projectId={projectId}
              pauseVideoForAnnotation={composerActions.onPauseVideoForAnnotation}
              assets={assets}
            />
          }
        />
      </div>

      <ImagePreviewDialog previewImage={previewImage} onClose={() => setPreviewImage(null)} />

      <CompareVersionsDialog
        open={showCompareDialog}
        onOpenChange={setShowCompareDialog}
        versions={video.versions}
        selectedCompareVersions={selectedCompareVersions}
        onToggleVersion={compareActions.onToggleVersion}
        onCompare={compareActions.onCompare}
      />

      {mode === 'dashboard' ? (
        <>
          <ApprovalRequestDialog
            open={showApprovalRequestDialog}
            onOpenChange={setShowApprovalRequestDialog}
            candidates={approvalCandidates}
            currentUserId={currentUserId}
            activePendingRequest={activePendingRequest}
            isLoadingCandidates={isLoadingApprovalCandidates}
            isSubmittingRequest={isSubmittingApprovalRequest}
            error={approvalError}
            onRefreshCandidates={fetchApprovalCandidates}
            onCreateRequest={createApprovalRequest}
          />
          <ApprovalRequestsPanel
            open={showApprovalsPanel}
            onOpenChange={setShowApprovalsPanel}
            requests={approvalRequests}
            currentUserId={currentUserId}
            canRequestApproval={canRequestApproval}
            onOpenApprovalRequest={handleOpenApprovalRequestDialog}
            isLoadingRequests={isLoadingApprovals}
            isSubmittingDecision={isSubmittingApprovalDecision}
            isCancelingRequest={isCancelingApprovalRequest}
            error={approvalError}
            onRefresh={fetchApprovalRequests}
            onSubmitDecision={submitApprovalDecision}
            onCancelRequest={cancelApprovalRequest}
          />
        </>
      ) : null}
    </div>
  );
}
