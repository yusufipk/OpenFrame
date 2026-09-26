'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Clock, Loader2, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import type { AnnotationStroke } from '@/components/annotation-canvas';
import { validateAnnotationStrokes } from '@/lib/validation';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AttachmentCommentTarget } from '@/lib/attachment-comment-target';

interface AttachmentComment {
  id: string;
  content: string;
  annotationData: string | null;
  timestamp: number | null;
  createdAt: string;
  author: { id: string; name: string | null; image: string | null } | null;
  guestName: string | null;
  canDelete: boolean;
}

interface ListResponse {
  data?: {
    comments: AttachmentComment[];
    total: number;
    hasMore: boolean;
    canComment: boolean;
  };
  error?: string;
}

interface AttachmentCommentsPanelProps {
  videoId: string;
  target: AttachmentCommentTarget;
  guestName?: string | null;
  onCommentsChanged: () => void;
  timedMedia?: boolean;
  playbackTime?: number | null;
  getPlaybackTime?: () => number | null;
  onPausePlayback?: () => void;
  onSeekTimestamp?: (seconds: number) => void;
  canAnnotate?: boolean;
  annotationReady?: boolean;
  isAnnotating?: boolean;
  onStartAnnotation?: (timestamp?: number) => void;
  getAnnotationStrokes?: () => AnnotationStroke[];
  onAnnotationSaved?: () => void;
  onViewAnnotation?: (id: string, strokes: AnnotationStroke[], timestamp?: number | null) => void;
  viewingAnnotationId?: string;
  onCommentDeleted?: (id: string) => void;
  onSubmittingChange?: (value: boolean) => void;
}

const PAGE_SIZE = 30;

