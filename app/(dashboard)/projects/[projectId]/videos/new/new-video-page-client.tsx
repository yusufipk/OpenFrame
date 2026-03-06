'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, Loader2, Link as LinkIcon, AlertCircle, CheckCircle2, UploadCloud, FileVideo } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { parseVideoUrl, fetchVideoMetadata, getThumbnailUrl, type VideoSource } from '@/lib/video-providers';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import * as tus from 'tus-js-client';

const VIDEO_FILE_EXTENSIONS = ['mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv'];

function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  const extension = file.name.split('.').pop()?.toLowerCase();
  return !!extension && VIDEO_FILE_EXTENSIONS.includes(extension);
}

export default function NewVideoPageClient({ projectId }: { projectId: string }) {
  const router = useRouter();
  const bunnyCdnHostname = resolvePublicBunnyCdnHostname();

  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingMeta, setIsFetchingMeta] = useState(false);

  // URL Mode State
  const [videoUrl, setVideoUrl] = useState('');
  const [videoSource, setVideoSource] = useState<VideoSource | null>(null);
  const [urlError, setUrlError] = useState('');

  // Upload Mode State
  const [uploadMode, setUploadMode] = useState<'url' | 'file'>('url');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('');
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [pendingBunnyVideoId, setPendingBunnyVideoId] = useState<string | null>(null);
  const [pendingBunnyUploadToken, setPendingBunnyUploadToken] = useState<string | null>(null);
  const pendingBunnyVideoIdRef = useRef<string | null>(null);
  const pendingBunnyUploadTokenRef = useRef<string | null>(null);
  const activeTusUploadRef = useRef<tus.Upload | null>(null);
  const fileDragDepthRef = useRef(0);

  const [submitError, setSubmitError] = useState('');
  const [formData, setFormData] = useState({
    title: '',
    description: '',
  });
  const isUploadingFile = isLoading && uploadMode === 'file';
  const leaveWarningMessage = 'A video upload is in progress. Leaving this page will interrupt it. Do you want to leave?';

  useEffect(() => {
    pendingBunnyVideoIdRef.current = pendingBunnyVideoId;
  }, [pendingBunnyVideoId]);

  useEffect(() => {
    pendingBunnyUploadTokenRef.current = pendingBunnyUploadToken;
  }, [pendingBunnyUploadToken]);

  const cleanupPendingBunnyVideo = useCallback(async (videoId: string, uploadToken: string, keepalive = false) => {
    try {
      await fetch(`/api/projects/${projectId}/videos/bunny-init`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, uploadToken }),
        keepalive,
      });
    } catch (error) {
      console.error('Failed to cleanup pending Bunny upload:', error);
    } finally {
      if (pendingBunnyVideoIdRef.current === videoId) {
        pendingBunnyVideoIdRef.current = null;
        setPendingBunnyVideoId(null);
      }
      if (pendingBunnyUploadTokenRef.current === uploadToken) {
        pendingBunnyUploadTokenRef.current = null;
        setPendingBunnyUploadToken(null);
      }
    }
  }, [projectId]);

  const abortAndCleanupPendingUpload = useCallback((keepalive = false) => {
    const pendingVideoId = pendingBunnyVideoIdRef.current;
    const pendingUploadToken = pendingBunnyUploadTokenRef.current;
    if (!pendingVideoId || !pendingUploadToken) return;

    if (activeTusUploadRef.current) {
      try {
        activeTusUploadRef.current.abort(true);
      } catch {
        // Ignore abort failures; we'll still attempt cleanup.
      } finally {
        activeTusUploadRef.current = null;
      }
    }

    void cleanupPendingBunnyVideo(pendingVideoId, pendingUploadToken, keepalive);
  }, [cleanupPendingBunnyVideo]);

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
  }, [abortAndCleanupPendingUpload, isUploadingFile]);

  // Auto-fetch metadata when a valid video source is detected
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!isVideoFile(file)) {
        setSubmitError('Please select a valid video file.');
        return;
      }
      setSelectedFile(file);
      setSubmitError('');
      if (!formData.title) {
        // Strip extension from filename for default title
        const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
        setFormData((prev) => ({ ...prev, title: nameWithoutExt }));
      }
    }
  };

  const setSelectedVideoFile = useCallback((file: File) => {
    if (!isVideoFile(file)) {
      setSubmitError('Please select a valid video file.');
      return;
    }

    setSelectedFile(file);
    setSubmitError('');

    if (!formData.title) {
      const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
      setFormData((prev) => ({ ...prev, title: nameWithoutExt }));
    }
  }, [formData.title]);

  const handleFileDragEnter = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    if (isLoading) return;
    fileDragDepthRef.current += 1;
    if (Array.from(event.dataTransfer.types).includes('Files')) {
      setIsFileDragOver(true);
    }
  }, [isLoading]);

  const handleFileDragOver = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    if (isLoading) return;
    event.dataTransfer.dropEffect = 'copy';
    if (Array.from(event.dataTransfer.types).includes('Files')) {
      setIsFileDragOver(true);
    }
  }, [isLoading]);

  const handleFileDragLeave = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) {
      setIsFileDragOver(false);
    }
  }, []);

  const handleFileDrop = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    fileDragDepthRef.current = 0;
    setIsFileDragOver(false);
    if (isLoading) return;

    const file = Array.from(event.dataTransfer.files)[0];
    if (!file) return;
    setSelectedVideoFile(file);
  }, [isLoading, setSelectedVideoFile]);

  const uploadToBunny = async (
    file: File
  ): Promise<{ videoId: string; libraryId: string; providerId: string; url: string; uploadToken: string }> => {
    // 1. Initialize Bunny Stream upload (creates video & gets signature)
    setUploadStatus('Initializing upload...');
    const initRes = await fetch(`/api/projects/${projectId}/videos/bunny-init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: formData.title || file.name })
    });

    if (!initRes.ok) {
      const data = await initRes.json();
      throw new Error(data.error || 'Failed to initialize upload');
    }

    const { data: { videoId, libraryId, signature, expirationTime, uploadToken } } = await initRes.json();
    setPendingBunnyVideoId(videoId);
    setPendingBunnyUploadToken(uploadToken);
    pendingBunnyVideoIdRef.current = videoId;
    pendingBunnyUploadTokenRef.current = uploadToken;

    // 2. Upload via TUS
    return new Promise((resolve, reject) => {
      setUploadStatus('Uploading video...');
      const upload = new tus.Upload(file, {
        endpoint: 'https://video.bunnycdn.com/tusupload',
        retryDelays: [0, 3000, 5000, 10000, 20000],
        headers: {
          AuthorizationSignature: signature,
          AuthorizationExpire: expirationTime.toString(),
          VideoId: videoId,
          LibraryId: libraryId,
        },
        metadata: {
          filetype: file.type,
          title: formData.title || file.name,
        },
        onError: (error) => {
          activeTusUploadRef.current = null;
          reject(new Error('Upload failed: ' + error.message));
        },
        onProgress: (bytesUploaded, bytesTotal) => {
          const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(1);
          setUploadProgress(Number(percentage));
          setUploadStatus(`Uploading... ${percentage}%`);
        },
        onSuccess: () => {
          activeTusUploadRef.current = null;
          setUploadStatus('Processing video...');
          resolve({
            videoId,
            libraryId,
            providerId: 'bunny',
            url: `https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}`,
            uploadToken,
          });
        },
      });
      activeTusUploadRef.current = upload;
      upload.start();
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setIsLoading(true);
    setSubmitError('');
    setUploadStatus('');
    setUploadProgress(0);

    try {
      let uploadedBunnyVideoId: string | null = null;
      let uploadedBunnyUploadToken: string | null = null;
      let finalTitle = formData.title.trim();
      const finalDescription = formData.description.trim() || null;
      let finalVideoUrl = '';
      let finalProviderId = '';
      let finalVideoId = '';
      let finalThumbnailUrl: string | null = null;
      let finalDuration: number | null = null;

      if (uploadMode === 'url') {
        if (!videoSource) {
          setUrlError('Please enter a valid video URL');
          setIsLoading(false);
          return;
        }
        finalTitle = finalTitle || videoSource.metadata?.title || 'Untitled Video';
        finalVideoUrl = videoSource.originalUrl;
        finalProviderId = videoSource.providerId;
        finalVideoId = videoSource.videoId;
        finalThumbnailUrl = getThumbnailUrl(videoSource, 'large');
        finalDuration = videoSource.metadata?.duration || null;
      } else {
        if (!selectedFile) {
          setSubmitError('Please select a video file to upload');
          setIsLoading(false);
          return;
        }
        finalTitle = finalTitle || selectedFile.name;

        // Handle TUS Upload
        const bunnyData = await uploadToBunny(selectedFile);
        uploadedBunnyVideoId = bunnyData.videoId;
        uploadedBunnyUploadToken = bunnyData.uploadToken;

        finalVideoUrl = bunnyData.url;
        finalProviderId = bunnyData.providerId;
        finalVideoId = bunnyData.videoId;
        // Bunny will generate thumbnails automatically after processing.
        // We'll just provide the standard CDN thumbnail URL format as fallback.
        finalThumbnailUrl = bunnyCdnHostname
          ? `https://${bunnyCdnHostname}/${bunnyData.videoId}/thumbnail.jpg`
          : null;
      }

      // Final POST to our database
      const response = await fetch(`/api/projects/${projectId}/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: finalTitle,
          description: finalDescription,
          videoUrl: finalVideoUrl,
          providerId: finalProviderId,
          videoId: finalVideoId,
          thumbnailUrl: finalThumbnailUrl,
          duration: finalDuration,
          uploadToken: uploadedBunnyUploadToken,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        setSubmitError(data.error || 'Failed to add video');
        if (uploadedBunnyVideoId && uploadedBunnyUploadToken) {
          await cleanupPendingBunnyVideo(uploadedBunnyVideoId, uploadedBunnyUploadToken);
        }
        return;
      }

      pendingBunnyVideoIdRef.current = null;
      pendingBunnyUploadTokenRef.current = null;
      setPendingBunnyVideoId(null);
      setPendingBunnyUploadToken(null);
      router.push(`/projects/${projectId}`);
    } catch (error: unknown) {
      console.error('Failed to add video:', error);
      setSubmitError(error instanceof Error ? error.message : 'An unexpected error occurred');
      if (pendingBunnyVideoIdRef.current && pendingBunnyUploadTokenRef.current) {
        await cleanupPendingBunnyVideo(pendingBunnyVideoIdRef.current, pendingBunnyUploadTokenRef.current);
      }
    } finally {
      activeTusUploadRef.current = null;
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
            Paste a video link or upload a file directly to add it to your project. Currently supports YouTube.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={uploadMode} onValueChange={(v) => !isLoading && setUploadMode(v as 'url' | 'file')} className="mb-6">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="url" disabled={isLoading}>Paste URL</TabsTrigger>
              <TabsTrigger value="file" disabled={isLoading}>Direct Upload</TabsTrigger>
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
                    {videoSource.providerId.charAt(0).toUpperCase() + videoSource.providerId.slice(1)} video detected
                    {isFetchingMeta && ' — fetching metadata...'}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="file">Video File</Label>
                <div className="flex items-center justify-center w-full">
                  <label
                    htmlFor="file"
                    onDragEnter={handleFileDragEnter}
                    onDragOver={handleFileDragOver}
                    onDragLeave={handleFileDragLeave}
                    onDrop={handleFileDrop}
                    className={`flex flex-col items-center justify-center w-full h-40 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
                      isFileDragOver
                        ? 'border-primary bg-primary/10'
                        : selectedFile
                          ? 'border-primary bg-muted/30 hover:bg-muted/50'
                          : 'border-border bg-muted/30 hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex flex-col items-center justify-center pt-5 pb-6">
                      {selectedFile ? (
                        <>
                          <FileVideo className="w-10 h-10 mb-3 text-primary" />
                          <p className="mb-2 text-sm text-foreground font-medium">{selectedFile.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
                          </p>
                        </>
                      ) : (
                        <>
                          <UploadCloud className="w-10 h-10 mb-3 text-muted-foreground" />
                          <p className="mb-2 text-sm text-muted-foreground">
                            <span className="font-semibold">Click to upload</span> or drag and drop
                          </p>
                          <p className="text-xs text-muted-foreground">MP4, WebM, or OGG</p>
                        </>
                      )}
                    </div>
                    <input id="file" type="file" accept="video/*" className="hidden" onChange={handleFileChange} disabled={isLoading} />
                  </label>
                </div>
              </div>
            )}

            {/* Video Preview (Only for URL mode) */}
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

            {/* Title */}
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                placeholder={isFetchingMeta ? 'Fetching title...' : 'Video title (will auto-fill from video if empty)'}
                value={formData.title}
                onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
                disabled={isLoading}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to use the original video title
              </p>
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Textarea
                id="description"
                placeholder="Add context about this video..."
                value={formData.description}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                rows={3}
                disabled={isLoading}
              />
            </div>

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
                    <div className="bg-primary h-2 rounded-full transition-all" style={{ width: `${uploadProgress}%` }}></div>
                  </div>
                )}
                {isUploadingFile && (
                  <p className="text-xs text-amber-500">
                    Do not close, refresh, or navigate away while the upload is in progress.
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={isLoading || (uploadMode === 'url' && !videoSource) || (uploadMode === 'file' && !selectedFile)}>
                {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Add Video
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()} disabled={isLoading}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
