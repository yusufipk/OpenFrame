'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { VideoAsset } from '@/components/video-page/types';

type BunnyDownloadPreference = 'original' | 'compressed';

type CreateAssetPayload = {
  provider: 'R2_IMAGE' | 'YOUTUBE' | 'BUNNY' | 'R2_AUDIO';
  displayName?: string;
  sourceUrl: string;
  providerVideoId?: string;
  thumbnailUrl?: string;
  uploadToken?: string;
  reservationId?: string | null;
};

interface UseVideoAssetsParams {
  videoId: string;
  isAuthenticated: boolean;
  canUploadAssets: boolean;
  canDownloadAssets: boolean;
  guestName?: string;
}

interface AssetsListResponse {
  data?: {
    assets?: VideoAsset[];
    pagination?: {
      limit?: number;
      offset?: number;
      hasMore?: boolean;
      nextOffset?: number | null;
    };
    canUploadAssets?: boolean;
    canDownloadAssets?: boolean;
  };
  error?: string;
}

interface AssetCreateResponse {
  data?: VideoAsset;
  error?: string;
}

const ASSET_PAGE_SIZE = 40;

export function useVideoAssets({
  videoId,
  isAuthenticated,
  canUploadAssets,
  canDownloadAssets,
  guestName,
}: UseVideoAssetsParams) {
  const [assets, setAssets] = useState<VideoAsset[]>([]);
  const [isLoadingAssets, setIsLoadingAssets] = useState(true);
  const [isCreatingAsset, setIsCreatingAsset] = useState(false);
  const [activeDeleteAssetId, setActiveDeleteAssetId] = useState<string | null>(null);
  const [activeDownloadAssetId, setActiveDownloadAssetId] = useState<string | null>(null);
  const [hasMoreAssets, setHasMoreAssets] = useState(false);
  const [nextAssetsOffset, setNextAssetsOffset] = useState(0);
  const [isLoadingMoreAssets, setIsLoadingMoreAssets] = useState(false);
  const assetsEtagRef = useRef<string | null>(null);
  const isMutatingRef = useRef(false);

  const fetchAssets = useCallback(
    async (options?: { useEtag?: boolean; silent?: boolean }) => {
      const useEtag = options?.useEtag ?? false;
      const silent = options?.silent ?? false;
      if (!silent) setIsLoadingAssets(true);
      try {
        const headers: HeadersInit = {};
        if (useEtag && assetsEtagRef.current) {
          headers['If-None-Match'] = assetsEtagRef.current;
        }
        const res = await fetch(`/api/videos/${videoId}/assets?limit=${ASSET_PAGE_SIZE}&offset=0`, {
          cache: 'no-store',
          headers,
        });
        if (res.status === 304) return;
        const payload = (await res.json().catch(() => null)) as AssetsListResponse | null;
        if (!res.ok) {
          if (!silent) {
            toast.error(payload?.error || 'Failed to fetch assets');
          }
          return;
        }
        const etag = res.headers.get('etag');
        if (etag) assetsEtagRef.current = etag;
        const list = Array.isArray(payload?.data?.assets) ? payload.data.assets : [];
        const pagination = payload?.data?.pagination;
        setAssets(list);
        setHasMoreAssets(!!pagination?.hasMore);
        setNextAssetsOffset(typeof pagination?.nextOffset === 'number' ? pagination.nextOffset : 0);
      } catch {
        if (!silent) {
          toast.error('Failed to fetch assets');
        }
      } finally {
        if (!silent) setIsLoadingAssets(false);
      }
    },
    [videoId]
  );

  const loadMoreAssets = useCallback(async () => {
    if (isLoadingMoreAssets || !hasMoreAssets) return;
    setIsLoadingMoreAssets(true);
    try {
      const res = await fetch(
        `/api/videos/${videoId}/assets?limit=${ASSET_PAGE_SIZE}&offset=${nextAssetsOffset}`,
        { cache: 'no-store' }
      );
      const payload = (await res.json().catch(() => null)) as AssetsListResponse | null;
      if (!res.ok) {
        toast.error(payload?.error || 'Failed to load more assets');
        return;
      }
      const list = Array.isArray(payload?.data?.assets) ? payload.data.assets : [];
      const pagination = payload?.data?.pagination;
      setAssets((prev) => [
        ...prev,
        ...list.filter((asset) => !prev.some((existing) => existing.id === asset.id)),
      ]);
      setHasMoreAssets(!!pagination?.hasMore);
      setNextAssetsOffset(typeof pagination?.nextOffset === 'number' ? pagination.nextOffset : 0);
    } catch {
      toast.error('Failed to load more assets');
    } finally {
      setIsLoadingMoreAssets(false);
    }
  }, [hasMoreAssets, isLoadingMoreAssets, nextAssetsOffset, videoId]);

  useEffect(() => {
    void fetchAssets({ useEtag: true });
  }, [fetchAssets]);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let isPageVisible = true;

    const poll = async () => {
      if (!isPageVisible || isMutatingRef.current || isLoadingMoreAssets) return;
      await fetchAssets({ useEtag: true, silent: true });
    };

    intervalId = setInterval(poll, 10000);
    const handleVisibilityChange = () => {
      isPageVisible = document.visibilityState === 'visible';
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchAssets, isLoadingMoreAssets]);

  const createAsset = useCallback(
    async (payload: CreateAssetPayload): Promise<VideoAsset | null> => {
      if (!canUploadAssets) {
        toast.error('You do not have permission to upload assets');
        return null;
      }

      setIsCreatingAsset(true);
      isMutatingRef.current = true;
      try {
        const res = await fetch(`/api/videos/${videoId}/assets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            ...(isAuthenticated ? {} : { guestName: guestName?.trim() || 'Guest' }),
          }),
        });
        const body = (await res.json().catch(() => null)) as AssetCreateResponse | null;
        if (!res.ok || !body?.data) {
          toast.error(body?.error || 'Failed to create asset');
          return null;
        }

        setAssets((prev) => [body.data!, ...prev]);
        setNextAssetsOffset((prev) => prev + 1);
        return body.data;
      } catch {
        toast.error('Failed to create asset');
        return null;
      } finally {
        setIsCreatingAsset(false);
        isMutatingRef.current = false;
      }
    },
    [canUploadAssets, videoId, isAuthenticated, guestName]
  );

  const deleteAsset = useCallback(
    async (assetId: string) => {
      setActiveDeleteAssetId(assetId);
      isMutatingRef.current = true;
      try {
        const res = await fetch(`/api/videos/${videoId}/assets/${assetId}`, {
          method: 'DELETE',
        });
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) {
          toast.error(payload?.error || 'Failed to delete asset');
          return false;
        }

        setAssets((prev) => prev.filter((asset) => asset.id !== assetId));
        setNextAssetsOffset((prev) => Math.max(0, prev - 1));
        return true;
      } catch {
        toast.error('Failed to delete asset');
        return false;
      } finally {
        setActiveDeleteAssetId(null);
        isMutatingRef.current = false;
      }
    },
    [videoId]
  );

  const downloadAsset = useCallback(
    async (asset: VideoAsset, preference: BunnyDownloadPreference = 'compressed') => {
      if (!canDownloadAssets) {
        toast.error('Asset downloads require an authenticated account');
        return;
      }
      if (asset.provider === 'YOUTUBE') {
        toast.error('YouTube assets cannot be downloaded');
        return;
      }

      setActiveDownloadAssetId(asset.id);
      try {
        let downloadUrl = `/api/videos/${videoId}/assets/${asset.id}/download`;

        if (asset.provider === 'BUNNY') {
          const prepareRes = await fetch(`${downloadUrl}?source=${preference}&prepare=1`, {
            cache: 'no-store',
          });
          const prepareBody = (await prepareRes.json().catch(() => null)) as {
            error?: string;
          } | null;
          if (!prepareRes.ok) {
            toast.error(prepareBody?.error || 'Download is not available');
            return;
          }
          downloadUrl = `${downloadUrl}?source=${preference}`;
        }

        const a = document.createElement('a');
        a.href = downloadUrl;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch {
        toast.error('Failed to start download');
      } finally {
        setActiveDownloadAssetId(null);
      }
    },
    [canDownloadAssets, videoId]
  );

  const getGuestUploadToken = useCallback(
    async (intent: 'image' | 'audio') => {
      if (isAuthenticated) return null;
      const response = await fetch(`/api/watch/${videoId}/upload-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent }),
      });
      const payload = (await response.json().catch(() => null)) as {
        data?: { token?: string };
        error?: string;
      } | null;
      const token = payload?.data?.token;
      if (!response.ok || !token) {
        throw new Error(payload?.error || 'Failed to prepare upload');
      }
      return token;
    },
    [isAuthenticated, videoId]
  );

  return {
    assets,
    isLoadingAssets,
    isCreatingAsset,
    activeDeleteAssetId,
    activeDownloadAssetId,
    hasMoreAssets,
    isLoadingMoreAssets,
    fetchAssets,
    loadMoreAssets,
    createAsset,
    deleteAsset,
    downloadAsset,
    getGuestUploadToken,
  };
}
