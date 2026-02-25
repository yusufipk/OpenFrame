'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import Hls from 'hls.js';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { type AnnotationStroke, type AnnotationCanvasHandle } from '@/components/annotation-canvas';
import { PlayerCore } from '@/components/video-page/player-core';
import { VideoPageHeader } from '@/components/video-page/video-page-header';
import { ImagePreviewDialog } from '@/components/video-page/image-preview-dialog';
import { CompareVersionsDialog } from '@/components/video-page/compare-versions-dialog';
import { VideoPageLoading } from '@/components/video-page/video-page-loading';
import { VideoPageError } from '@/components/video-page/video-page-error';
import { GuestNameGate } from '@/components/video-page/guest-name-gate';
import { useCommentMedia } from '@/components/video-page/hooks/use-comment-media';
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

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const BUNNY_PULL_ZONE_HOSTNAME = 'vz-965f4f4a-fc1.b-cdn.net';

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
  const scheduleWatchProgressSaveRef = useRef<(input: {
    progress: number;
    duration?: number;
    immediate?: boolean;
    force?: boolean;
  }) => void>(() => {});

  const {
    playingVoiceId,
    voiceProgress,
    voiceCurrentTime,
    voicePlaybackRate,
    playVoice,
    toggleVoiceSpeed,
  } = useCommentMedia();
  const [showResolved, setShowResolved] = useState(false);

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
    setVideo,
    activeVersionId,
    setActiveVersionId,
  });

  // Cursor idle detection: hide overlay when cursor idle for 3s while playing
  // Memoize version selection handler to prevent recreating on each render
  const handleVersionSelect = useCallback((versionId: string) => {
    setActiveVersionId(versionId);
  }, [setActiveVersionId]);

  // Memoize toggle show resolved handler
  const handleToggleShowResolved = useCallback(() => {
    setShowResolved(prev => !prev);
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
    return video?.versions?.find((v) => v.id === activeVersionId) ||
      video?.versions?.find((v) => v.isActive) ||
      video?.versions?.[0];
  }, [video?.versions, activeVersionId]);
  const activeProviderId = activeVersion?.providerId;
  const activeVersionDuration = activeVersion?.duration;
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

  const {
    isReady,
    bunnyPlaybackState,
    currentTime,
    setCurrentTime,
    videoDuration,
    isPlaying,
    isMuted,
    isDragging,
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
    handleSeekToTimestamp,
    handleMuteToggle,
    handleSkip,
    handleSpeedChange,
    handleQualityChange,
    handleTimelineMouseDown,
    handleTimelineMouseMove,
    handleTimelineMouseUp,
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
    hlsRef,
    playerRef,
    formatBunnyQualityLabel,
    speedOptions: SPEED_OPTIONS,
    scheduleWatchProgressSaveRef,
    setViewingAnnotation,
  });

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
    imageBlob,
    setImageBlob,
    isUploadingImage,
    imageInputRef,
    handleAddComment,
    handleImageSelect,
    handlePaste,
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
    replyImageBlob,
    setReplyImageBlob,
    isUploadingReplyAudio,
    isUploadingReplyImage,
    replyImageInputRef,
    handleReplyComment,
    startReplyRecording,
    stopReplyRecording,
    cancelReplyRecording,
    submitReplyWithMedia,
    editingCommentId,
    setEditingCommentId,
    editText,
    setEditText,
    editTagId,
    setEditTagId,
    editAnnotationData,
    setEditAnnotationData,
    isEditingAnnotation,
    setIsEditingAnnotation,
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
    comments,
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
    editAnnotationCanvasRef,
    fetchVersionComments,
  });

  const commentMarkers = useMemo<CommentMarker[]>(() => {
    return filteredComments.map((comment) => ({
      id: comment.id,
      timestamp: comment.timestamp,
      color: comment.tag?.color || (comment.isResolved ? '#22C55E' : '#22D3EE'),
      annotationData: comment.annotationData,
      preview: `${comment.tag ? ` [${comment.tag.name}]` : ''} - ${comment.content?.substring(0, 30) || '(voice note)'}...`,
    }));
  }, [filteredComments]);

  const editAnnotationInitialStrokes = useMemo<AnnotationStroke[] | undefined>(() => {
    if (editAnnotationData) {
      try {
        return JSON.parse(editAnnotationData) as AnnotationStroke[];
      } catch {
        return undefined;
      }
    }

    const editingComment = comments.find((comment) => comment.id === editingCommentId);
    if (!editingComment?.annotationData) return undefined;
    try {
      return JSON.parse(editingComment.annotationData) as AnnotationStroke[];
    } catch {
      return undefined;
    }
  }, [editAnnotationData, comments, editingCommentId]);

  useVersionDurationSync({
    videoDuration,
    activeVersionDuration,
    activeVersionId,
    propProjectId,
    videoId,
    setVideo,
  });

  const containerHeight = 'h-screen';
  const backHref = mode === 'dashboard'
    ? `/projects/${propProjectId}`
    : (video?.projectId ? `/projects/${video.projectId}` : '/');
  const isBunnyVersion = activeVersion?.providerId === 'bunny';
  const showBunnyProcessingOverlay = isBunnyVersion && bunnyPlaybackState === 'processing';
  const showBunnyErrorOverlay = isBunnyVersion && bunnyPlaybackState === 'error';

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

  const headerActions: VideoPageHeaderActions = useMemo(() => ({
    onVersionSelect: handleVersionSelect,
    onDeleteCurrentVersionClick: handleDeleteCurrentVersionClick,
    onDownload: startDownload,
    onOpenCompare: handleOpenCompare,
    onCreateVersion: handleCreateVersion,
  }), [handleVersionSelect, handleDeleteCurrentVersionClick, startDownload, handleOpenCompare, handleCreateVersion]);

  const commentsActions: VideoPageCommentsActions = useMemo(() => ({
    onExportComments: exportComments,
    onResolveComment: handleResolveComment,
    onEditComment: handleEditComment,
    onDeleteComment: handleDeleteComment,
    onReplyComment: handleReplyComment,
    onSubmitReplyWithMedia: submitReplyWithMedia,
    onStartEditAnnotation: handleStartEditAnnotation,
  }), [exportComments, handleResolveComment, handleEditComment, handleDeleteComment, handleReplyComment, submitReplyWithMedia, handleStartEditAnnotation]);

  const composerActions: VideoPageComposerActions = useMemo(() => ({
    onSubmitCommentWithMedia: submitCommentWithMedia,
    onAddComment: handleAddComment,
    onPauseVideoForAnnotation: pauseVideoForAnnotation,
  }), [submitCommentWithMedia, handleAddComment, pauseVideoForAnnotation]);

  const compareActions: VideoPageCompareActions = useMemo(() => ({
    onToggleVersion: toggleCompareVersion,
    onCompare: handleCompareConfirm,
  }), [toggleCompareVersion, handleCompareConfirm]);

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
    <div
      className={cn(containerHeight, 'flex flex-col bg-background overflow-hidden')}
      onMouseUp={handleTimelineMouseUp}
      onMouseLeave={() => isDragging && handleTimelineMouseUp()}
    >
      <div className="flex-1 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden min-h-0">
        <div className={cn("flex-1 w-full flex flex-col min-h-0", isFullscreenMode && "relative")}>
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
            hasPendingApprovalRequest={!!activePendingRequest}
            onOpenApprovalRequest={handleOpenApprovalRequestDialog}
            onOpenApprovalsPanel={handleOpenApprovalsPanel}
          />

          <PlayerCore
            activeVersionId={activeVersionId}
            activeProviderId={activeVersion?.providerId}
            embedUrl={embedUrl}
            videoRef={videoRef}
            iframeRef={iframeRef}
            bunnyViewportRef={bunnyViewportRef}
            timelineRef={timelineRef}
            videoContainerRef={videoContainerRef}
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
            showResumePrompt={showResumePrompt}
            savedProgress={savedProgress}
            formatTime={formatTime}
            handleResumeFromSaved={handleResumeFromSavedWithSync}
            handleDismissResume={handleDismissResume}
            isAnnotating={isAnnotating}
            annotationCanvasRef={annotationCanvasRef}
            setAnnotationStrokes={setAnnotationStrokes}
            setIsAnnotating={setIsAnnotating}
            setViewingAnnotation={setViewingAnnotation}
            viewingAnnotation={viewingAnnotation}
            isEditingAnnotation={isEditingAnnotation}
            editAnnotationCanvasRef={editAnnotationCanvasRef}
            editAnnotationInitialStrokes={editAnnotationInitialStrokes}
            setEditAnnotationData={setEditAnnotationData}
            setIsEditingAnnotation={setIsEditingAnnotation}
            currentTime={currentTime}
            duration={duration}
            handleSkip={handleSkip}
            handleMuteToggle={handleMuteToggle}
            isMuted={isMuted}
            selectedQualityLabel={selectedQualityLabel}
            selectedQualityLevel={selectedQualityLevel}
            qualityOptions={qualityOptions}
            handleQualityChange={handleQualityChange}
            playbackSpeed={playbackSpeed}
            speedOptions={SPEED_OPTIONS}
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
          setEditingCommentId={setEditingCommentId}
          editText={editText}
          setEditText={setEditText}
          editTagId={editTagId}
          setEditTagId={setEditTagId}
          setEditAnnotationData={setEditAnnotationData}
          setIsEditingAnnotation={setIsEditingAnnotation}
          onStartEditAnnotation={commentsActions.onStartEditAnnotation}
          isSubmittingEdit={isSubmittingEdit}
          availableTags={availableTags}
          handleEditComment={commentsActions.onEditComment}
          handleDeleteComment={commentsActions.onDeleteComment}
          playVoice={playVoice}
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
          handleReplyComment={commentsActions.onReplyComment}
          startReplyRecording={startReplyRecording}
          isReplyRecording={isReplyRecording}
          replyRecordingTime={replyRecordingTime}
          stopReplyRecording={stopReplyRecording}
          cancelReplyRecording={cancelReplyRecording}
          replyAudioBlob={replyAudioBlob}
          replyImageBlob={replyImageBlob}
          setReplyImageBlob={setReplyImageBlob}
          replyImageInputRef={replyImageInputRef}
          handleImageSelect={handleImageSelect}
          handlePaste={handlePaste}
          submitReplyWithMedia={commentsActions.onSubmitReplyWithMedia}
          isSubmittingReply={isSubmittingReply}
          isUploadingReplyAudio={isUploadingReplyAudio}
          isUploadingReplyImage={isUploadingReplyImage}
          composer={(
            <CommentComposer
              isRecording={isRecording}
              recordingTime={recordingTime}
              stopRecording={stopRecording}
              cancelRecording={cancelRecording}
              audioBlob={audioBlob}
              imageBlob={imageBlob}
              imageInputRef={imageInputRef}
              setImageBlob={setImageBlob}
              commentText={commentText}
              setCommentText={setCommentText}
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
            />
          )}
        />

      </div>

      <ImagePreviewDialog
        previewImage={previewImage}
        onClose={() => setPreviewImage(null)}
      />

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
    </div >
  );
}
