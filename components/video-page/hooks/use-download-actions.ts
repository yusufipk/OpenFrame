'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  BunnyDownloadPreference,
  Comment,
  DownloadTarget,
  Version,
  VideoData,
} from '@/components/video-page/types';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import { resolvePublicDirectDownloadAllowedHosts } from '@/lib/runtime-public-config';
import {
  downloadNamedFile,
  downloadProgressLabel,
  downloadProgressPercent,
  extensionFromUrl,
  navigateDownload,
  sanitizeDownloadFileName,
} from '@/lib/client/download-file';
import {
  createDownloadProgressToast,
  type DownloadProgressToastHandle,
} from '@/components/download-progress-toast';
import { beginUnloadGuard } from '@/lib/client/unload-guard';

function getAllowedHosts() {
  const bunnyCdnHostname = resolvePublicBunnyCdnHostname();
  return [
    ...(bunnyCdnHostname ? [bunnyCdnHostname.trim().toLowerCase()] : []),
    ...resolvePublicDirectDownloadAllowedHosts(),
  ].filter(Boolean);
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
  // The guard reads a ref, not the state. Two calls originating in the same render both
  // saw the old state value and both proceeded, so a fast double-click downloaded the
  // file twice.
  const isDownloadingRef = useRef(false);

  const startDownload = useCallback(
    async (preference: BunnyDownloadPreference = 'compressed') => {
      if (!activeVersion || !video || isDownloadingRef.current) return;
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
      isDownloadingRef.current = true;
      setActiveDownloadTarget(target);
      let progressToast: DownloadProgressToastHandle | null = null;
      let releaseUnloadGuard: (() => void) | null = null;
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

          // The file is pulled into the browser before it can be saved, which on
          // a big file / slow connection takes a while with no native download UI
          // — show live progress so it doesn't look stuck. The panel can be
          // minimized because it sits over the comment composer.
          progressToast = createDownloadProgressToast(`download-${activeVersion.id}`, {
            title: `Downloading “${baseName}”`,
            description: 'Starting…',
          });
          // The bytes only exist in this tab until the blob is saved, so warn
          // before the page goes away instead of losing the whole transfer.
          releaseUnloadGuard = beginUnloadGuard();
          const saved = await downloadNamedFile(downloadUrl, `${baseName}.${fallbackExt}`, (p) => {
            progressToast?.update({
              description: downloadProgressLabel(p),
              percent: downloadProgressPercent(p),
            });
          });
          if (saved) {
            progressToast.success(`“${baseName}” downloaded`);
          } else {
            // Too large to buffer (or fetch blocked): let the browser download it
            // directly (its own progress UI, CDN filename).
            progressToast.dismiss();
            navigateDownload(downloadUrl);
          }
        }
      } catch (error) {
        console.error('Failed to start video download:', error);
        // The progress panel never expires on its own, so clear it before the
        // error toast replaces it.
        progressToast?.dismiss();
        if (error instanceof Error && error.message === 'Direct download URL is not allowed') {
          toast.error('This direct download host is not allowed');
        } else if (error instanceof Error && error.message) {
          toast.error(error.message);
        } else {
          toast.error('Failed to start download');
        }
      } finally {
        releaseUnloadGuard?.();
        isDownloadingRef.current = false;
        setActiveDownloadTarget(null);
      }
    },
    [activeVersion, video]
  );

  return {
    activeDownloadTarget,
    isDownloadingVideo,
    startDownload,
  };
}
