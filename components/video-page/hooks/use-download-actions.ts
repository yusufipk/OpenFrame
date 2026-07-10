'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import type {
  BunnyDownloadPreference,
  Comment,
  DownloadTarget,
  Version,
  VideoData,
} from '@/components/video-page/types';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import { downloadNamedFile, extensionFromUrl, navigateDownload } from '@/lib/client/download-file';

function sanitizeDownloadFileName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function getAllowedHosts() {
  const bunnyCdnHostname = resolvePublicBunnyCdnHostname();
  return [
    ...(bunnyCdnHostname ? [bunnyCdnHostname] : []),
    ...(process.env.NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS ?? '').split(','),
  ]
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function getSafeDirectDownloadUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    const allowedHosts = getAllowedHosts();
    if (allowedHosts.length === 0) {
      return null;
    }

    const normalizedHost = parsed.hostname.toLowerCase();
    if (!allowedHosts.includes(normalizedHost)) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

interface UseDownloadActionsParams {
  activeVersion: (Version & { comments: Comment[] }) | undefined;
  video: VideoData | null;
}

export function useDownloadActions({ activeVersion, video }: UseDownloadActionsParams) {
  const [activeDownloadTarget, setActiveDownloadTarget] = useState<DownloadTarget | null>(null);
  const isDownloadingVideo = activeDownloadTarget !== null;

  const startDownload = useCallback(
    async (preference: BunnyDownloadPreference = 'compressed') => {
      if (!activeVersion || !video || isDownloadingVideo) return;
      if (!video.canDownload) {
        toast.error('Download is disabled for this shared link');
        return;
      }
      if (
        activeVersion.providerId !== 'bunny' &&
        activeVersion.providerId !== 'direct' &&
        activeVersion.providerId !== 'r2'
      ) {
        toast.error('This video source does not support direct download');
        return;
      }

      const target: DownloadTarget = activeVersion.providerId === 'bunny' ? preference : 'direct';
      setActiveDownloadTarget(target);
      try {
        let downloadUrl: string | null = null;

        if (activeVersion.providerId === 'bunny') {
          const prepareRes = await fetch(
            `/api/versions/${activeVersion.id}/download?source=${preference}&prepare=1`,
            {
              cache: 'no-store',
            }
          );

          if (!prepareRes.ok) {
            const prepareBody = await prepareRes.json().catch(() => null);
            const fallbackError =
              preference === 'original'
                ? 'Original file is not available for this video'
                : 'Compressed file is not available for this video';
            const errorMessage =
              typeof prepareBody?.error === 'string' ? prepareBody.error : fallbackError;
            throw new Error(errorMessage);
          }

          downloadUrl = `/api/versions/${activeVersion.id}/download?source=${preference}`;
        } else if (activeVersion.providerId === 'r2') {
          if (!activeVersion.originalUrl.startsWith('/api/upload/video/')) {
            throw new Error('Direct download URL is not allowed');
          }
          downloadUrl = activeVersion.originalUrl;
        } else {
          downloadUrl = getSafeDirectDownloadUrl(activeVersion.originalUrl);
          if (!downloadUrl) {
            throw new Error('Direct download URL is not allowed');
          }
        }

        if (!downloadUrl) {
          throw new Error('Missing download URL');
        }

        // File name: "<video title> <version label>" if the editor set a label
        // for this version, otherwise "<video title> v<number>".
        const versionLabel = activeVersion.versionLabel?.trim();
        const baseName =
          sanitizeDownloadFileName(
            versionLabel
              ? `${video.title} ${versionLabel}`
              : `${video.title} v${activeVersion.versionNumber}`
          ) || 'video';

        if (activeVersion.providerId === 'r2') {
          // Same-origin proxy: the download attribute applies and streams
          // without buffering the whole file in memory (any size).
          const ext = extensionFromUrl(activeVersion.originalUrl) || 'mp4';
          navigateDownload(downloadUrl, `${baseName}.${ext}`);
        } else {
          // Bunny (CDN redirect) and direct hosts are cross-origin, so the
          // download attribute is ignored on a plain navigation. Fetch the bytes
          // (CORS is open) and save them with our filename — unless the file is
          // over 10 GB, in which case downloadNamedFile returns false and we fall
          // back to a plain navigation (streams to disk with the CDN's name).
          const fallbackExt =
            (activeVersion.providerId === 'direct'
              ? extensionFromUrl(activeVersion.originalUrl)
              : '') || 'mp4';
          const saved = await downloadNamedFile(downloadUrl, `${baseName}.${fallbackExt}`);
          if (!saved) {
            navigateDownload(downloadUrl);
          }
        }
      } catch (error) {
        console.error('Failed to start video download:', error);
        if (error instanceof Error && error.message === 'Direct download URL is not allowed') {
          toast.error('This direct download host is not allowed');
        } else if (error instanceof Error && error.message) {
          toast.error(error.message);
        } else {
          toast.error('Failed to start download');
        }
      } finally {
        setActiveDownloadTarget(null);
      }
    },
    [activeVersion, video, isDownloadingVideo]
  );

  return {
    activeDownloadTarget,
    isDownloadingVideo,
    startDownload,
  };
}
