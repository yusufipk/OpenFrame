'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  Download,
  Loader2,
  Trash2,
  ChevronDown,
  FolderInput,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { VideoCard } from '@/components/video-card';
import { VideoDragDropUploader } from '@/components/video-drag-drop-uploader';
import { MoveVideosDialog } from '@/components/move-videos-dialog';
import type { DirectUploadProvider } from '@/components/video-page/types';
import {
  runProjectDownloadManifest,
  type ProjectDownloadManifest,
} from '@/lib/client/project-download';

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
    allowDownloads: boolean;
    workspace: { id: string; name: string } | null;
    members: { role: string }[];
  };
  projectId: string;
  videos: SerializedVideo[];
  allVideoIds: string[];
  canEdit: boolean;
  canDownloadProject: boolean;
  isOwner: boolean;
  workspaceRole: string | null;
  totalPages: number;
  currentPage: number;
  pageSize: number;
  directUploadsEnabled: boolean;
  directUploadProvider: DirectUploadProvider;
}

// Mosaic sizing: thumbnails report their natural aspect ratio on load and are
// normalized into three buckets so mixed-format projects (vertical social
// cuts, square posts, widescreen spots) tile without letterboxing. Cards
// default to landscape until their thumbnail reports otherwise. Every card
// derives its width from one shared media height, so rows stay aligned:
// portrait tiles narrow, landscape tiles wide, all thumbnails equally tall.
const PORTRAIT_ASPECT_RATIO = 9 / 16;
const SQUARE_ASPECT_RATIO = 1;
const LANDSCAPE_ASPECT_RATIO = 16 / 9;
const PORTRAIT_CARD_WIDTH = 240;
const MOSAIC_MEDIA_HEIGHT = PORTRAIT_CARD_WIDTH / PORTRAIT_ASPECT_RATIO;

function normalizeMosaicAspectRatio(aspectRatio: number): number {
  if (aspectRatio < 0.8) return PORTRAIT_ASPECT_RATIO;
  if (aspectRatio < 1.25) return SQUARE_ASPECT_RATIO;
  return LANDSCAPE_ASPECT_RATIO;
}

function getMosaicCardWidth(aspectRatio: number): number {
  return Math.round(MOSAIC_MEDIA_HEIGHT * aspectRatio);
}

