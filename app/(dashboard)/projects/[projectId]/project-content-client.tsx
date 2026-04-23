'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
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
  Globe,
  UserPlus,
  Lock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { VideoCard } from '@/components/video-card';
import { VideoDragDropUploader } from '@/components/video-drag-drop-uploader';

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
  totalPages: number;
  currentPage: number;
}

export function ProjectContentClient({
  project,
  projectId,
  videos,
  canEdit,
  isOwner,
  totalPages,
  currentPage,
}: ProjectContentClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sortOrder = searchParams.get('sort') || 'desc';
  const [localVideos, setLocalVideos] = useState<SerializedVideo[]>(videos);

  useEffect(() => {
    setLocalVideos(videos);
  }, [videos]);

  const createQueryString = useCallback(
    (name: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(name, value);

      if (name !== 'page') {
        params.set('page', '1');
      }

      return params.toString();
    },
    [searchParams]
  );

  const sortedVideos = [...localVideos].sort((a, b) => {
    const dateA = new Date(a.updatedAt).getTime();
    const dateB = new Date(b.updatedAt).getTime();
    return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
  });

  const handleVideoDeleted = useCallback((videoId: string) => {
    setLocalVideos((prev) => prev.filter((video) => video.id !== videoId));
  }, []);

  return (
    <>
      <VideoDragDropUploader
        fixedProjectId={projectId}
        fixedProjectName={project.name}
        canUpload={canEdit}
      />

      {/* Project Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
            <Badge variant="outline" className="flex items-center gap-1">
              {project.visibility === 'PUBLIC' && <Globe className="h-3 w-3" />}
              {project.visibility === 'INVITE' && <UserPlus className="h-3 w-3" />}
              {project.visibility === 'PRIVATE' && <Lock className="h-3 w-3" />}
              {project.visibility.toLowerCase()}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            {project.workspace && (
              <Link href={`/workspaces/${project.workspace.id}`}>
                <Badge
                  variant="secondary"
                  className="flex items-center gap-1 hover:bg-accent transition-colors"
                >
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

        <div className="flex flex-wrap items-center gap-2 mt-4 sm:mt-0">
          {/* Sort Button - Left of Share */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const newOrder = sortOrder === 'desc' ? 'asc' : 'desc';
              router.push(`?${createQueryString('sort', newOrder)}`);
            }}
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
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/projects/${projectId}/share`}>
                <Share2 className="h-4 w-4 mr-2" />
                Share
              </Link>
            </Button>
          )}
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
      {localVideos.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {sortedVideos.map((video) => (
            <VideoCard
              key={video.id}
              video={video}
              projectId={projectId}
              canManage={canEdit}
              onDeleted={handleVideoDeleted}
            />
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

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-8 flex items-center justify-end space-x-2">
          <Button variant="outline" size="sm" disabled={currentPage <= 1} asChild={currentPage > 1}>
            {currentPage > 1 ? (
              <Link href={`?${createQueryString('page', (currentPage - 1).toString())}`}>
                Previous
              </Link>
            ) : (
              'Previous'
            )}
          </Button>
          <span className="text-sm font-medium">
            Page {currentPage} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage >= totalPages}
            asChild={currentPage < totalPages}
          >
            {currentPage < totalPages ? (
              <Link href={`?${createQueryString('page', (currentPage + 1).toString())}`}>Next</Link>
            ) : (
              'Next'
            )}
          </Button>
        </div>
      )}
    </>
  );
}
