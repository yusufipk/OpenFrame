'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, Loader2, Link as LinkIcon, AlertCircle, CheckCircle2, UploadCloud, FileVideo } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { parseVideoUrl, fetchVideoMetadata, getThumbnailUrl, type VideoSource } from '@/lib/video-providers';
import * as tus from 'tus-js-client';

export default function NewVideoPage() {
  const router = useRouter();
  const params = useParams();
  const projectId = params.projectId as string;

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

  const [submitError, setSubmitError] = useState('');
  const [formData, setFormData] = useState({
    title: '',
    description: '',
  });

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
      if (!file.type.startsWith('video/')) {
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

  const uploadToBunny = async (file: File): Promise<{ videoId: string; libraryId: string; providerId: string; url: string }> => {
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

    const { data: { videoId, libraryId, signature, expirationTime } } = await initRes.json();

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
          reject(new Error('Upload failed: ' + error.message));
        },
        onProgress: (bytesUploaded, bytesTotal) => {
          const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(1);
          setUploadProgress(Number(percentage));
          setUploadStatus(`Uploading... ${percentage}%`);
        },
        onSuccess: () => {
          setUploadStatus('Processing video...');
          resolve({
            videoId,
            libraryId,
            providerId: 'bunny',
            url: `https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}`
          });
        },
      });
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
      let finalTitle = formData.title.trim();
      let finalDescription = formData.description.trim() || null;
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

        finalVideoUrl = bunnyData.url;
        finalProviderId = bunnyData.providerId;
        finalVideoId = bunnyData.videoId;
        // Bunny will generate thumbnails automatically after processing.
        // We'll just provide the standard CDN thumbnail URL format as fallback.
        finalThumbnailUrl = `https://vz-thumbnail.b-cdn.net/${bunnyData.videoId}/thumbnail.jpg`;
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
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        setSubmitError(data.error || 'Failed to add video');
        return;
      }

      router.push(`/projects/${projectId}`);
    } catch (error: any) {
      console.error('Failed to add video:', error);
      setSubmitError(error.message || 'An unexpected error occurred');
    } finally {
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
          <Tabs value={uploadMode} onValueChange={(v) => setUploadMode(v as 'url' | 'file')} className="mb-6">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="url">Paste URL</TabsTrigger>
              <TabsTrigger value="file">Direct Upload</TabsTrigger>
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
                  <label htmlFor="file" className={`flex flex-col items-center justify-center w-full h-40 border-2 border-dashed rounded-lg cursor-pointer bg-muted/30 hover:bg-muted/50 transition-colors ${selectedFile ? 'border-primary' : 'border-border'}`}>
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
