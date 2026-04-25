'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Comment, CommentTag, Version, VideoData } from '@/components/video-page/types';

interface UseVideoPageDataParams {
  mode: 'dashboard' | 'watch';
  videoId: string;
  propProjectId?: string;
}

export function useVideoPageData({ mode, videoId, propProjectId }: UseVideoPageDataParams) {
  const [video, setVideo] = useState<VideoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [availableTags, setAvailableTags] = useState<CommentTag[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);

  const commentsEtagRef = useRef<Map<string, string>>(new Map());

  const apiBasePath = useMemo(() => {
    return mode === 'dashboard'
      ? `/api/projects/${propProjectId}/videos/${videoId}?includeComments=false`
      : `/api/watch/${videoId}`;
  }, [mode, propProjectId, videoId]);

  const projectId = propProjectId || video?.projectId;

  const fetchVersionComments = useCallback(async (versionId: string, useEtag: boolean) => {
    const headers: HeadersInit = {};
    if (useEtag) {
      const etag = commentsEtagRef.current.get(versionId);
      if (etag) headers['If-None-Match'] = etag;
    }

    const LIMIT = 200;
    let offset = 0;
    let allComments: Comment[] = [];
    let latestEtag: string | null = null;

    // Fetch pages until we have all comments
    while (true) {
      const res = await fetch(
        `/api/versions/${versionId}/comments?includeResolved=true&limit=${LIMIT}&offset=${offset}`,
        { cache: 'no-store', headers: offset === 0 ? headers : {} }
      );

      if (offset === 0 && res.status === 304) return;
      if (!res.ok) return;

      if (offset === 0) {
        latestEtag = res.headers.get('etag');
      }

      const payload = await res.json();
      const page: Comment[] = payload?.data?.comments;
      if (!Array.isArray(page)) return;

      allComments = allComments.concat(page);

      if (!payload?.data?.hasMore) break;
      offset += LIMIT;
    }

    if (latestEtag) commentsEtagRef.current.set(versionId, latestEtag);

    const commentsList = allComments;

    setVideo((prev) => {
      if (!prev) return prev;
      const totalComments = commentsList.reduce((sum: number, comment: Comment) => {
        return sum + 1 + (comment.replies?.length ?? 0);
      }, 0);

      return {
        ...prev,
        versions: prev.versions.map((version) =>
          version.id === versionId
            ? { ...version, comments: commentsList, _count: { comments: totalComments } }
            : version
        ),
      };
    });
  }, []);

  useEffect(() => {
    async function fetchVideo() {
      try {
        const res = await fetch(apiBasePath, { cache: 'no-store' });
        if (!res.ok) {
          const errorText = mode === 'dashboard' ? await res.text() : '';
          setError(
            mode === 'dashboard'
              ? `Failed to load video: ${res.status} ${errorText}`
              : 'Video not found or access denied'
          );
          setLoading(false);
          return;
        }
        const response = await res.json();
        const rawData = response.data as Omit<VideoData, 'versions'> & {
          versions?: Array<Version & { comments?: Comment[] }>;
        };
        const normalizedData: VideoData = {
          ...rawData,
          versions: (rawData.versions || []).map((version) => ({
            ...version,
            comments: Array.isArray(version.comments) ? version.comments : [],
          })),
        };

        setVideo(normalizedData);
        const active =
          normalizedData.versions?.find((v) => v.isActive) || normalizedData.versions?.[0];
        if (active) setActiveVersionId(active.id);
      } catch (err) {
        console.error('Error fetching video:', err);
        setError('Failed to load video');
      } finally {
        setLoading(false);
      }
    }
    void fetchVideo();
  }, [apiBasePath, mode]);

  useEffect(() => {
    if (!activeVersionId) return;
    void fetchVersionComments(activeVersionId, true);
  }, [activeVersionId, fetchVersionComments]);

  useEffect(() => {
    if (!projectId) return;
    async function fetchTags() {
      try {
        const query = videoId ? `?videoId=${encodeURIComponent(videoId)}` : '';
        const res = await fetch(`/api/projects/${projectId}/tags${query}`);
        if (res.ok) {
          const data = await res.json();
          const tags = data.data || [];
          setAvailableTags(tags);
          if (tags.length > 0 && !selectedTagId) {
            setSelectedTagId(tags[0].id);
          }
        }
      } catch {
        // noop
      }
    }
    void fetchTags();
  }, [projectId, selectedTagId, videoId]);

  return {
    video,
    setVideo,
    loading,
    error,
    activeVersionId,
    setActiveVersionId,
    availableTags,
    setAvailableTags,
    selectedTagId,
    setSelectedTagId,
    projectId,
    fetchVersionComments,
  };
}
