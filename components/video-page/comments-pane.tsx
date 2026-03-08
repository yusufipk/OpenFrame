'use client';

import { memo, useState, type ReactNode, type RefObject } from 'react';
import { ArrowUpRight, CheckCircle2, ChevronDown, Circle, Clock, Download, FileText, FolderOpen, Image as ImageIcon, Loader2, MessageSquare, Mic, MoreVertical, Pause, Pencil, Play, Reply, Tag, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { MentionTextarea } from '@/components/video-page/mention-textarea';
import { CommentRichText } from '@/components/video-page/comment-rich-text';
import type { Comment, CommentTag, Version, VideoAsset } from '@/components/video-page/types';

interface CommentsPaneProps {
  isMobileCommentsOpen: boolean;
  setIsMobileCommentsOpen: (open: boolean) => void;
  isFullscreenMode: boolean;
  showComments: boolean;
  comments: Comment[];
  filteredComments: Comment[];
  sortedComments: Comment[];
  showResolved: boolean;
  handleToggleShowResolved: () => void;
  activeVersion: Version | undefined;
  isGuest: boolean;
  isExportingCsv: boolean;
  isExportingPdf: boolean;
  handleExportComments: (format: 'csv' | 'pdf') => void;
  canResolveComments: boolean;
  handleResolveComment: (commentId: string, currentlyResolved: boolean) => void;
  handleSeekToTimestamp: (
    timestamp: number,
    annotation?: string | null,
    options?: { pauseAfterSeek?: boolean }
  ) => void;
  currentUserId: string | null;
  projectOwnerId: string;
  editingCommentId: string | null;
  setEditingCommentId: (id: string | null) => void;
  editText: string;
  setEditText: (value: string) => void;
  editTagId: string | null;
  setEditTagId: (value: string | null) => void;
  setEditAnnotationData: (value: string | null | undefined) => void;
  setIsEditingAnnotation: (value: boolean) => void;
  onStartEditAnnotation: () => void;
  isSubmittingEdit: boolean;
  availableTags: CommentTag[];
  handleEditComment: (commentId: string) => void;
  handleDeleteComment: (commentId: string) => void;
  playVoice: (commentId: string, voiceUrl: string, knownDuration?: number) => void;
  playingVoiceId: string | null;
  voiceProgress: number;
  voiceCurrentTime: number;
  voicePlaybackRate: number;
  toggleVoiceSpeed: () => void;
  formatTime: (seconds: number) => string;
  setPreviewImage: (url: string | null) => void;
  replyingTo: string | null;
  setReplyingTo: (id: string | null) => void;
  replyText: string;
  setReplyText: (value: string) => void;
  handleReplyComment: (parentId: string, voiceData?: { url: string; duration: number }, imageData?: { url: string }) => void;
  startReplyRecording: () => void;
  isReplyRecording: boolean;
  replyRecordingTime: number;
  stopReplyRecording: () => void;
  cancelReplyRecording: () => void;
  replyAudioBlob: Blob | null;
  replyImageBlob: File | null;
  setReplyImageBlob: (file: File | null) => void;
  replyImageInputRef: RefObject<HTMLInputElement | null>;
  handleImageSelect: (e: React.ChangeEvent<HTMLInputElement>, isReply?: boolean) => void;
  handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>, isReply?: boolean) => void;
  handleDrop: (e: React.DragEvent<HTMLDivElement>, isReply?: boolean) => void;
  submitReplyWithMedia: (parentId: string) => void;
  isSubmittingReply: boolean;
  isUploadingReplyAudio: boolean;
  isUploadingReplyImage: boolean;
  composer: ReactNode;
  assets: VideoAsset[];
  onAssetMentionClick: (assetId: string) => void;
  activePane: 'comments' | 'assets';
  setActivePane: (pane: 'comments' | 'assets') => void;
  assetsPane: ReactNode;
}

