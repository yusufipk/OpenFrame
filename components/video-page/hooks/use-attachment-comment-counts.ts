'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface CountsResponse {
  data?: { counts?: Record<string, number> };
}

export function useAttachmentCommentCounts(videoId: string, versionId: string | null) {
  const [snapshot, setSnapshot] = useState<{ key: string; counts: Record<string, number> }>({
    key: '',
    counts: {},
  });
  const requestRef = useRef<AbortController | null>(null);
  const contextKey = `${videoId}:${versionId ?? ''}`;
  const contextRef = useRef(contextKey);

  const refresh = useCallback(async () => {
    if (!videoId || !versionId) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const requestedContext = `${videoId}:${versionId}`;
    try {
      const params = new URLSearchParams({ counts: 'true', versionId });
      const response = await fetch(`/api/videos/${videoId}/attachment-comments?${params}`, {
        signal: controller.signal,
      });
      if (!response.ok) return;
      const payload = (await response.json()) as CountsResponse;
      if (!controller.signal.aborted && contextRef.current === requestedContext) {
        setSnapshot({ key: requestedContext, counts: payload.data?.counts ?? {} });
      }
    } catch {
      // Counts are supplemental. The preview still loads its own discussion.
    }
  }, [videoId, versionId]);

  useEffect(() => {
    contextRef.current = contextKey;
    let active = true;
    queueMicrotask(() => {
      if (active) void refresh();
    });
    return () => {
      active = false;
      requestRef.current?.abort();
    };
  }, [contextKey, refresh]);

  return { counts: snapshot.key === contextKey ? snapshot.counts : {}, refresh };
}
