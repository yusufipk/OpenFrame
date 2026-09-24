'use client';

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { VideoData } from '@/components/video-page/types';

interface UseVersionDurationSyncParams {
  videoDuration: number;
  durationVersionId: string | null;
  activeVersionDuration?: number | null;
  activeVersionId: string | null;
  propProjectId?: string;
  videoId: string;
  setVideo: Dispatch<SetStateAction<VideoData | null>>;
}

export function useVersionDurationSync({
  videoDuration,
  durationVersionId,
  activeVersionDuration,
  activeVersionId,
  propProjectId,
  videoId,
  setVideo,
}: UseVersionDurationSyncParams) {
  const pendingWritesRef = useRef(new Map<string, Promise<void>>());

  useEffect(() => {
    const roundedDuration = Math.round(videoDuration);
    if (!Number.isFinite(videoDuration) || roundedDuration <= 0) return;
    if (!activeVersionId || durationVersionId !== activeVersionId || !propProjectId) return;
    if (activeVersionDuration === roundedDuration) return;

    let cancelled = false;
    const versionId = activeVersionId;
    const previousWrite = pendingWritesRef.current.get(versionId) ?? Promise.resolve();
    const write = previousWrite.then(async () => {
      try {
        const response = await fetch(
          `/api/projects/${propProjectId}/videos/${videoId}/versions/${versionId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ duration: roundedDuration }),
          }
        );
        if (!response.ok || cancelled) return;
        setVideo((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            versions: prev.versions.map((v) =>
              v.id === versionId ? { ...v, duration: roundedDuration } : v
            ),
          };
        });
      } catch {
        // Retry when playback reports a new duration or the page reloads.
      }
    });
    pendingWritesRef.current.set(versionId, write);
    void write.then(() => {
      if (pendingWritesRef.current.get(versionId) === write) {
        pendingWritesRef.current.delete(versionId);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    videoDuration,
    durationVersionId,
    activeVersionDuration,
    activeVersionId,
    propProjectId,
    videoId,
    setVideo,
  ]);
}