function formatTime(seconds: number) {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export function AttachmentCommentsPanel({
  videoId,
  target,
  guestName,
  onCommentsChanged,
  timedMedia = false,
  playbackTime = null,
  getPlaybackTime,
  onPausePlayback,
  onSeekTimestamp,
  canAnnotate = false,
  annotationReady = true,
  isAnnotating = false,
  onStartAnnotation,
  getAnnotationStrokes,
  onAnnotationSaved,
  onViewAnnotation,
  viewingAnnotationId,
  onCommentDeleted,
  onSubmittingChange,
}: AttachmentCommentsPanelProps) {
  const [comments, setComments] = useState<AttachmentComment[]>([]);
  const [canComment, setCanComment] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [includeTime, setIncludeTime] = useState(true);
  const [draftTime, setDraftTime] = useState<number | undefined>(undefined);
  const [draftTimeFromDrawing, setDraftTimeFromDrawing] = useState(false);
  const pinnedTime = !isAnnotating && !draft.trim() && draftTimeFromDrawing ? undefined : draftTime;
  const captureTime = (fromDrawing = false) => {
    const time = getPlaybackTime?.() ?? null;
    if (time !== null) {
      setDraftTime(time);
      setDraftTimeFromDrawing(fromDrawing);
      onPausePlayback?.();
    }
    return time;
  };
  const requestRef = useRef<AbortController | null>(null);
  const mutationRef = useRef(false);
  const imageUrl = target.type === 'comment-image' ? target.url : null;

  const query = useCallback(
    (offset: number) => {
      const params = new URLSearchParams({
        targetType: target.type,
        targetId: target.id,
        offset: String(offset),
        limit: String(PAGE_SIZE),
      });
      if (imageUrl) params.set('imageUrl', imageUrl);
      return `/api/videos/${videoId}/attachment-comments?${params}`;
    },
    [target.type, target.id, imageUrl, videoId]
  );

  const load = useCallback(
    async (offset = 0) => {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      if (offset === 0) {
        setLoading(true);
        setCanComment(false);
      } else setLoadingMore(true);
      setError(null);
      try {
        const response = await fetch(query(offset), { signal: controller.signal });
        const payload = (await response.json()) as ListResponse;
        if (!response.ok || !payload.data)
          throw new Error(payload.error || 'Comments could not load.');
        if (controller.signal.aborted) return;
        setComments((previous) =>
          offset === 0 ? payload.data!.comments : [...previous, ...payload.data!.comments]
        );
        setCanComment(payload.data.canComment);
        setHasMore(payload.data.hasMore);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Comments could not load.');
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [query]
  );

  useEffect(() => {
    void load();
    return () => requestRef.current?.abort();
  }, [load]);

  const post = async () => {
    const content = draft.trim();
    if (!canComment || mutationRef.current) return;
    const annotationData = canAnnotate && isAnnotating ? (getAnnotationStrokes?.() ?? []) : [];
    if (!content && annotationData.length === 0) {
      setError('Write a comment or add a drawing before posting.');
      return;
    }
    const timestamp = timedMedia && includeTime ? (pinnedTime ?? captureTime()) : null;
    if (timedMedia && annotationData.length && timestamp === null) {
      setError('A video drawing needs a playback timestamp.');
      return;
    }
    if (timedMedia && includeTime && timestamp === null) {
      setError('Wait for playback to load, or remove the timestamp to post a general comment.');
      return;
    }
    mutationRef.current = true;
    setSubmitting(true);
    onSubmittingChange?.(true);
    setError(null);
    try {
      const response = await fetch(`/api/videos/${videoId}/attachment-comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target,
          content,
          ...(timedMedia ? { timestamp } : {}),
          ...(annotationData.length ? { annotationData } : {}),
          ...(guestName ? { guestName } : {}),
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Comment could not be posted.');
      setDraft('');
      setDraftTime(undefined);
      setIncludeTime(true);
      onAnnotationSaved?.();
      await load();
      onCommentsChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Comment could not be posted.');
    } finally {
      mutationRef.current = false;
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  };

  const remove = async (commentId: string) => {
    if (mutationRef.current) return;
    mutationRef.current = true;
    setDeletingId(commentId);
    setError(null);
    try {
      const response = await fetch(`/api/videos/${videoId}/attachment-comments/${commentId}`, {
        method: 'DELETE',
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || 'Comment could not be deleted.');
      onCommentDeleted?.(commentId);
      await load();
      onCommentsChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Comment could not be deleted.');
    } finally {
      mutationRef.current = false;
      setDeletingId(null);
    }
  };

  const viewAnnotation = (comment: AttachmentComment) => {
    try {
      const strokes = validateAnnotationStrokes(JSON.parse(comment.annotationData!));
      if (strokes?.length) onViewAnnotation?.(comment.id, strokes, comment.timestamp);
      else setError('This annotation could not be displayed.');
    } catch {
      setError('This annotation could not be displayed.');
    }
  };

  return (
    <aside
      className="flex min-h-0 flex-1 flex-col border-t bg-background md:w-[340px] md:flex-none md:border-l md:border-t-0"
      aria-label="File comments"
    >
      <div className="shrink-0 border-b px-4 py-3 text-sm font-semibold">File comments</div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading comments...
          </p>
        ) : comments.length === 0 && !error ? (
          <p className="text-sm text-muted-foreground">No comments on this file yet.</p>
        ) : null}
        {comments.map((comment) => {
          const authorName = comment.author?.name || comment.guestName || 'Reviewer';
          return (
            <article
              key={comment.id}
              className="group min-w-0 rounded-lg border p-3 transition-colors hover:bg-accent/50"
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Avatar className="h-6 w-6 shrink-0">
                    <AvatarImage src={comment.author?.image ?? undefined} />
                    <AvatarFallback className="text-xs">{authorName.charAt(0)}</AvatarFallback>
                  </Avatar>
                  <span className="truncate text-sm font-medium" title={authorName}>
                    {authorName}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {timedMedia && comment.timestamp != null && (
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-xs tabular-nums text-primary transition-colors hover:bg-primary/20 hover:underline disabled:pointer-events-none disabled:opacity-50"
                      aria-label={`Jump to ${formatTime(comment.timestamp)}`}
                      disabled={
                        playbackTime === null || !onSeekTimestamp || isAnnotating || submitting
                      }
                      onClick={() => {
                        if (canAnnotate && comment.annotationData) viewAnnotation(comment);
                        else onSeekTimestamp?.(comment.timestamp!);
                      }}
                    >
                      <Clock className="h-3 w-3" />
                      {formatTime(comment.timestamp)}
                      <ArrowUpRight className="h-3 w-3" />
                    </button>
                  )}
                  {canAnnotate && comment.annotationData && (
                    <button
                      type="button"
                      className="rounded bg-violet-500/15 px-2 py-1 text-xs text-violet-400 hover:bg-violet-500/25 aria-pressed:bg-violet-500/25 disabled:pointer-events-none disabled:opacity-50"
                      aria-pressed={viewingAnnotationId === comment.id}
                      disabled={isAnnotating || submitting || (timedMedia && playbackTime === null)}
                      aria-label="View annotation"
                      title="View annotation"
                      onClick={() => viewAnnotation(comment)}
                    >
                      {timedMedia ? <Pencil className="h-3.5 w-3.5" /> : 'View annotation'}
                    </button>
                  )}
                  {comment.canDelete && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          aria-label="Comment actions"
                          disabled={deletingId === comment.id}
                        >
                          {deletingId === comment.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <MoreVertical className="h-4 w-4" />
                          )}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="text-destructive"
                          onSelect={() => void remove(comment.id)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
              {comment.content && (
                <p className="mb-2 whitespace-pre-wrap break-words text-sm">{comment.content}</p>
              )}
              <div className="flex items-center justify-between gap-2">
                <time className="text-xs text-muted-foreground" dateTime={comment.createdAt}>
                  {new Date(comment.createdAt).toLocaleDateString()}
                </time>
                {canAnnotate && comment.annotationData && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-violet-500 px-2 py-0.5 text-[10px] font-medium text-white">
                    <Pencil className="h-2.5 w-2.5" />
                    Annotated
                  </span>
                )}
              </div>
            </article>
          );
        })}
        {hasMore && !loading && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={loadingMore}
            onClick={() => void load(comments.length)}
          >
            {loadingMore ? 'Loading...' : 'Load more comments'}
          </Button>
        )}
      </div>
      {error && (
        <div role="alert" className="border-t px-4 py-2 text-sm text-destructive">
          {error}
          <Button variant="link" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}
      {canComment && !loading && (
        <form
          className="shrink-0 space-y-2 border-t p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void post();
          }}
        >
          {timedMedia && (
            <Button
              type="button"
              variant={includeTime ? 'secondary' : 'outline'}
              size="sm"
              className="gap-1 tabular-nums"
              aria-label={includeTime ? 'Remove timestamp' : 'Attach timestamp'}
              aria-pressed={includeTime}
              disabled={submitting || isAnnotating}
              onClick={() => {
                if (!includeTime) captureTime();
                else setDraftTime(undefined);
                setIncludeTime(!includeTime);
              }}
            >
              <Clock className="h-3.5 w-3.5" />
              {includeTime
                ? (pinnedTime ?? playbackTime) !== null
                  ? `At ${formatTime((pinnedTime ?? playbackTime)!)}`
                  : 'Waiting for playback'
                : 'General comment'}
            </Button>
          )}
          {canAnnotate && (
            <Button
              type="button"
              variant={isAnnotating ? 'secondary' : 'outline'}
              size="sm"
              className="gap-1"
              disabled={
                submitting ||
                isAnnotating ||
                !annotationReady ||
                (timedMedia && playbackTime === null)
              }
              title={!annotationReady ? 'Waiting for a video frame' : undefined}
              onClick={() => {
                if (timedMedia) {
                  const time = captureTime(true);
                  if (time === null) return;
                  setIncludeTime(true);
                  onStartAnnotation?.(time);
                } else onStartAnnotation?.();
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              {timedMedia
                ? isAnnotating
                  ? 'Drawing on frame'
                  : 'Annotate frame'
                : isAnnotating
                  ? 'Drawing on image'
                  : 'Annotate image'}
            </Button>
          )}
          <Textarea
            disabled={submitting}
            aria-label="Comment on this file"
            placeholder="Comment on this file"
            value={draft}
            onChange={(event) => {
              if (timedMedia && includeTime && pinnedTime === undefined) captureTime();
              setDraft(event.target.value);
            }}
            maxLength={10000}
            rows={3}
          />
          <Button type="submit" size="sm" disabled={submitting || (!draft.trim() && !isAnnotating)}>
            {submitting ? 'Posting...' : 'Post comment'}
          </Button>
        </form>
      )}
    </aside>
  );
}
