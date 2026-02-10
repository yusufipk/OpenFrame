'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, Loader2, Link as LinkIcon, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { parseVideoUrl, fetchVideoMetadata, getThumbnailUrl, type VideoSource } from '@/lib/video-providers';

export default function NewVideoPage() {
  const router = useRouter();
  const params = useParams();
  const projectId = params.projectId as string;

  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingMeta, setIsFetchingMeta] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoSource, setVideoSource] = useState<VideoSource | null>(null);
  const [urlError, setUrlError] = useState('');
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!videoSource) {
      setUrlError('Please enter a valid video URL');
      return;
    }

    setIsLoading(true);
    setSubmitError('');

    try {
      const thumbnailUrl = getThumbnailUrl(videoSource, 'large');
      const title = formData.title.trim() || videoSource.metadata?.title || 'Untitled Video';

      const response = await fetch(`/api/projects/${projectId}/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: formData.description.trim() || null,
          videoUrl: videoSource.originalUrl,
          providerId: videoSource.providerId,
          videoId: videoSource.videoId,
          thumbnailUrl,
          duration: videoSource.metadata?.duration || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        setSubmitError(data.error || 'Failed to add video');
        return;
      }

      router.push(`/projects/${projectId}`);
    } catch (error) {
      console.error('Failed to add video:', error);
      setSubmitError('An unexpected error occurred');
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
            Paste a video link to add it to your project. Currently supports YouTube and Vimeo.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Video URL Input */}
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

            {/* Video Preview */}
            {thumbnailUrl && videoSource && (
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

            <div className="flex gap-3">
              <Button type="submit" disabled={isLoading || !videoSource}>
                {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Add Video
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
