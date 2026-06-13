'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import {
  ArrowLeft,
  Loader2,
  Link as LinkIcon,
  AlertCircle,
  CheckCircle2,
  UploadCloud,
  FileVideo,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  parseVideoUrl,
  fetchVideoMetadata,
  getThumbnailUrl,
  type VideoSource,
} from '@/lib/video-providers';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import {
  cleanupPendingProjectUpload,
  getDefaultTitleFromFile,
  isVideoFile,
  uploadProjectVideo,
  type ActiveTusUpload,
  type PendingProjectUploadCleanup,
} from '@/lib/client/project-video-upload';
import type { DirectUploadProvider } from '@/components/video-page/types';

export default function NewVideoPageClient({
  projectId,
  directUploadsEnabled,
  directUploadProvider,
}: {
  projectId: string;
  directUploadsEnabled: boolean;
  directUploadProvider: DirectUploadProvider;
}) {
  const router = useRouter();
  const bunnyCdnHostname = resolvePublicBunnyCdnHostname();

  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingMeta, setIsFetchingMeta] = useState(false);

  const [videoUrl, setVideoUrl] = useState('');
  const [videoSource, setVideoSource] = useState<VideoSource | null>(null);
  const [urlError, setUrlError] = useState('');

  const [uploadMode, setUploadMode] = useState<'url' | 'file'>('url');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('');
  const [currentUploadIndex, setCurrentUploadIndex] = useState(0);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const activeTusUploadRef = useRef<ActiveTusUpload | null>(null);
  const pendingUploadRef = useRef<PendingProjectUploadCleanup | null>(null);
  const cancelRequestedRef = useRef(false);
  const fileDragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [submitError, setSubmitError] = useState('');
  const [formData, setFormData] = useState({
    title: '',
    description: '',
  });
  const isUploadingFile = isLoading && uploadMode === 'file';
  const isMultiFileUpload = selectedFiles.length > 1;
  const leaveWarningMessage =
    'A video upload is in progress. Leaving this page will interrupt it. Do you want to leave?';

  const abortAndCleanupPendingUpload = useCallback(
    (keepalive = false) => {
      cancelRequestedRef.current = true;

      if (activeTusUploadRef.current) {
        try {
          void Promise.resolve(activeTusUploadRef.current.abort(false));
        } catch {
          // Ignore abort failures.
        } finally {
          activeTusUploadRef.current = null;
        }
      }

      const pending = pendingUploadRef.current;
      if (pending) {
        void cleanupPendingProjectUpload(projectId, pending, keepalive);
        pendingUploadRef.current = null;
      }
    },
    [projectId]
  );

  useEffect(() => {
    if (!isUploadingFile) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    const handlePageHide = () => {
      abortAndCleanupPendingUpload(true);
    };

    const handlePopState = () => {
      const shouldLeave = window.confirm(leaveWarningMessage);
      if (!shouldLeave) {
        window.history.pushState(null, '', window.location.href);
        return;
      }
      abortAndCleanupPendingUpload(true);
    };

    window.history.pushState(null, '', window.location.href);
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('popstate', handlePopState);
    };
  }, [abortAndCleanupPendingUpload, isUploadingFile, leaveWarningMessage]);

  useEffect(() => {
    if (!videoSource) return;

    let cancelled = false;
    setIsFetchingMeta(true);

    fetchVideoMetadata(videoSource).then((meta) => {
      if (cancelled || !meta) {
        setIsFetchingMeta(false);
        return;
      }
      if (!formData.title) {
        setFormData((prev) => ({ ...prev, title: meta.title }));
      }
      setVideoSource((prev) => (prev ? { ...prev, metadata: meta } : prev));
      setIsFetchingMeta(false);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoSource?.videoId, videoSource?.providerId]);

  const handleUrlChange = (url: string) => {
    setVideoUrl(url);
    setUrlError('');
    setSubmitError('');

    if (!url.trim()) {
      setVideoSource(null);
      return;
    }

    const source = parseVideoUrl(url);
    if (source) {
      setVideoSource(source);
    } else {
      setVideoSource(null);
      if (url.length > 10) {
        setUrlError('Could not recognize this video URL. Currently supported: YouTube, Vimeo');
      }
    }
  };

  const addSelectedFiles = useCallback(
    (incoming: File[]) => {
      const validFiles: File[] = [];
      let invalidCount = 0;

      for (const file of incoming) {
        if (!isVideoFile(file)) {
          invalidCount += 1;
          continue;
        }
        validFiles.push(file);
      }

      if (validFiles.length === 0) {
        setSubmitError('Please select valid video files.');
        return;
      }

      if (invalidCount > 0) {
        setSubmitError(
          `${invalidCount} file${invalidCount === 1 ? '' : 's'} skipped (not a video).`
        );
      } else {
        setSubmitError('');
      }

      setSelectedFiles((prev) => {
        const next = [...prev];
        for (const file of validFiles) {
          const duplicate = next.some(
            (existing) =>
              existing.name === file.name &&
              existing.size === file.size &&
              existing.lastModified === file.lastModified
          );
          if (!duplicate) next.push(file);
        }
        return next;
      });

      if (validFiles.length === 1 && !formData.title) {
        setFormData((prev) => ({
          ...prev,
          title: getDefaultTitleFromFile(validFiles[0]),
        }));
      }
    },
    [formData.title]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      addSelectedFiles(files);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeSelectedFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleFileDragEnter = useCallback(
    (event: React.DragEvent<HTMLLabelElement>) => {
      event.preventDefault();
      if (isLoading) return;
      fileDragDepthRef.current += 1;
      if (Array.from(event.dataTransfer.types).includes('Files')) {
        setIsFileDragOver(true);
      }
    },
    [isLoading]
  );

  const handleFileDragOver = useCallback(
    (event: React.DragEvent<HTMLLabelElement>) => {
      event.preventDefault();
      if (isLoading) return;
      event.dataTransfer.dropEffect = 'copy';
      if (Array.from(event.dataTransfer.types).includes('Files')) {
        setIsFileDragOver(true);
      }
    },
    [isLoading]
  );

  const handleFileDragLeave = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) {
      setIsFileDragOver(false);
    }
  }, []);

  const handleFileDrop = useCallback(
    (event: React.DragEvent<HTMLLabelElement>) => {
      event.preventDefault();
      fileDragDepthRef.current = 0;
      setIsFileDragOver(false);
      if (isLoading) return;

      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;
      addSelectedFiles(files);
    },
    [addSelectedFiles, isLoading]
  );

  const uploadSingleFileWithForm = async (file: File) => {
    cancelRequestedRef.current = false;
    pendingUploadRef.current = null;

    const title = formData.title.trim() || getDefaultTitleFromFile(file);
    const description = formData.description.trim() || null;

    await uploadProjectVideo(projectId, file, {
      provider: directUploadProvider,
      title,
      description,
      bunnyCdnHostname,
      onProgress: (progress) => {
        setUploadProgress(progress);
        setUploadStatus(`Uploading... ${progress}%`);
      },
      onStatus: setUploadStatus,
      onTusUploadReady: (upload) => {
        activeTusUploadRef.current = upload;
      },
      onPendingUpload: (pending) => {
        pendingUploadRef.current = pending;
      },
      isCancelled: () => cancelRequestedRef.current,
    });

    pendingUploadRef.current = null;
    activeTusUploadRef.current = null;
  };

  const uploadMultipleFiles = async (files: File[]) => {
    cancelRequestedRef.current = false;
    let successCount = 0;
    let failCount = 0;

    for (let index = 0; index < files.length; index++) {
      if (cancelRequestedRef.current) break;

      const file = files[index];
      setCurrentUploadIndex(index + 1);
      setUploadProgress(0);
      setUploadStatus(`Uploading ${index + 1} of ${files.length}: ${file.name}`);

      try {
        await uploadProjectVideo(projectId, file, {
          provider: directUploadProvider,
          bunnyCdnHostname,
          onProgress: (progress) => {
            setUploadProgress(progress);
            setUploadStatus(
              `Uploading ${index + 1} of ${files.length}: ${file.name} (${progress}%)`
            );
          },
          onStatus: (status) => {
            setUploadStatus(`Uploading ${index + 1} of ${files.length}: ${status}`);
          },
          onTusUploadReady: (upload) => {
            activeTusUploadRef.current = upload;
          },
          onPendingUpload: (pending) => {
            pendingUploadRef.current = pending;
          },
          isCancelled: () => cancelRequestedRef.current,
        });

        pendingUploadRef.current = null;
        activeTusUploadRef.current = null;
        successCount += 1;
      } catch (error) {
        pendingUploadRef.current = null;
        activeTusUploadRef.current = null;
        failCount += 1;
        const message = error instanceof Error ? error.message : 'Upload failed';
        setSubmitError(`${file.name}: ${message}`);
      }
    }

    if (successCount > 0 && failCount === 0) {
      router.push(`/projects/${projectId}`);
      return;
    }

    if (successCount > 0 && failCount > 0) {
      setSubmitError(
        `${successCount} uploaded, ${failCount} failed. Remove failed files and retry.`
      );
      return;
    }

    if (failCount > 0 && successCount === 0) {
      throw new Error('All uploads failed');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setIsLoading(true);
    setSubmitError('');
    setUploadStatus('');
    setUploadProgress(0);
    setCurrentUploadIndex(0);

    try {
      if (uploadMode === 'url') {
        if (!videoSource) {
          setUrlError('Please enter a valid video URL');
          setIsLoading(false);
          return;
        }

        const finalTitle = formData.title.trim() || videoSource.metadata?.title || 'Untitled Video';
        const finalDescription = formData.description.trim() || null;

        const response = await fetch(`/api/projects/${projectId}/videos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: finalTitle,
            description: finalDescription,
            videoUrl: videoSource.originalUrl,
            providerId: videoSource.providerId,
            videoId: videoSource.videoId,
            thumbnailUrl: getThumbnailUrl(videoSource, 'large'),
            duration: videoSource.metadata?.duration || null,
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          setSubmitError(data.error || 'Failed to add video');
          return;
        }

        router.push(`/projects/${projectId}`);
        return;
      }

      if (!directUploadsEnabled) {
        throw new Error('Direct uploads are disabled by this host');
      }

      if (selectedFiles.length === 0) {
        setSubmitError('Please select at least one video file to upload');
        setIsLoading(false);
        return;
      }

      if (selectedFiles.length === 1) {
        await uploadSingleFileWithForm(selectedFiles[0]);
        router.push(`/projects/${projectId}`);
        return;
      }

      await uploadMultipleFiles(selectedFiles);
    } catch (error: unknown) {
      console.error('Failed to add video:', error);
      setSubmitError(error instanceof Error ? error.message : 'An unexpected error occurred');
    } finally {
      activeTusUploadRef.current = null;
      pendingUploadRef.current = null;
      setIsLoading(false);
    }
  };

  const thumbnailUrl = videoSource ? getThumbnailUrl(videoSource, 'large') : null;

  return (
    <div className="container max-w-2xl mx-auto py-8">
      <div className="mb-6">
        <Link
          href={`/projects/${projectId}`}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          onClick={(event) => {
            if (!isUploadingFile) return;
            const shouldLeave = window.confirm(leaveWarningMessage);
            if (!shouldLeave) {
              event.preventDefault();
              return;
            }
            abortAndCleanupPendingUpload(true);
          }}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Project
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add Video</CardTitle>
          <CardDescription>
            {directUploadsEnabled
              ? 'Paste a video link or upload one or more files directly to add them to your project.'
              : 'Paste a video link to add it to your project. Direct uploads are disabled on this host.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs
            value={uploadMode}
            onValueChange={(v) => !isLoading && setUploadMode(v as 'url' | 'file')}
            className="mb-6"
          >
            <TabsList
              className={`grid w-full ${directUploadsEnabled ? 'grid-cols-2' : 'grid-cols-1'}`}
            >
              <TabsTrigger value="url" disabled={isLoading}>
                Paste URL
              </TabsTrigger>
              {directUploadsEnabled ? (
                <TabsTrigger value="file" disabled={isLoading}>
                  Direct Upload
                </TabsTrigger>
              ) : null}
            </TabsList>
          </Tabs>

          <form onSubmit={handleSubmit} className="space-y-6">
            {uploadMode === 'url' ? (
              <div className="space-y-2">
                <Label htmlFor="url">Video URL</Label>
                <div className="relative">
                  <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="url"
                    placeholder="https://youtube.com/watch?v=..."
                    value={videoUrl}
                    onChange={(e) => handleUrlChange(e.target.value)}
                    className="pl-10"
                    required
                    disabled={isLoading}
                  />
                </div>

                {urlError && (
                  <p className="text-sm text-destructive flex items-center gap-1">
                    <AlertCircle className="h-4 w-4" />
                    {urlError}
                  </p>
                )}

                {videoSource && (
                  <p className="text-sm text-green-600 flex items-center gap-1">
                    <CheckCircle2 className="h-4 w-4" />
                    {videoSource.providerId.charAt(0).toUpperCase() +
                      videoSource.providerId.slice(1)}{' '}
                    video detected
                    {isFetchingMeta && ' — fetching metadata...'}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="file">Video Files</Label>
                <div className="flex items-center justify-center w-full">
                  <label
                    htmlFor="file"
                    onDragEnter={handleFileDragEnter}
                    onDragOver={handleFileDragOver}
                    onDragLeave={handleFileDragLeave}
                    onDrop={handleFileDrop}
                    className={`flex flex-col items-center justify-center w-full min-h-40 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
                      isFileDragOver
                        ? 'border-primary bg-primary/10'
                        : selectedFiles.length > 0
                          ? 'border-primary bg-muted/30 hover:bg-muted/50'
                          : 'border-border bg-muted/30 hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex flex-col items-center justify-center pt-5 pb-6 px-4 w-full">
                      {selectedFiles.length === 0 ? (
                        <>
                          <UploadCloud className="w-10 h-10 mb-3 text-muted-foreground" />
                          <p className="mb-2 text-sm text-muted-foreground text-center">
                            <span className="font-semibold">Click to upload</span> or drag and drop
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Multiple videos supported · MP4, WebM, MOV, and more
                          </p>
                        </>
                      ) : selectedFiles.length === 1 ? (
                        <>
                          <FileVideo className="w-10 h-10 mb-3 text-primary" />
                          <p className="mb-2 text-sm text-foreground font-medium">
                            {selectedFiles[0].name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {(selectedFiles[0].size / (1024 * 1024)).toFixed(2)} MB
                          </p>
                        </>
                      ) : (
                        <>
                          <FileVideo className="w-10 h-10 mb-3 text-primary" />
                          <p className="mb-2 text-sm text-foreground font-medium">
                            {selectedFiles.length} videos selected
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Click or drop to add more files
                          </p>
                        </>
                      )}
                    </div>
                    <input
                      ref={fileInputRef}
                      id="file"
                      type="file"
                      accept="video/*"
                      multiple
                      className="hidden"
                      onChange={handleFileChange}
                      disabled={isLoading}
                    />
                  </label>
                </div>

                {selectedFiles.length > 1 && (
                  <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                    {selectedFiles.map((file, index) => (
                      <div
                        key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                        className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0"
                      >
                        <FileVideo className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{file.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {getDefaultTitleFromFile(file)} ·{' '}
                            {(file.size / (1024 * 1024)).toFixed(2)} MB
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          disabled={isLoading}
                          onClick={() => removeSelectedFile(index)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {uploadMode === 'url' && thumbnailUrl && videoSource && (
              <div className="space-y-2">
                <Label>Preview</Label>
                <div className="relative aspect-video rounded-lg overflow-hidden bg-muted">
                  <Image
                    src={thumbnailUrl}
                    alt="Video thumbnail"
                    fill
                    sizes="(max-width: 768px) 100vw, 600px"
                    className="object-cover"
                  />
                </div>
              </div>
            )}

            {uploadMode === 'url' || selectedFiles.length <= 1 ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="title">Title</Label>
                  <Input
                    id="title"
                    placeholder={
                      isFetchingMeta
                        ? 'Fetching title...'
                        : uploadMode === 'file' && isMultiFileUpload
                          ? 'Not used for multi-file uploads'
                          : 'Video title (will auto-fill from video if empty)'
                    }
                    value={formData.title}
                    onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
                    disabled={isLoading || (uploadMode === 'file' && isMultiFileUpload)}
                  />
                  {uploadMode === 'file' && isMultiFileUpload ? (
                    <p className="text-xs text-muted-foreground">
                      Each file will use its filename as the title.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Leave empty to use the original video title
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description (optional)</Label>
                  <Textarea
                    id="description"
                    placeholder="Add context about this video..."
                    value={formData.description}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, description: e.target.value }))
                    }
                    rows={3}
                    disabled={isLoading || (uploadMode === 'file' && isMultiFileUpload)}
                  />
                  {uploadMode === 'file' && isMultiFileUpload ? (
                    <p className="text-xs text-muted-foreground">
                      Descriptions are not applied in bulk upload mode.
                    </p>
                  ) : null}
                </div>
              </>
            ) : null}

            {submitError && (
              <p className="text-sm text-destructive flex items-center gap-1">
                <AlertCircle className="h-4 w-4" />
                {submitError}
              </p>
            )}

            {uploadStatus && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{uploadStatus}</p>
                {uploadProgress > 0 && uploadProgress < 100 && (
                  <div className="w-full bg-secondary rounded-full h-2">
                    <div
                      className="bg-primary h-2 rounded-full transition-all"
                      style={{ width: `${uploadProgress}%` }}
                    ></div>
                  </div>
                )}
                {isUploadingFile && (
                  <p className="text-xs text-amber-500">
                    Do not close, refresh, or navigate away while uploads are in progress.
                    {isMultiFileUpload && currentUploadIndex > 0
                      ? ` (${currentUploadIndex} of ${selectedFiles.length})`
                      : ''}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                disabled={
                  isLoading ||
                  (uploadMode === 'url' && !videoSource) ||
                  (uploadMode === 'file' && selectedFiles.length === 0)
                }
              >
                {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {uploadMode === 'file' && selectedFiles.length > 1
                  ? `Upload ${selectedFiles.length} Videos`
                  : 'Add Video'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.back()}
                disabled={isLoading}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
