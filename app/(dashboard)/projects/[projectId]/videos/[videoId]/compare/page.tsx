'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  MessageSquare,
  ChevronDown,
  Loader2,
  GitCompareArrows,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

interface Version {
  id: string;
  versionNumber: number;
  versionLabel: string | null;
  providerId: string;
  videoId: string;
  originalUrl: string;
  title: string | null;
  thumbnailUrl: string | null;
  duration: number | null;
  isActive: boolean;
  _count: { comments: number };
}

interface VideoData {
  id: string;
  title: string;
  description: string | null;
  projectId: string;
  project: {
    name: string;
  };
  versions: Version[];
}

function getEmbedUrl(version: Version) {
  if (version.providerId === 'youtube') {
    return `https://www.youtube.com/embed/${version.videoId}?enablejsapi=1&rel=0&modestbranding=1`;
  }
  if (version.providerId === 'vimeo') {
    return `https://player.vimeo.com/video/${version.videoId}`;
  }
  return version.originalUrl;
}

export default function CompareVersionsPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;
  const videoId = params.videoId as string;

  const [video, setVideo] = useState<VideoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [leftVersionId, setLeftVersionId] = useState<string | null>(null);
  const [rightVersionId, setRightVersionId] = useState<string | null>(null);

  useEffect(() => {
    async function fetchVideo() {
      try {
        const res = await fetch(`/api/projects/${projectId}/videos/${videoId}`);
        if (!res.ok) {
          setError('Failed to load video');
          setLoading(false);
          return;
        }
        const data = await res.json();
        setVideo(data);

        // Set initial versions from query params or defaults
        const leftParam = searchParams.get('left');
        const rightParam = searchParams.get('right');

        if (data.versions.length >= 2) {
          // Sort versions ascending for comparison (older on left, newer on right)
          const sorted = [...data.versions].sort(
            (a: Version, b: Version) => a.versionNumber - b.versionNumber
          );
          setLeftVersionId(
            leftParam && sorted.find((v: Version) => v.id === leftParam)
              ? leftParam
              : sorted[sorted.length - 2].id
          );
          setRightVersionId(
            rightParam && sorted.find((v: Version) => v.id === rightParam)
              ? rightParam
              : sorted[sorted.length - 1].id
          );
        } else if (data.versions.length === 1) {
          setLeftVersionId(data.versions[0].id);
          setRightVersionId(data.versions[0].id);
        }
      } catch {
        setError('Failed to load video');
      } finally {
        setLoading(false);
      }
    }
    fetchVideo();
  }, [projectId, videoId, searchParams]);

  const leftVersion = video?.versions.find((v) => v.id === leftVersionId);
  const rightVersion = video?.versions.find((v) => v.id === rightVersionId);

  if (loading) {
    return (
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        <div className="shrink-0 flex items-center justify-between h-12 px-4 border-b bg-background/50">
          <div className="flex items-center gap-3">
            <Skeleton className="h-4 w-24" />
            <Separator orientation="vertical" className="h-5" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-4 w-24" />
            </div>
          </div>
        </div>
        <div className="flex-1 flex overflow-hidden">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="flex-1 flex flex-col overflow-hidden border-r last:border-r-0">
              <div className="shrink-0 flex items-center justify-center h-10 px-4 border-b bg-muted/30">
                <Skeleton className="h-6 w-40 rounded-md" />
              </div>
              <div className="flex-1 bg-black" />
              <div className="shrink-0 px-4 py-2 bg-background border-t">
                <Skeleton className="h-4 w-24 mx-auto" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error || !video || video.versions.length < 2) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">
            {error || 'Need at least 2 versions to compare'}
          </p>
          <Button asChild variant="outline">
            <Link href={`/projects/${projectId}/videos/${videoId}`}>Back to Video</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between h-12 px-4 border-b bg-background/50">
        <div className="flex items-center gap-3">
          <Link
            href={`/projects/${projectId}/videos/${videoId}`}
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Video
          </Link>
          <Separator orientation="vertical" className="h-5" />
          <div className="flex items-center gap-2">
            <GitCompareArrows className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Compare Versions</span>
            <span className="text-xs text-muted-foreground">• {video.title}</span>
          </div>
        </div>
      </div>

      {/* Side-by-side comparison */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel */}
        <div className="flex-1 flex flex-col border-r">
          <div className="shrink-0 flex items-center justify-between p-3 border-b bg-muted/30">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Badge variant="secondary" className="mr-2">
                    v{leftVersion?.versionNumber}
                  </Badge>
                  {leftVersion?.versionLabel || `Version ${leftVersion?.versionNumber}`}
                  <ChevronDown className="h-4 w-4 ml-2" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {video.versions.map((v) => (
                  <DropdownMenuItem
                    key={v.id}
                    onClick={() => setLeftVersionId(v.id)}
                    disabled={v.id === rightVersionId}
                  >
                    <Badge
                      variant={v.id === leftVersionId ? 'default' : 'secondary'}
                      className="mr-2"
                    >
                      v{v.versionNumber}
                    </Badge>
                    {v.versionLabel || `Version ${v.versionNumber}`}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              {leftVersion?._count.comments || 0} comments
            </div>
          </div>

          <div className="flex-1 bg-black flex items-center justify-center p-2">
            {leftVersion && (
              <iframe
                src={getEmbedUrl(leftVersion)}
                className="w-full h-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            )}
          </div>

          {leftVersion?.duration && (
            <div className="shrink-0 px-3 py-2 border-t text-xs text-muted-foreground text-center">
              Duration: {Math.floor(leftVersion.duration / 60)}:
              {(leftVersion.duration % 60).toString().padStart(2, '0')}
            </div>
          )}
        </div>

        {/* Right panel */}
        <div className="flex-1 flex flex-col">
          <div className="shrink-0 flex items-center justify-between p-3 border-b bg-muted/30">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Badge variant="secondary" className="mr-2">
                    v{rightVersion?.versionNumber}
                  </Badge>
                  {rightVersion?.versionLabel || `Version ${rightVersion?.versionNumber}`}
                  <ChevronDown className="h-4 w-4 ml-2" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {video.versions.map((v) => (
                  <DropdownMenuItem
                    key={v.id}
                    onClick={() => setRightVersionId(v.id)}
                    disabled={v.id === leftVersionId}
                  >
                    <Badge
                      variant={v.id === rightVersionId ? 'default' : 'secondary'}
                      className="mr-2"
                    >
                      v{v.versionNumber}
                    </Badge>
                    {v.versionLabel || `Version ${v.versionNumber}`}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              {rightVersion?._count.comments || 0} comments
            </div>
          </div>

          <div className="flex-1 bg-black flex items-center justify-center p-2">
            {rightVersion && (
              <iframe
                src={getEmbedUrl(rightVersion)}
                className="w-full h-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            )}
          </div>

          {rightVersion?.duration && (
            <div className="shrink-0 px-3 py-2 border-t text-xs text-muted-foreground text-center">
              Duration: {Math.floor(rightVersion.duration / 60)}:
              {(rightVersion.duration % 60).toString().padStart(2, '0')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