export const CommentsPane = memo(function CommentsPane({
  isMobileCommentsOpen,
  setIsMobileCommentsOpen,
  isFullscreenMode,
  showComments,
  comments,
  filteredComments,
  sortedComments,
  showResolved,
  handleToggleShowResolved,
  activeVersion,
  isGuest,
  isExportingCsv,
  isExportingPdf,
  handleExportComments,
  canResolveComments,
  handleResolveComment,
  handleSeekToTimestamp,
  currentUserId,
  projectOwnerId,
  editingCommentId,
  setEditingCommentId,
  editText,
  setEditText,
  editTagId,
  setEditTagId,
  setEditAnnotationData,
  setIsEditingAnnotation,
  onStartEditAnnotation,
  isSubmittingEdit,
  availableTags,
  handleEditComment,
  handleDeleteComment,
  playVoice,
  playingVoiceId,
  voiceProgress,
  voiceCurrentTime,
  voicePlaybackRate,
  toggleVoiceSpeed,
  formatTime,
  setPreviewImage,
  replyingTo,
  setReplyingTo,
  replyText,
  setReplyText,
  handleReplyComment,
  startReplyRecording,
  isReplyRecording,
  replyRecordingTime,
  stopReplyRecording,
  cancelReplyRecording,
  replyAudioBlob,
  replyImageBlob,
  setReplyImageBlob,
  replyImageInputRef,
  handleImageSelect,
  handlePaste,
  handleDrop,
  submitReplyWithMedia,
  isSubmittingReply,
  isUploadingReplyAudio,
  isUploadingReplyImage,
  composer,
  assets,
  onAssetMentionClick,
  activePane,
  setActivePane,
  assetsPane,
}: CommentsPaneProps) {
  const [isPaneDraggingOver, setIsPaneDraggingOver] = useState(false);

  return (
    <>
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden transition-opacity duration-300',
          isMobileCommentsOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
        onClick={() => setIsMobileCommentsOpen(false)}
      />

      <div
        className={cn(
          'bg-card flex flex-col overflow-hidden z-50 relative',
          'fixed inset-y-0 right-0 w-[85%] sm:w-[400px] shadow-2xl transition-transform duration-300 transform',
          isMobileCommentsOpen ? 'translate-x-0' : 'translate-x-full',
          'lg:static lg:w-80 lg:shrink-0 lg:border-l lg:transition-none lg:translate-x-0 lg:shadow-none lg:z-auto',
          isFullscreenMode && !showComments ? 'hidden' : ''
        )}
        onDragOver={(e) => { if (activePane !== 'comments') return; e.preventDefault(); setIsPaneDraggingOver(true); }}
        onDragEnter={(e) => { if (activePane !== 'comments') return; e.preventDefault(); setIsPaneDraggingOver(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsPaneDraggingOver(false); }}
        onDrop={(e) => { setIsPaneDraggingOver(false); if (activePane !== 'comments') return; handleDrop(e, replyingTo !== null); }}
      >
        {isPaneDraggingOver && (
          <div className="absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-primary bg-primary/10 pointer-events-none">
            <p className="text-sm font-medium text-primary">Drop image to attach</p>
          </div>
        )}
        <div className="shrink-0 p-4 border-b lg:cursor-default space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
              <Button
                variant={activePane === 'comments' ? 'default' : 'ghost'}
                size="sm"
                className="h-8 shrink-0"
                onClick={() => setActivePane('comments')}
              >
                <MessageSquare className="h-4 w-4 mr-1" />
                Comments
                <Badge variant="secondary" className="ml-2">{comments.length}</Badge>
              </Button>
              <Button
                variant={activePane === 'assets' ? 'default' : 'ghost'}
                size="sm"
                className="h-8 shrink-0"
                onClick={() => setActivePane('assets')}
              >
                <FolderOpen className="h-4 w-4 mr-1" />
                Assets
                <Badge variant="secondary" className="ml-2">{assets.length}</Badge>
              </Button>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 lg:hidden shrink-0" onClick={() => setIsMobileCommentsOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {activePane === 'comments' && (
            <div className="flex w-full items-center justify-end gap-2 flex-wrap">
              <Button
                variant={showResolved ? 'default' : 'outline'}
                size="sm"
                className="h-8"
                onClick={(e) => { e.stopPropagation(); handleToggleShowResolved(); }}
              >
                Resolved
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2"
                    disabled={!activeVersion || isExportingCsv || isExportingPdf}
                    aria-label="Download comments"
                    title="Download comments"
                  >
                    {isExportingCsv || isExportingPdf ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    <ChevronDown className="h-4 w-4 ml-0.5" />
                  </Button>
                </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      disabled={!activeVersion || isGuest || isExportingCsv || isExportingPdf}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleExportComments('csv');
                    }}
                    title={isGuest ? 'CSV export requires an authenticated account' : 'Download comments as CSV'}
                    >
                      <Download className="h-4 w-4 mr-2" />
                      Download CSV
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!activeVersion || isExportingCsv || isExportingPdf}
                      onClick={(e) => {
                        e.stopPropagation();
                      handleExportComments('pdf');
                    }}
                    title="Download comments as PDF"
                    >
                      <FileText className="h-4 w-4 mr-2" />
                      Download PDF
                    </DropdownMenuItem>
                  </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className={cn(activePane === 'assets' ? 'block p-4' : 'hidden')} aria-hidden={activePane !== 'assets'}>
            {assetsPane}
          </div>

          <div className={cn(activePane === 'comments' ? 'block p-4 space-y-3' : 'hidden')} aria-hidden={activePane !== 'comments'}>
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
                const canDeleteComment = comment.canDelete ?? (comment.author?.id === currentUserId || projectOwnerId === currentUserId);
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
                        onClick={() => handleSeekToTimestamp(comment.timestamp, comment.annotationData, { pauseAfterSeek: true })}
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
                      <MentionTextarea
                        value={editText}
                        onChange={setEditText}
                        assets={assets}
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
                          variant={comment.annotationData ? 'default' : 'outline'}
                          className={`h-7 w-7 ${comment.annotationData ? 'bg-violet-500 hover:bg-violet-600' : ''}`}
                          onClick={() => {
                            onStartEditAnnotation();
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
                      {comment.content && (
                        <p className="text-sm mb-2">
                          <CommentRichText text={comment.content} onAssetMentionClick={onAssetMentionClick} assets={assets} />
                        </p>
                      )}
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
                        const canDeleteReply = reply.canDelete ?? (reply.author?.id === currentUserId || projectOwnerId === currentUserId);
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
                                <MentionTextarea
                                  value={editText}
                                  onChange={setEditText}
                                  assets={assets}
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
                                {reply.content && (
                                  <p className="text-sm">
                                    <CommentRichText text={reply.content} onAssetMentionClick={onAssetMentionClick} assets={assets} />
                                  </p>
                                )}
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

                          <MentionTextarea
                            value={replyText}
                            onChange={setReplyText}
                            assets={assets}
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
                            <MentionTextarea
                              value={replyText}
                              onChange={setReplyText}
                              assets={assets}
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
        </div>

        {activePane === 'comments' ? composer : null}
      </div>
    </>
  );
});
