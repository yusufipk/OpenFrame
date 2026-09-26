'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { AttachmentCommentTarget } from '@/lib/attachment-comment-target';

interface AttachmentComment {
  id: string;
  content: string;
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
}

const PAGE_SIZE = 30;

export function AttachmentCommentsPanel({
  videoId,
  target,
  guestName,
  onCommentsChanged,
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
    if (!content || !canComment || mutationRef.current) return;
    mutationRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/videos/${videoId}/attachment-comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, content, ...(guestName ? { guestName } : {}) }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Comment could not be posted.');
      setDraft('');
      await load();
      onCommentsChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Comment could not be posted.');
    } finally {
      mutationRef.current = false;
      setSubmitting(false);
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
      await load();
      onCommentsChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Comment could not be deleted.');
    } finally {
      mutationRef.current = false;
      setDeletingId(null);
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
        {comments.map((comment) => (
          <article key={comment.id} className="rounded-lg border bg-muted/30 p-3">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0 text-xs font-medium truncate">
                {comment.author?.name || comment.guestName || 'Reviewer'}
              </div>
              {comment.canDelete && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label="Delete comment"
                  disabled={deletingId === comment.id}
                  onClick={() => void remove(comment.id)}
                >
                  {deletingId === comment.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              )}
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{comment.content}</p>
            <time className="mt-2 block text-xs text-muted-foreground" dateTime={comment.createdAt}>
              {new Date(comment.createdAt).toLocaleString()}
            </time>
          </article>
        ))}
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
          <Textarea
            aria-label="Comment on this file"
            placeholder="Comment on this file"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={10000}
            rows={3}
          />
          <Button type="submit" size="sm" disabled={submitting || !draft.trim()}>
            {submitting ? 'Posting...' : 'Post comment'}
          </Button>
        </form>
      )}
    </aside>
  );
}