export function ProjectContentClient({
  project,
  projectId,
  videos,
  allVideoIds,
  canEdit,
  canDownloadProject,
  isOwner,
  totalPages,
  currentPage,
  pageSize,
  directUploadsEnabled,
  directUploadProvider,
}: ProjectContentClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sortOrder = searchParams.get('sort') || 'desc';
  const [localVideos, setLocalVideos] = useState<SerializedVideo[]>(videos);
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [videoAspectRatios, setVideoAspectRatios] = useState<Record<string, number>>({});

  const handleVideoAspectRatioChange = useCallback((videoId: string, aspectRatio: number) => {
    const normalizedAspectRatio = normalizeMosaicAspectRatio(aspectRatio);
    setVideoAspectRatios((current) => {
      if (current[videoId] === normalizedAspectRatio) return current;
      return { ...current, [videoId]: normalizedAspectRatio };
    });
  }, []);
  const [isDownloading, setIsDownloading] = useState(false);
  const [includeAssetsInDownload, setIncludeAssetsInDownload] = useState(false);
  const [isDeletingSelected, setIsDeletingSelected] = useState(false);
  const [showDeleteSelectedDialog, setShowDeleteSelectedDialog] = useState(false);
  const [showMoveSelectedDialog, setShowMoveSelectedDialog] = useState(false);

  const canSelectVideos = canDownloadProject || canEdit;

  useEffect(() => {
    setLocalVideos(videos);
  }, [videos]);

  const selectedCount = selectedVideoIds.length;
  const pageVideoIds = useMemo(() => localVideos.map((video) => video.id), [localVideos]);
  const allSelected = useMemo(
    () => pageVideoIds.length > 0 && pageVideoIds.every((id) => selectedVideoIds.includes(id)),
    [pageVideoIds, selectedVideoIds]
  );

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

  const handleVideoDeleted = useCallback((videoId: string) => {
    setLocalVideos((prev) => prev.filter((video) => video.id !== videoId));
    setSelectedVideoIds((prev) => prev.filter((id) => id !== videoId));
  }, []);

  const handleVideosMoved = useCallback((movedIds: string[]) => {
    const moved = new Set(movedIds);
    setLocalVideos((prev) => prev.filter((video) => !moved.has(video.id)));
    setSelectedVideoIds([]);
    setSelectionMode(false);
  }, []);

  const toggleVideoSelection = useCallback((videoId: string, selected: boolean) => {
    setSelectedVideoIds((prev) => {
      if (selected) {
        if (prev.includes(videoId)) return prev;
        return [...prev, videoId];
      }
      return prev.filter((id) => id !== videoId);
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    // Scope selection to the current page only. Selecting every video across
    // every page from a single button is too easy to trigger by accident when
    // the user only meant the videos they can see.
    setSelectedVideoIds((prev) => {
      const next = new Set(prev);
      pageVideoIds.forEach((id) => next.add(id));
      return Array.from(next);
    });
  }, [pageVideoIds]);

  const handleDeselectAll = useCallback(() => {
    const pageIds = new Set(pageVideoIds);
    setSelectedVideoIds((prev) => prev.filter((id) => !pageIds.has(id)));
  }, [pageVideoIds]);

  const handleClearSelection = useCallback(() => {
    setSelectedVideoIds([]);
    setSelectionMode(false);
  }, []);

  const handleEnterSelectionMode = useCallback(() => {
    setSelectionMode(true);
  }, []);

  const startProjectDownload = useCallback(
    async (videoIds?: string[], options?: { allVersions?: boolean; includeAssets?: boolean }) => {
      if (!canDownloadProject || isDownloading) return;

      const searchParams = new URLSearchParams();
      if (videoIds && videoIds.length > 0) {
        searchParams.set('videoIds', videoIds.join(','));
      }
      if (options?.allVersions) {
        searchParams.set('versions', 'all');
      }
      if (options?.includeAssets) {
        searchParams.set('assets', '1');
      }
      const query = searchParams.toString() ? `?${searchParams.toString()}` : '';

      setIsDownloading(true);
      try {
        const response = await fetch(`/api/projects/${projectId}/download${query}`, {
          cache: 'no-store',
        });
        const body = await response.json().catch(() => null);

        if (!response.ok) {
          const message =
            typeof body?.error === 'string' ? body.error : 'Failed to prepare project download';
          toast.error(message);
          return;
        }

        const manifest = body?.data as ProjectDownloadManifest | undefined;
        if (!manifest?.files?.length) {
          toast.error('No downloadable files found');
          return;
        }

        const downloadToastId = `project-download-${projectId}`;
        toast.loading(`Downloading ${manifest.totalFiles} files…`, {
          id: downloadToastId,
          duration: Infinity,
        });
        await runProjectDownloadManifest(manifest, (p) => {
          const pct =
            p.totalBytes && p.totalBytes > 0
              ? ` · ${Math.min(100, Math.floor((p.receivedBytes / p.totalBytes) * 100))}%`
              : '';
          toast.loading(`Downloading file ${p.index}/${p.total}`, {
            id: downloadToastId,
            description: `${p.fileName}${pct}`,
            duration: Infinity,
          });
        });
        toast.success(`Downloaded ${manifest.totalFiles} files`, {
          id: downloadToastId,
          duration: 4000,
        });
      } catch {
        toast.error('Failed to start project download');
      } finally {
        setIsDownloading(false);
      }
    },
    [canDownloadProject, isDownloading, projectId]
  );

  const handleDeleteSelected = useCallback(async () => {
    if (!canEdit || selectedCount === 0 || isDeletingSelected) return;

    setIsDeletingSelected(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/videos/bulk-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoIds: selectedVideoIds }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          typeof body?.error === 'string' ? body.error : 'Failed to delete selected videos';
        toast.error(message);
        return;
      }

      const deletedIds = new Set(selectedVideoIds);
      setLocalVideos((prev) => prev.filter((video) => !deletedIds.has(video.id)));
      setSelectedVideoIds([]);
      setSelectionMode(false);
      setShowDeleteSelectedDialog(false);
      toast.success(
        typeof body?.data?.message === 'string' ? body.data.message : 'Selected videos deleted'
      );

      // The current page may now be out of range (e.g. we deleted every video
      // on it). Clamp to the last valid page so the refresh lands on a page
      // that still has videos instead of showing "No videos yet".
      const remainingTotal = allVideoIds.filter((id) => !deletedIds.has(id)).length;
      const newTotalPages = Math.max(1, Math.ceil(remainingTotal / pageSize));
      if (currentPage > newTotalPages) {
        router.push(`?${createQueryString('page', newTotalPages.toString())}`);
      } else {
        router.refresh();
      }
    } catch {
      toast.error('Failed to delete selected videos');
    } finally {
      setIsDeletingSelected(false);
    }
  }, [
    allVideoIds,
    canEdit,
    createQueryString,
    currentPage,
    isDeletingSelected,
    pageSize,
    projectId,
    router,
    selectedCount,
    selectedVideoIds,
  ]);

  return (
    <>
      <VideoDragDropUploader
        fixedProjectId={projectId}
        fixedProjectName={project.name}
        canUpload={canEdit && directUploadsEnabled}
        directUploadProvider={directUploadProvider}
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
          {canDownloadProject && localVideos.length > 0 && !selectionMode && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={isDownloading}>
                  {isDownloading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 mr-2" />
                  )}
                  Download project
                  <ChevronDown className="h-4 w-4 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem
                  checked={includeAssetsInDownload}
                  onCheckedChange={(checked) => setIncludeAssetsInDownload(checked === true)}
                  onSelect={(event) => event.preventDefault()}
                >
                  Include assets
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() =>
                    startProjectDownload(undefined, { includeAssets: includeAssetsInDownload })
                  }
                >
                  Latest version only
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    startProjectDownload(undefined, {
                      allVersions: true,
                      includeAssets: includeAssetsInDownload,
                    })
                  }
                >
                  All versions
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
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

      {selectionMode && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
          <span className="text-sm font-medium">Selection mode</span>
          <span className="text-sm text-muted-foreground">
            {selectedCount > 0 ? `${selectedCount} selected` : 'None selected'}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={allSelected ? handleDeselectAll : handleSelectAll}
            >
              {totalPages > 1
                ? allSelected
                  ? 'Deselect page'
                  : 'Select page'
                : allSelected
                  ? 'Deselect all'
                  : 'Select all'}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClearSelection}>
              Cancel
            </Button>
            {canDownloadProject && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isDownloading || selectedCount === 0}
                  >
                    {isDownloading ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4 mr-2" />
                    )}
                    Download selected
                    <ChevronDown className="h-4 w-4 ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuCheckboxItem
                    checked={includeAssetsInDownload}
                    onCheckedChange={(checked) => setIncludeAssetsInDownload(checked === true)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    Include assets
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() =>
                      startProjectDownload(selectedVideoIds, {
                        includeAssets: includeAssetsInDownload,
                      })
                    }
                  >
                    Latest version only
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      startProjectDownload(selectedVideoIds, {
                        allVersions: true,
                        includeAssets: includeAssetsInDownload,
                      })
                    }
                  >
                    All versions
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowMoveSelectedDialog(true)}
                disabled={selectedCount === 0 || isDeletingSelected}
              >
                <FolderInput className="h-4 w-4 mr-2" />
                Move to project
              </Button>
            )}
            {canEdit && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowDeleteSelectedDialog(true)}
                disabled={selectedCount === 0 || isDeletingSelected}
              >
                {isDeletingSelected ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 mr-2" />
                )}
                Delete selected
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Videos Grid */}
      {localVideos.length > 0 ? (
        <div className="flex flex-wrap items-start gap-4">
          {localVideos.map((video) => {
            const aspectRatio = videoAspectRatios[video.id] ?? LANDSCAPE_ASPECT_RATIO;
            const cardWidth = getMosaicCardWidth(aspectRatio);

            return (
              <div
                key={video.id}
                className="min-w-0"
                style={{
                  flexGrow: 0,
                  flexShrink: 1,
                  flexBasis: `${cardWidth}px`,
                  maxWidth: `${cardWidth}px`,
                  minWidth: 'min(100%, 220px)',
                }}
              >
                <VideoCard
                  video={video}
                  projectId={projectId}
                  canManage={canEdit}
                  canSelect={canSelectVideos}
                  selectionMode={selectionMode}
                  selected={selectedVideoIds.includes(video.id)}
                  thumbnailAspectRatio={aspectRatio}
                  onThumbnailAspectRatioChange={(nextAspectRatio) =>
                    handleVideoAspectRatioChange(video.id, nextAspectRatio)
                  }
                  onEnterSelectionMode={handleEnterSelectionMode}
                  onSelectedChange={(selected) => toggleVideoSelection(video.id, selected)}
                  onDeleted={handleVideoDeleted}
                />
              </div>
            );
          })}
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

      <AlertDialog open={showDeleteSelectedDialog} onOpenChange={setShowDeleteSelectedDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedCount} video{selectedCount === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the selected videos, all of their versions, comments, and
              stored media from Bunny and Cloudflare R2. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingSelected}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteSelected();
              }}
              disabled={isDeletingSelected || selectedCount === 0}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeletingSelected && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete selected
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <MoveVideosDialog
        open={showMoveSelectedDialog}
        onOpenChange={setShowMoveSelectedDialog}
        projectId={projectId}
        videoIds={selectedVideoIds}
        onMoved={handleVideosMoved}
      />
    </>
  );
}
