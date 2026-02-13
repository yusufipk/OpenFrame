'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  Plus,
  Settings,
  Share2,
  Play,
  Users,
  Building2,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { VideoCard } from '@/components/video-card';

type SortOrder = 'desc' | 'asc';

interface SerializedVideo {
  id: string;
  title: string;
  thumbnailUrl: string;
  currentVersion: number;
  commentCount: number;
  duration: string;
  lastUpdated: string;
  updatedAt: string;
}

interface ProjectContentClientProps {
  project: {
    name: string;
    description: string | null;
    visibility: string;
    workspace: { id: string; name: string } | null;
    members: { role: string }[];
  };
  projectId: string;
  videos: SerializedVideo[];
  canEdit: boolean;
  isOwner: boolean;
  workspaceRole: string | null;
}

export function ProjectContentClient({
  project,
  projectId,
  videos,
  canEdit,
  isOwner,
  workspaceRole,
}: ProjectContentClientProps) {
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  const sortedVideos = useMemo(() => {
    return [...videos].sort((a, b) => {
      const dateA = new Date(a.updatedAt).getTime();
      const dateB = new Date(b.updatedAt).getTime();
      return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
    });
  }, [videos, sortOrder]);

  return (
    <>
      {/* Project Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
            <Badge variant="outline" className="flex items-center gap-1">
              {project.visibility === 'PUBLIC' && <span className="text-xs">🌐</span>}
              {project.visibility === 'INVITE' && <span className="text-xs">📧</span>}
              {project.visibility === 'PRIVATE' && <span className="text-xs">🔒</span>}
              {project.visibility.toLowerCase()}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            {project.workspace && (
              <Link href={`/workspaces/${project.workspace.id}`}>
                <Badge variant="secondary" className="flex items-center gap-1 hover:bg-accent transition-colors">
                  <Building2 className="h-3 w-3" />
                  {project.workspace.name}
                </Badge>
              </Link>
            )}
            {project.description && (
              <span className="text-muted-foreground">{project.description}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Sort Button - Left of Share */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')}
            className="flex items-center gap-2"
          >
            {sortOrder === 'desc' ? (
              <>
                <ArrowDown className="h-4 w-4" />
                Newest first
              </>
            ) : (
              <>
                <ArrowUp className="h-4 w-4" />
                Oldest first
              </>
            )}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/projects/${projectId}/share`}>
              <Share2 className="h-4 w-4 mr-2" />
              Share
            </Link>
          </Button>
          {(isOwner || project.members[0]?.role === 'ADMIN') && (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/projects/${projectId}/members`}>
                  <Users className="h-4 w-4 mr-2" />
                  Members
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/projects/${projectId}/settings`}>
                  <Settings className="h-4 w-4 mr-2" />
                  Settings
                </Link>
              </Button>
            </>
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
          {sortedVideos.map((video) => (
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
    </>
  );
}
