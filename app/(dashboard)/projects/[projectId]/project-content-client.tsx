'use client';
import {
  AddFolderButton,
  ProjectFolderBrowser,
  ProjectFolderCard,
  type FolderEntry,
} from '@/components/project-folder-browser';
import { ContentAccessControls } from '@/components/content-access-controls';
import { DriveImportsPanel } from '@/components/drive-import/drive-imports-panel';

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
  ArrowDownAZ,
  ArrowUpAZ,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
import { downloadProgressPercent } from '@/lib/client/download-file';
import { beginUnloadGuard } from '@/lib/client/unload-guard';
import { ProjectBrandLogo } from '@/components/project-branding';
import { VERSION_STACK_DRAG_TYPE, versionDropTargetProps } from '@/lib/client/version-stack-drag';
import { cn } from '@/lib/utils';
import { parseProjectContentSort, projectContentSortLabels } from '@/lib/project-content-sort';
import {
  createDownloadProgressToast,
  type DownloadProgressToastHandle,
} from '@/components/download-progress-toast';

interface SerializedVideo {
  id: string;
  mediaType: 'VIDEO' | 'IMAGE';
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
  /** Client logo shown next to the project name, when the project is branded. */
  logoUrl?: string | null;
  folderId?: string | null;
  folders: FolderEntry[];
  canSeeRoot: boolean;
  all: boolean;
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
  imageUploadsEnabled?: boolean;
  directUploadProvider: DirectUploadProvider;
}

