import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  ArrowLeft,
  Plus,
  Settings,
  Share2,
  Play,
  Globe,
  Lock,
  UserPlus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { VideoCard } from '@/components/video-card';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

function VisibilityIcon({ visibility }: { visibility: string }) {
  switch (visibility) {
    case 'PUBLIC':
      return <Globe className="h-3.5 w-3.5" />;
    case 'INVITE':
      return <UserPlus className="h-3.5 w-3.5" />;
    default:
      return <Lock className="h-3.5 w-3.5" />;
  }
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

interface ProjectPageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const session = await auth();
  const { projectId } = await params;

  // Fetch project with videos
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: {
      owner: { select: { id: true, name: true } },
      members: {
        where: { userId: session?.user?.id || '' },
        select: { role: true },
      },
      videos: {
        orderBy: { position: 'asc' },
        include: {
          versions: {
            where: { isActive: true },
            take: 1,
            include: {
              _count: { select: { comments: true } },
            },
          },
          _count: { select: { versions: true } },
        },
      },
    },
  });

  if (!project) {
    notFound();
  }

  // Check access
  const isOwner = session?.user?.id === project.ownerId;
  const isMember = project.members.length > 0;
  const isPublicOrLink = project.visibility !== 'PRIVATE';

  if (!isOwner && !isMember && !isPublicOrLink) {
    redirect('/dashboard');
  }

  // Transform videos for VideoCard component
  const videos = project.videos.map((video) => {
    const activeVersion = video.versions[0];
    return {
      id: video.id,
      title: video.title,
      thumbnailUrl: activeVersion?.thumbnailUrl || 'https://via.placeholder.com/320x180?text=No+Thumbnail',
      currentVersion: video._count.versions,
      commentCount: activeVersion?._count.comments || 0,
      duration: formatDuration(activeVersion?.duration),
      lastUpdated: formatRelativeTime(video.updatedAt),
    };
  });

  const canEdit = isOwner || project.members[0]?.role === 'ADMIN' || project.members[0]?.role === 'EDITOR';

  return (
    <div className="px-6 lg:px-8 py-8 w-full">
      {/* Back link */}
      <div className="mb-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Projects
        </Link>
      </div>

      {/* Project Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
            <Badge variant="outline" className="flex items-center gap-1">
              <VisibilityIcon visibility={project.visibility} />
              {project.visibility.toLowerCase()}
            </Badge>
          </div>
          {project.description && (
            <p className="text-muted-foreground">{project.description}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/projects/${projectId}/share`}>
              <Share2 className="h-4 w-4 mr-2" />
              Share
            </Link>
          </Button>
          {(isOwner || project.members[0]?.role === 'ADMIN') && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/projects/${projectId}/settings`}>
                <Settings className="h-4 w-4 mr-2" />
                Settings
              </Link>
            </Button>
          )}
          {canEdit && (
            <Button size="sm" asChild>
              <Link href={`/projects/${projectId}/videos/new`}>
                <Plus className="h-4 w-4 mr-2" />
                Add Video
              </Link>
            </Button>
          )}
        </div>
      </div>

      {/* Videos Grid */}
      {videos.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {videos.map((video) => (
            <VideoCard key={video.id} video={video} projectId={projectId} />
          ))}
        </div>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Play className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No videos yet</h3>
            <p className="text-muted-foreground text-center mb-4">
              Add your first video to start collecting feedback
            </p>
            {canEdit && (
              <Button asChild>
                <Link href={`/projects/${projectId}/videos/new`}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Video
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
