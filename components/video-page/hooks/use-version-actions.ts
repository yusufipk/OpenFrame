'use client';

import { useState, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';
import * as tus from 'tus-js-client';
import { parseVideoUrl, getThumbnailUrl, fetchVideoMetadata, type VideoSource } from '@/lib/video-providers';
import type { VersionActionsConfig, VideoData } from '@/components/video-page/types';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';

interface UseVersionActionsParams extends VersionActionsConfig {
  setVideo: Dispatch<SetStateAction<VideoData | null>>;
  activeVersionId: string | null;
  setActiveVersionId: Dispatch<SetStateAction<string | null>>;
}

export function useVersionActions({
  projectId,
  videoId,
  bunnyUploadsEnabled = true,
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

  const handleCreateVersion = async () => {
    if (!projectId) return;
    setIsCreatingVersion(true);
    setNewVersionUploadStatus('');
    setNewVersionUploadProgress(0);
    let uploadedBunnyVideoId: string | null = null;
    let uploadedBunnyUploadToken: string | null = null;

    try {
      let finalVideoUrl = '';
      let finalProviderId = '';
      let finalProviderVideoId = '';
      let finalThumbnailUrl: string | null = null;
      let finalDuration: number | null = null;

      if (newVersionMode === 'url') {
        if (!newVersionSource) throw new Error('Invalid URL');
        const meta = await fetchVideoMetadata(newVersionSource);
        finalVideoUrl = newVersionSource.originalUrl;
        finalProviderId = newVersionSource.providerId;
        finalProviderVideoId = newVersionSource.videoId;
        finalThumbnailUrl = getThumbnailUrl(newVersionSource, 'large');
        finalDuration = meta?.duration || null;
      } else {
        if (!bunnyUploadsEnabled) throw new Error('Direct uploads are disabled by this host');
        if (!newVersionFile) throw new Error('No file selected');
        let title = newVersionFile.name;
        if (newVersionLabel.trim()) {
          title = newVersionLabel.trim();
        } else {
          title = title.replace(/\.[^/.]+$/, '');
        }

        setNewVersionUploadStatus('Initializing upload...');
        const initRes = await fetch(`/api/projects/${projectId}/videos/bunny-init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        });

        if (!initRes.ok) throw new Error('Failed to initialize upload');
        const { data: { videoId: bunnyVideoId, libraryId, signature, expirationTime, uploadToken } } = await initRes.json();
        uploadedBunnyVideoId = bunnyVideoId;
        uploadedBunnyUploadToken = uploadToken;

        await new Promise((resolve, reject) => {
          setNewVersionUploadStatus('Uploading video...');
          const upload = new tus.Upload(newVersionFile, {
            endpoint: 'https://video.bunnycdn.com/tusupload',
            retryDelays: [0, 3000, 5000, 10000, 20000],
            headers: {
              AuthorizationSignature: signature,
              AuthorizationExpire: expirationTime.toString(),
              VideoId: bunnyVideoId,
              LibraryId: libraryId,
            },
            metadata: {
              filetype: newVersionFile.type,
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

        finalVideoUrl = `https://iframe.mediadelivery.net/embed/${libraryId}/${bunnyVideoId}`;
        finalProviderId = 'bunny';
        finalProviderVideoId = bunnyVideoId;
        finalThumbnailUrl = bunnyCdnHostname
          ? `https://${bunnyCdnHostname}/${bunnyVideoId}/thumbnail.jpg`
          : null;
      }

      const res = await fetch(`/api/projects/${projectId}/videos/${videoId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrl: finalVideoUrl,
          providerId: finalProviderId,
          providerVideoId: finalProviderVideoId,
          uploadToken: uploadedBunnyUploadToken,
          versionLabel: newVersionLabel.trim() || null,
          thumbnailUrl: finalThumbnailUrl,
          duration: finalDuration,
          setActive: true,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'Failed to create version');
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
    } catch (err) {
      const errorObj = err as Error;
      if (uploadedBunnyVideoId && uploadedBunnyUploadToken) {
        await fetch(`/api/projects/${projectId}/videos/bunny-init`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: uploadedBunnyVideoId, uploadToken: uploadedBunnyUploadToken }),
        }).catch((cleanupError) => {
          console.error('Failed to cleanup pending Bunny version upload:', cleanupError);
        });
      }
      console.error('Failed to create version:', errorObj);
      toast.error(errorObj.message || 'Failed to create version');
    } finally {
      setIsCreatingVersion(false);
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
      if (res.ok) {
        setVideo((prev) => {
          if (!prev) return prev;
          const remaining = prev.versions.filter((v) => v.id !== versionToDelete);
          return { ...prev, versions: remaining };
        });

        if (activeVersionId === versionToDelete) {
          setVideo((prev) => {
            if (!prev) return prev;
            const remaining = prev.versions.filter((v) => v.id !== versionToDelete);
            if (remaining.length > 0) {
              setActiveVersionId(remaining[0].id);
            } else {
              setActiveVersionId(null);
            }
            return prev;
          });
        }

        setShowDeleteVersionDialog(false);
        setVersionToDelete(null);
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to delete version');
      }
    } catch {
      toast.error('Failed to delete version');
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
    versionToDelete,
    setVersionToDelete,
    isDeletingVersion,
    handleDeleteVersion,
  };
}
