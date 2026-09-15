'use client';

import { useState, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';
import * as tus from 'tus-js-client';
import {
  parseVideoUrl,
  getThumbnailUrl,
  fetchVideoMetadata,
  type VideoSource,
} from '@/lib/video-providers';
import type { VersionActionsConfig, VideoData } from '@/components/video-page/types';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import { cleanupPendingR2VideoUpload, uploadVideoToR2 } from '@/lib/client/r2-video-upload';
import { apiRequestError, toastApiError } from '@/lib/client/api-error';

/** What a failed version upload has to undo, depending on which provider it started on. */
type PendingVersionCleanup =
  | { objectKey: string; uploadToken: string; reservationId: string | null }
  | { bunnyVideoId: string; uploadToken: string };

interface UseVersionActionsParams extends VersionActionsConfig {
  setVideo: Dispatch<SetStateAction<VideoData | null>>;
  activeVersionId: string | null;
  setActiveVersionId: Dispatch<SetStateAction<string | null>>;
}

export function useVersionActions({
  projectId,
  videoId,
  directUploadsEnabled = false,
  directUploadProvider = 'bunny',
  setVideo,
  activeVersionId,
  setActiveVersionId,
}: UseVersionActionsParams) {
  const [showVersionDialog, setShowVersionDialog] = useState(false);
  const [newVersionUrl, setNewVersionUrl] = useState('');
  const [newVersionLabel, setNewVersionLabel] = useState('');
  const [newVersionSource, setNewVersionSource] = useState<VideoSource | null>(null);
  const [newVersionUrlError, setNewVersionUrlError] = useState('');
  const [isCreatingVersion, setIsCreatingVersion] = useState(false);
  const [newVersionMode, setNewVersionMode] = useState<'url' | 'file'>('url');
  const [newVersionFile, setNewVersionFile] = useState<File | null>(null);
  const [newVersionUploadProgress, setNewVersionUploadProgress] = useState(0);
  const [newVersionUploadStatus, setNewVersionUploadStatus] = useState('');

  const [showDeleteVersionDialog, setShowDeleteVersionDialog] = useState(false);
  const [versionToDelete, setVersionToDelete] = useState<string | null>(null);
  const [isDeletingVersion, setIsDeletingVersion] = useState(false);
  const bunnyCdnHostname = resolvePublicBunnyCdnHostname();

  const handleNewVersionUrlChange = (url: string) => {
    setNewVersionUrl(url);
    setNewVersionUrlError('');
    if (!url.trim()) {
      setNewVersionSource(null);
      return;
    }
    const source = parseVideoUrl(url);
    if (source) {
      setNewVersionSource(source);
    } else {
      setNewVersionSource(null);
      if (url.length > 10) setNewVersionUrlError('Unsupported URL');
    }
  };

  /**
   * `onPendingCleanup` is called the moment there is something to clean up, which for a
   * Bunny upload is when bunny-init answers and the remote video already exists. Waiting
   * for this function to return instead meant a tus `onError` threw past the assignment,
   * so every failed Bunny upload left a video behind on the Bunny side: billed, and
   * invisible in the app.
   */
  const uploadNewVersionFile = async (
    file: File,
    title: string,
    onPendingCleanup: (cleanup: PendingVersionCleanup) => void
  ) => {
    if (!projectId) throw new Error('Missing project');

    if (directUploadProvider === 'r2') {
      setNewVersionUploadStatus('Initializing upload...');
      const uploaded = await uploadVideoToR2(projectId, file, {
        targetVideoId: videoId,
        onProgress: (progress) => {
          setNewVersionUploadProgress(progress);
          setNewVersionUploadStatus(`Uploading... ${progress}%`);
        },
      });

      return {
        finalVideoUrl: uploaded.proxyUrl,
        finalProviderId: 'r2',
        finalProviderVideoId: uploaded.objectKey,
        finalThumbnailUrl: uploaded.thumbnailUrl || '/placeholder-video-thumbnail.png',
        finalDuration: uploaded.duration,
        uploadToken: uploaded.uploadToken,
        objectKey: uploaded.objectKey,
        reservationId: uploaded.reservationId,
        pendingCleanup: {
          objectKey: uploaded.objectKey,
          uploadToken: uploaded.uploadToken,
          reservationId: uploaded.reservationId,
          thumbnailObjectKey: uploaded.thumbnailObjectKey,
        },
      };
    }

    setNewVersionUploadStatus('Initializing upload...');
    const initRes = await fetch(`/api/projects/${projectId}/videos/bunny-init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetVideoId: videoId, title, sizeBytes: file.size.toString() }),
    });

    if (!initRes.ok) {
      const initPayload = (await initRes.json().catch(() => null)) as {
        error?: string;
        code?: string;
      } | null;
      throw apiRequestError(initPayload, 'Failed to initialize upload');
    }
    const {
      data: { videoId: bunnyVideoId, libraryId, signature, expirationTime, uploadToken },
    } = await initRes.json();

    // The remote video exists from here on, so it is cleanable from here on.
    onPendingCleanup({ bunnyVideoId, uploadToken });

    await new Promise((resolve, reject) => {
      setNewVersionUploadStatus('Uploading video...');
      const upload = new tus.Upload(file, {
        endpoint: 'https://video.bunnycdn.com/tusupload',
        retryDelays: [0, 3000, 5000, 10000, 20000],
        headers: {
          AuthorizationSignature: signature,
          AuthorizationExpire: expirationTime.toString(),
          VideoId: bunnyVideoId,
          LibraryId: libraryId,
        },
        metadata: {
          filetype: file.type,
          title,
        },
        onError: (error) => reject(new Error(`Upload failed: ${error.message}`)),
        onProgress: (bytesUploaded, bytesTotal) => {
          const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(1);
          setNewVersionUploadProgress(Number(percentage));
          setNewVersionUploadStatus(`Uploading... ${percentage}%`);
        },
        onSuccess: () => {
          setNewVersionUploadStatus('Processing video...');
          resolve(true);
        },
      });
      upload.start();
    });

    return {
      finalVideoUrl: `https://iframe.mediadelivery.net/embed/${libraryId}/${bunnyVideoId}`,
      finalProviderId: 'bunny',
      finalProviderVideoId: bunnyVideoId,
      finalThumbnailUrl: bunnyCdnHostname
        ? `https://${bunnyCdnHostname}/${bunnyVideoId}/thumbnail.jpg`
        : null,
      finalDuration: null as number | null,
      uploadToken,
      objectKey: null as string | null,
      reservationId: null as string | null,
      pendingCleanup: {
        bunnyVideoId,
        uploadToken,
      },
    };
  };

  const handleCreateVersion = async () => {
    if (!projectId) return;
    setIsCreatingVersion(true);
    setNewVersionUploadStatus('');
    setNewVersionUploadProgress(0);
    let pendingCleanup: PendingVersionCleanup | null = null;

    try {
      let finalVideoUrl = '';
      let finalProviderId = '';
      let finalProviderVideoId = '';
      let finalThumbnailUrl: string | null = null;
      let finalDuration: number | null = null;
      let uploadToken: string | null = null;
      let objectKey: string | null = null;
      let reservationId: string | null = null;

      if (newVersionMode === 'url') {
        if (!newVersionSource) throw new Error('Invalid URL');
        const meta = await fetchVideoMetadata(newVersionSource);
        finalVideoUrl = newVersionSource.originalUrl;
        finalProviderId = newVersionSource.providerId;
        finalProviderVideoId = newVersionSource.videoId;
        finalThumbnailUrl = getThumbnailUrl(newVersionSource, 'large');
        finalDuration = meta?.duration || null;
      } else {
        if (!directUploadsEnabled) throw new Error('Direct uploads are disabled by this host');
        if (!newVersionFile) throw new Error('No file selected');
        let title = newVersionFile.name;
        if (newVersionLabel.trim()) {
          title = newVersionLabel.trim();
        } else {
          title = title.replace(/\.[^/.]+$/, '');
        }

        const uploaded = await uploadNewVersionFile(newVersionFile, title, (cleanup) => {
          pendingCleanup = cleanup;
        });
        finalVideoUrl = uploaded.finalVideoUrl;
        finalProviderId = uploaded.finalProviderId;
        finalProviderVideoId = uploaded.finalProviderVideoId;
        finalThumbnailUrl = uploaded.finalThumbnailUrl;
        finalDuration = uploaded.finalDuration;
        uploadToken = uploaded.uploadToken;
        objectKey = uploaded.objectKey;
        reservationId = uploaded.reservationId;
        pendingCleanup = uploaded.pendingCleanup;
      }

      const res = await fetch(`/api/projects/${projectId}/videos/${videoId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrl: finalVideoUrl,
          providerId: finalProviderId,
          providerVideoId: finalProviderVideoId,
          uploadToken,
          objectKey,
          reservationId,
          versionLabel: newVersionLabel.trim() || null,
          thumbnailUrl: finalThumbnailUrl,
          duration: finalDuration,
          setActive: true,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw apiRequestError(data, 'Failed to create version');
      }

      const versionData = await res.json();
      const newVersion = versionData.data;
      setVideo((prev) => {
        if (!prev) return prev;
        const updatedVersions = prev.versions.map((v) => ({ ...v, isActive: false }));
        updatedVersions.unshift({
          ...newVersion,
          comments: [],
        });
        return { ...prev, versions: updatedVersions };
      });
      setActiveVersionId(newVersion.id);
      setShowVersionDialog(false);
      setNewVersionUrl('');
      setNewVersionLabel('');
      setNewVersionSource(null);
      setNewVersionFile(null);
      setNewVersionUploadStatus('');
      pendingCleanup = null;
    } catch (err) {
      const errorObj = err as Error;
      if (pendingCleanup && projectId) {
        if ('objectKey' in pendingCleanup) {
          await cleanupPendingR2VideoUpload(projectId, pendingCleanup);
        } else {
          await fetch(`/api/projects/${projectId}/videos/bunny-init`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              videoId: pendingCleanup.bunnyVideoId,
              uploadToken: pendingCleanup.uploadToken,
            }),
          }).catch((cleanupError) => {
            console.error('Failed to cleanup pending Bunny version upload:', cleanupError);
          });
        }
      }
      console.error('Failed to create version:', errorObj);
      toastApiError(errorObj, 'Failed to create version');
    } finally {
      setIsCreatingVersion(false);
      setNewVersionUploadProgress(0);
    }
  };

  const handleDeleteVersion = async () => {
    if (!versionToDelete || !projectId) return;
    setIsDeletingVersion(true);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/videos/${videoId}/versions/${versionToDelete}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'Failed to delete version');
      }

      setVideo((prev) => {
        if (!prev) return prev;
        const remaining = prev.versions.filter((v) => v.id !== versionToDelete);
        if (activeVersionId === versionToDelete && remaining.length > 0) {
          const nextActive = remaining.find((v) => v.isActive) ?? remaining[0];
          setActiveVersionId(nextActive.id);
        }
        return { ...prev, versions: remaining };
      });

      setShowDeleteVersionDialog(false);
      setVersionToDelete(null);
      toast.success('Version deleted');
    } catch (err) {
      const errorObj = err as Error;
      console.error('Failed to delete version:', errorObj);
      toast.error(errorObj.message || 'Failed to delete version');
    } finally {
      setIsDeletingVersion(false);
    }
  };

  return {
    showVersionDialog,
    setShowVersionDialog,
    newVersionUrl,
    newVersionLabel,
    setNewVersionLabel,
    newVersionSource,
    newVersionUrlError,
    isCreatingVersion,
    newVersionMode,
    setNewVersionMode,
    newVersionFile,
    setNewVersionFile,
    newVersionUploadProgress,
    newVersionUploadStatus,
    handleNewVersionUrlChange,
    handleCreateVersion,
    showDeleteVersionDialog,
    setShowDeleteVersionDialog,
    setVersionToDelete,
    isDeletingVersion,
    handleDeleteVersion,
  };
}