export function ProjectContentClient({
  project,
  projectId,
  logoUrl = null,
  folderId = null,
  folders,
  canSeeRoot,
  all,
  videos,
  allVideoIds,
  canEdit,
  canDownloadProject,
  isOwner,
  totalPages,
  currentPage,
  pageSize,
  directUploadsEnabled,
  imageUploadsEnabled = false,
  directUploadProvider,
}: ProjectContentClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sortOrder = parseProjectContentSort(searchParams.get('sort'));
  const SortIcon =
    sortOrder === 'name-asc'
      ? ArrowDownAZ
      : sortOrder === 'name-desc'
        ? ArrowUpAZ
        : sortOrder === 'asc'
          ? ArrowUp
          : ArrowDown;
  const [localVideos, setLocalVideos] = useState<SerializedVideo[]>(videos);
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [includeAssetsInDownload, setIncludeAssetsInDownload] = useState(false);
  const [isDeletingSelected, setIsDeletingSelected] = useState(false);
  const [showDeleteSelectedDialog, setShowDeleteSelectedDialog] = useState(false);
  const [showMoveSelectedDialog, setShowMoveSelectedDialog] = useState(false);

  // Dragging one card onto another stacks it as a new version of that file.
  const [stackDraggingId, setStackDraggingId] = useState<string | null>(null);
  const [stackTargetId, setStackTargetId] = useState<string | null>(null);
  const [pendingStack, setPendingStack] = useState<{
    source: SerializedVideo;
    target: SerializedVideo;
    message: string | null;
    confirmationToken: string | null;
  } | null>(null);
  const [isStacking, setIsStacking] = useState(false);

  const childFolders = all ? [] : folders.filter((folder) => folder.parentId === folderId);
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
      let progressToast: DownloadProgressToastHandle | null = null;
      let releaseUnloadGuard: (() => void) | null = null;
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

        progressToast = createDownloadProgressToast(`project-download-${projectId}`, {
          title: `Downloading ${manifest.totalFiles} files`,
          description: 'Starting…',
        });
        // The files are pulled one by one through this tab, so closing it drops
        // everything that hasn't been saved yet. Warn before that happens.
        releaseUnloadGuard = beginUnloadGuard();
        await runProjectDownloadManifest(manifest, (p) => {
          const percent = downloadProgressPercent({
            receivedBytes: p.receivedBytes,
            totalBytes: p.totalBytes,
          });
          progressToast?.update({
            title: `Downloading file ${p.index}/${p.total}`,
            description: `${p.fileName}${percent !== null ? ` · ${percent}%` : ''}`,
            percent,
          });
        });
        progressToast.success(`Downloaded ${manifest.totalFiles} files`);
      } catch {
        // The progress panel never expires on its own, so clear it before the
        // error toast replaces it.
        progressToast?.dismiss();
        toast.error('Failed to start project download');
      } finally {
        releaseUnloadGuard?.();
        setIsDownloading(false);
      }
    },
    [canDownloadProject, isDownloading, projectId]
  );

  const canStackVersions = canEdit && !selectionMode && localVideos.length > 1;
  // A file dropped from the desktop onto a card becomes its new version; the
  // page-wide uploader below does the upload.
  const canDropVersionFiles =
    canEdit && !all && !selectionMode && (directUploadsEnabled || imageUploadsEnabled);

  const requestStack = useCallback(
    async (source: SerializedVideo, target: SerializedVideo, confirmationToken?: string) => {
      setIsStacking(true);
      try {
        const response = await fetch(
          `/api/projects/${projectId}/videos/${target.id}/versions/merge`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceVideoId: source.id, confirmationToken }),
          }
        );
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          toast.error(
            typeof body?.error === 'string' ? body.error : 'Failed to add the file as a version'
          );
          setPendingStack(null);
          return;
        }
        if (body?.data?.needsConfirmation) {
          // A second confirmation means access changed since the first one was shown.
          if (confirmationToken) toast.message('Access changed. Review and confirm again.');
          setPendingStack({
            source,
            target,
            message: body.data.message,
            confirmationToken: body.data.confirmationToken,
          });
          return;
        }
        // The card badge is the version count (see page.tsx), so mirror that here
        // rather than the version number, or the badge changes on refresh.
        const versionCount = Number(body?.data?.versionCount);
        setLocalVideos((prev) =>
          prev
            .filter((video) => video.id !== source.id)
            .map((video) =>
              video.id === target.id && Number.isFinite(versionCount)
                ? { ...video, currentVersion: versionCount }
                : video
            )
        );
        setPendingStack(null);
        toast.success(`Added "${source.title}" as a new version of "${target.title}"`);
        router.refresh();
      } catch {
        toast.error('Failed to add the file as a version');
        setPendingStack(null);
      } finally {
        setIsStacking(false);
      }
    },
    [projectId, router]
  );

  const handleStackDrop = useCallback(
    (targetId: string) => {
      const source = localVideos.find((video) => video.id === stackDraggingId);
      const target = localVideos.find((video) => video.id === targetId);
      setStackDraggingId(null);
      setStackTargetId(null);
      if (!source || !target || source.id === target.id) return;
      if (source.mediaType !== target.mediaType) {
        toast.error('Videos and images cannot be stacked together');
        return;
      }
      setPendingStack({ source, target, message: null, confirmationToken: null });
      void requestStack(source, target);
    },
    [localVideos, requestStack, stackDraggingId]
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
          typeof body?.error === 'string' ? body.error : 'Failed to delete selected files';
        toast.error(message);
        return;
      }

      const deletedIds = new Set(selectedVideoIds);
      setLocalVideos((prev) => prev.filter((video) => !deletedIds.has(video.id)));
      setSelectedVideoIds([]);
      setSelectionMode(false);
      setShowDeleteSelectedDialog(false);
      toast.success(
        typeof body?.data?.message === 'string' ? body.data.message : 'Selected files deleted'
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
      toast.error('Failed to delete selected files');
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
        folderId={folderId}
        fixedProjectId={projectId}
        fixedProjectName={project.name}
        canUpload={canEdit && !all && (directUploadsEnabled || imageUploadsEnabled)}
        directUploadsEnabled={directUploadsEnabled}
        imageUploadsEnabled={imageUploadsEnabled}
        directUploadProvider={directUploadProvider}
      />

      {/* Project Header */}
      <div className="space-y-5 mb-6">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            {logoUrl ? <ProjectBrandLogo src={logoUrl} /> : null}
            <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
            <Badge variant="outline" className="flex items-center gap-1">
              {project.visibility === 'PUBLIC' && <Globe className="h-3 w-3" />}
              {project.visibility === 'INVITE' && <UserPlus className="h-3 w-3" />}
              {project.visibility === 'PRIVATE' && <Lock className="h-3 w-3" />}
              {project.visibility.toLowerCase()}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
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

        <div
          className="flex flex-wrap items-center justify-between gap-3"
          role="group"
          aria-label="Project actions"
        >
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="flex items-center gap-2">
                  <SortIcon className="h-4 w-4" />
                  {projectContentSortLabels[sortOrder]}
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup
                  value={sortOrder}
                  onValueChange={(value) => router.push(`?${createQueryString('sort', value)}`)}
                >
                  {Object.entries(projectContentSortLabels).map(([value, label]) => (
                    <DropdownMenuRadioItem key={value} value={value}>
                      {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {canDownloadProject && localVideos.length > 0 && !selectionMode && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={isDownloading}>
                    {isDownloading ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4 mr-2" />
                    )}
                    Download accessible files
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
                      startProjectDownload(allVideoIds, { includeAssets: includeAssetsInDownload })
                    }
                  >
                    Latest version only
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      startProjectDownload(allVideoIds, {
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
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {folderId && canEdit && !all && (
              <ContentAccessControls
                key={folderId}
                projectId={projectId}
                folderId={folderId}
                contentName={folders.find((folder) => folder.id === folderId)?.name}
                share
              />
            )}
            {!folderId && (isOwner || project.members[0]?.role === 'ADMIN') && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/projects/${projectId}/share`}>
                  <Share2 className="h-4 w-4 mr-2" />
                  Share
                </Link>
              </Button>
            )}
            {folderId && canEdit && !all && (
              <ContentAccessControls
                key={`members-${folderId}`}
                projectId={projectId}
                folderId={folderId}
                contentName={folders.find((folder) => folder.id === folderId)?.name}
                showMembers
              />
            )}
            {(isOwner || project.members[0]?.role === 'ADMIN') && (
              <>
                {!folderId && (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/projects/${projectId}/members`}>
                      <Users className="h-4 w-4 mr-2" />
                      Members
                    </Link>
                  </Button>
                )}
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/projects/${projectId}/settings`}>
                    <Settings className="h-4 w-4 mr-2" />
                    Settings
                  </Link>
                </Button>
              </>
            )}
            {canEdit && !all && (
              <div className="flex shrink-0 items-center gap-2">
                <AddFolderButton projectId={projectId} folderId={folderId} />
                <Button size="sm" asChild>
                  <Link
                    href={`/projects/${projectId}/videos/new${folderId ? `?folderId=${folderId}` : ''}`}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add File
                  </Link>
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      <ProjectFolderBrowser
        projectId={projectId}
        folderId={folderId}
        folders={folders}
        canEdit={canEdit}
        canSeeRoot={canSeeRoot}
        all={all}
      />

      {canEdit && <DriveImportsPanel projectId={projectId} />}

      {all && (
        <p className="mb-5 text-sm text-muted-foreground">
          Videos you can access from every folder in this project.
        </p>
      )}

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
                Move files
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

      {/* Group both content types below the project header. */}
      {childFolders.length > 0 || localVideos.length > 0 ? (
        <div className="space-y-7" aria-label="Project contents">
          {childFolders.length > 0 && (
            <section aria-labelledby="project-folders-heading">
              <h2
                id="project-folders-heading"
                className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                Folders
              </h2>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {childFolders.map((folder) => (
                  <ProjectFolderCard key={folder.id} projectId={projectId} folder={folder} />
                ))}
              </div>
            </section>
          )}
          {localVideos.length > 0 && (
            <section aria-labelledby="project-videos-heading">
              <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2
                  id="project-videos-heading"
                  className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
                >
                  Files
                </h2>
                {(canStackVersions || canDropVersionFiles) && (
                  <p className="hidden text-xs text-muted-foreground md:block">
                    {canStackVersions
                      ? 'Drop a new cut onto a file, or drag one file onto another, to add a version.'
                      : 'Drop a new cut onto a file to add it as a new version.'}
                  </p>
                )}
              </div>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {localVideos.map((video) => {
                  const draggingVideo = stackDraggingId
                    ? localVideos.find((candidate) => candidate.id === stackDraggingId)
                    : undefined;
                  const acceptsDrop =
                    !!draggingVideo &&
                    draggingVideo.id !== video.id &&
                    draggingVideo.mediaType === video.mediaType;
                  const acceptsVersionFile =
                    canDropVersionFiles &&
                    (video.mediaType === 'IMAGE' ? imageUploadsEnabled : directUploadsEnabled);
                  return (
                    <div
                      key={video.id}
                      data-testid="file-card"
                      {...(acceptsVersionFile
                        ? versionDropTargetProps({
                            videoId: video.id,
                            title: video.title,
                            mediaType: video.mediaType,
                          })
                        : {})}
                      draggable={canStackVersions}
                      onDragStart={
                        canStackVersions
                          ? (event) => {
                              // React bubbles events out of the card's portalled
                              // dialogs too; only a drag that starts on the card counts.
                              if (!event.currentTarget.contains(event.target as Node)) return;
                              event.dataTransfer.setData(VERSION_STACK_DRAG_TYPE, video.id);
                              event.dataTransfer.effectAllowed = 'move';
                              setStackDraggingId(video.id);
                            }
                          : undefined
                      }
                      onDragEnd={() => {
                        setStackDraggingId(null);
                        setStackTargetId(null);
                      }}
                      onDragOver={(event) => {
                        if (!acceptsDrop) return;
                        if (!event.dataTransfer.types.includes(VERSION_STACK_DRAG_TYPE)) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        if (stackTargetId !== video.id) setStackTargetId(video.id);
                      }}
                      onDragLeave={(event) => {
                        if (event.currentTarget.contains(event.relatedTarget as Node | null))
                          return;
                        if (stackTargetId === video.id) setStackTargetId(null);
                      }}
                      onDrop={(event) => {
                        if (!acceptsDrop) return;
                        event.preventDefault();
                        handleStackDrop(video.id);
                      }}
                      className={cn(
                        'group/version-drop relative rounded-xl transition',
                        'data-[file-drop-over]:ring-2 data-[file-drop-over]:ring-primary data-[file-drop-over]:ring-offset-2 data-[file-drop-over]:ring-offset-background',
                        stackDraggingId === video.id && 'opacity-50',
                        stackTargetId === video.id &&
                          'ring-2 ring-primary ring-offset-2 ring-offset-background'
                      )}
                    >
                      <VideoCard
                        video={video}
                        projectId={projectId}
                        canManage={canEdit}
                        imageUploadsEnabled={imageUploadsEnabled}
                        directUploadsEnabled={directUploadsEnabled}
                        directUploadProvider={directUploadProvider}
                        canSelect={canSelectVideos}
                        selectionMode={selectionMode}
                        selected={selectedVideoIds.includes(video.id)}
                        onEnterSelectionMode={handleEnterSelectionMode}
                        onSelectedChange={(selected) => toggleVideoSelection(video.id, selected)}
                        onDeleted={handleVideoDeleted}
                      />
                      {acceptsVersionFile && (
                        <div className="pointer-events-none absolute inset-x-0 top-3 z-20 hidden justify-center group-data-[file-drop-over]/version-drop:flex">
                          <span className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow">
                            Drop to add as a new version
                          </span>
                        </div>
                      )}
                      {stackTargetId === video.id && (
                        <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
                          <span className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow">
                            Drop to add as a new version
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Play className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">
              {all ? 'No files yet' : 'This folder is empty'}
            </h3>
            <p className="text-muted-foreground text-center mb-4">
              {all
                ? 'Files you can access will appear here.'
                : canEdit
                  ? 'Add a file or folder to get started.'
                  : 'No content has been added here yet.'}
            </p>
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
              This will permanently delete the selected files, all of their versions, comments, and
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

      <AlertDialog
        open={pendingStack !== null}
        onOpenChange={(open) => {
          if (!open && !isStacking) setPendingStack(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Add &quot;{pendingStack?.source.title}&quot; as a new version of &quot;
              {pendingStack?.target.title}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingStack?.message ?? 'Checking access…'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isStacking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (pendingStack?.confirmationToken)
                  void requestStack(
                    pendingStack.source,
                    pendingStack.target,
                    pendingStack.confirmationToken
                  );
              }}
              disabled={isStacking || !pendingStack?.confirmationToken}
            >
              {isStacking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add as version
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {canEdit && selectedVideoIds.length === 1 && (
        <ContentAccessControls projectId={projectId} videoId={[...selectedVideoIds][0]} />
      )}
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
