'use client';

import { memo, type RefObject } from 'react';
import Link from 'next/link';
import {
  Image as ImageIcon,
  Loader2,
  Mic,
  Pause,
  Pencil,
  Play,
  Send,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AnnotationStroke } from '@/components/annotation-canvas';
import { MentionTextarea } from '@/components/video-page/mention-textarea';
import type { CommentTag, VideoAsset } from '@/components/video-page/types';

interface CommentComposerProps {
  isRecording: boolean;
  recordingTime: number;
  stopRecording: () => void;
  cancelRecording: () => void;
  audioBlob: Blob | null;
  imageBlob: File | null;
  imageInputRef: RefObject<HTMLInputElement | null>;
  setImageBlob: (blob: File | null) => void;
  commentText: string;
  setCommentText: (value: string) => void;
  playVoice: (commentId: string, voiceUrl: string, knownDuration?: number) => void;
  playingVoiceId: string | null;
  voiceProgress: number;
  voiceCurrentTime: number;
  formatTime: (value: number) => string;
  toggleVoiceSpeed: () => void;
  voicePlaybackRate: number;
  submitCommentWithMedia: () => void;
  isUploadingAudio: boolean;
  isUploadingImage: boolean;
  annotationStrokes: AnnotationStroke[] | null;
  isAnnotating: boolean;
  setAnnotationStrokes: (strokes: AnnotationStroke[] | null) => void;
  setIsAnnotating: (value: boolean) => void;
  handleAddComment: () => void;
  isSubmittingComment: boolean;
  startRecording: () => void;
  handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>, isReply?: boolean) => void;
  handleImageSelect: (e: React.ChangeEvent<HTMLInputElement>, isReply?: boolean) => void;
  availableTags: CommentTag[];
  selectedTagId: string | null;
  setSelectedTagId: (value: string | null) => void;
  canManageTags: boolean;
  projectId?: string;
  pauseVideoForAnnotation: () => void;
  assets: VideoAsset[];
}

export const CommentComposer = memo(function CommentComposer({
  isRecording,
  recordingTime,
  stopRecording,
  cancelRecording,
  audioBlob,
  imageBlob,
  imageInputRef,
  setImageBlob,
  commentText,
  setCommentText,
  playVoice,
  playingVoiceId,
  voiceProgress,
  voiceCurrentTime,
  formatTime,
  toggleVoiceSpeed,
  voicePlaybackRate,
  submitCommentWithMedia,
  isUploadingAudio,
  isUploadingImage,
  annotationStrokes,
  isAnnotating,
  setAnnotationStrokes,
  setIsAnnotating,
  handleAddComment,
  isSubmittingComment,
  startRecording,
  handlePaste,
  handleImageSelect,
  availableTags,
  selectedTagId,
  setSelectedTagId,
  canManageTags,
  projectId,
  pauseVideoForAnnotation,
  assets,
}: CommentComposerProps) {
  return (
    <div className="shrink-0 p-4 border-t bg-background">
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
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={cancelRecording}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {imageBlob && (
            <div className="relative group rounded-md overflow-hidden bg-muted flex items-center justify-center max-h-40 mb-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={URL.createObjectURL(imageBlob)}
                alt="Preview"
                className="max-h-40 w-auto object-contain"
              />
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <Button
                  size="icon"
                  variant="destructive"
                  onClick={() => {
                    setImageBlob(null);
                    if (imageInputRef.current) imageInputRef.current.value = '';
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          <MentionTextarea
            placeholder="Add a note to your voice comment (optional)..."
            value={commentText}
            onChange={setCommentText}
            assets={assets}
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
                onClick={() => {
                  setAnnotationStrokes(null);
                  setIsAnnotating(false);
                }}
              >
                Remove
              </button>
            </div>
          )}
          {imageBlob && (
            <div className="relative group rounded-md overflow-hidden bg-muted flex items-center justify-center max-h-40 mb-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={URL.createObjectURL(imageBlob)}
                alt="Preview"
                className="max-h-40 w-auto object-contain"
              />
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <Button
                  size="icon"
                  variant="destructive"
                  onClick={() => {
                    setImageBlob(null);
                    if (imageInputRef.current) imageInputRef.current.value = '';
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
          <div className="flex gap-2 items-stretch">
            <div className="flex-1 min-w-0">
              <MentionTextarea
                placeholder="Add a comment..."
                value={commentText}
                onChange={setCommentText}
                assets={assets}
                rows={6}
                className="resize-none text-sm min-h-[180px] w-full"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    handleAddComment();
                  }
                }}
                onPaste={(e) => handlePaste(e, false)}
              />
            </div>
            <div className="flex flex-col gap-1 self-end">
              <Button
                size="icon"
                onClick={handleAddComment}
                disabled={
                  (!commentText.trim() && !imageBlob && !annotationStrokes) ||
                  isSubmittingComment ||
                  isUploadingImage
                }
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
                  pauseVideoForAnnotation();
                  setIsAnnotating(true);
                }}
                title={
                  annotationStrokes
                    ? 'Annotation added ✓ (click to redraw)'
                    : 'Draw annotation on video'
                }
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
                      style={
                        selectedTagId
                          ? {
                              backgroundColor: availableTags.find((t) => t.id === selectedTagId)
                                ?.color,
                            }
                          : undefined
                      }
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
                    {canManageTags && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild>
                          <Link
                            href={`/projects/${projectId}/settings#comment-tags`}
                            className="gap-2 text-muted-foreground"
                          >
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
          <p className="text-xs text-muted-foreground mt-2">Cmd+Enter to submit</p>
        </>
      )}
    </div>
  );
});
