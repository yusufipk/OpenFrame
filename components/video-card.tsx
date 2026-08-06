'use client';

import { useMemo, useState, type SyntheticEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Play,
  MessageSquare,
  Clock,
  MoreVertical,
  Loader2,
  Link as LinkIcon,
  AlertCircle,
  CheckCircle2,
  Share2,
  Pencil,
  Plus,
  Trash2,
  CheckSquare,
  Check,
  FolderInput,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import {
  parseVideoUrl,
  fetchVideoMetadata,
  getThumbnailUrl,
  type VideoSource,
} from '@/lib/video-providers';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import { MoveVideosDialog } from '@/components/move-videos-dialog';
import { cn } from '@/lib/utils';

interface VideoCardProps {
  video: {
    id: string;
    title: string;
    thumbnailUrl: string;
    currentVersion: number;
    commentCount: number;
    duration: string;
    lastUpdated: string;
  };
  projectId: string;
  canManage: boolean;
  canSelect?: boolean;
  selectionMode?: boolean;
  selected?: boolean;
  thumbnailAspectRatio?: number;
  onThumbnailAspectRatioChange?: (aspectRatio: number) => void;
  onEnterSelectionMode?: () => void;
  onSelectedChange?: (selected: boolean) => void;
  onDeleted?: (videoId: string) => void;
}

export function VideoCard({
  video,
  projectId,
  canManage,
  canSelect = false,
  selectionMode = false,
  selected = false,
  thumbnailAspectRatio = 16 / 9,
  onThumbnailAspectRatioChange,
  onEnterSelectionMode,
  onSelectedChange,
  onDeleted,
}: VideoCardProps) {
  const router = useRouter();
  const [imgError, setImgError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const handleThumbnailLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (naturalWidth > 0 && naturalHeight > 0) {
      onThumbnailAspectRatioChange?.(naturalWidth / naturalHeight);
    }
  };

  // Edit dialog
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editTitle, setEditTitle] = useState(video.title);
  const [editDescription, setEditDescription] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState('');

  // Add Version dialog
  const [showVersionDialog, setShowVersionDialog] = useState(false);
  const [versionUrl, setVersionUrl] = useState('');
  const [versionLabel, setVersionLabel] = useState('');
  const [versionSource, setVersionSource] = useState<VideoSource | null>(null);
  const [versionUrlError, setVersionUrlError] = useState('');
  const [isCreatingVersion, setIsCreatingVersion] = useState(false);

  // Delete dialog
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Move dialog
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const bunnyCdnHostname = useMemo(() => resolvePublicBunnyCdnHostname(), []);
  const resolvedThumbnailUrl = useMemo(() => {
    if (!video.thumbnailUrl) return '';
    try {
      const parsed = new URL(video.thumbnailUrl);
      if (parsed.hostname === 'vz-thumbnail.b-cdn.net' && bunnyCdnHostname) {
        parsed.hostname = bunnyCdnHostname;
        return parsed.toString();
      }
      return parsed.toString();
    } catch {
      return video.thumbnailUrl;
    }
  }, [video.thumbnailUrl, bunnyCdnHostname]);

  const handleEdit = async () => {
    setIsSaving(true);
    setEditError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/videos/${video.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle.trim(),
          description: editDescription.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setEditError(data.error || 'Failed to update video');
        return;
      }
      setShowEditDialog(false);
      router.refresh();
    } catch {
      setEditError('An unexpected error occurred');
    } finally {
      setIsSaving(false);
    }
  };

  const handleVersionUrlChange = (url: string) => {
    setVersionUrl(url);
    setVersionUrlError('');
    if (!url.trim()) {
      setVersionSource(null);
      return;
    }
    const source = parseVideoUrl(url);
    if (source) {
      setVersionSource(source);
    } else {
      setVersionSource(null);
      if (url.length > 10) setVersionUrlError('Unsupported URL');
    }
  };

  const handleCreateVersion = async () => {
    if (!versionSource) return;
    setIsCreatingVersion(true);
    try {
      const meta = await fetchVideoMetadata(versionSource);
      const thumbnailUrl = getThumbnailUrl(versionSource, 'large');

      const res = await fetch(`/api/projects/${projectId}/videos/${video.id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrl: versionSource.originalUrl,
          providerId: versionSource.providerId,
          providerVideoId: versionSource.videoId,
          versionLabel: versionLabel.trim() || null,
          thumbnailUrl,
          duration: meta?.duration || null,
          setActive: true,
        }),
      });
      if (res.ok) {
        setShowVersionDialog(false);
        setVersionUrl('');
        setVersionLabel('');
        setVersionSource(null);
        router.refresh();
      }
    } catch (err) {
      console.error('Failed to create version:', err);
    } finally {
      setIsCreatingVersion(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/videos/${video.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setShowDeleteDialog(false);
        onDeleted?.(video.id);
        router.refresh();
      }
    } catch (err) {
      console.error('Failed to delete video:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <div className="relative">
        {selectionMode && (
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={`Select ${video.title}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelectedChange?.(!selected);
            }}
            className={cn(
              'absolute left-3 top-3 z-20 flex h-5 w-5 items-center justify-center rounded-sm border-2 transition-colors',
              selected
                ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                : 'border-border bg-background/95 text-transparent shadow-sm backdrop-blur hover:border-primary/50'
            )}
          >
            <Check className="h-3 w-3" strokeWidth={3} />
          </button>
        )}
        <Card
          className={cn(
            'group overflow-hidden transition-colors',
            selectionMode ? 'cursor-pointer' : 'hover:bg-accent/50 cursor-pointer',
            selected && selectionMode && 'ring-2 ring-primary/40 border-primary/30',
            isDeleting && 'pointer-events-none opacity-70'
          )}
          onClick={
            selectionMode
              ? (event) => {
                  event.preventDefault();
                  onSelectedChange?.(!selected);
                }
              : undefined
          }
        >
          {selectionMode ? (
            <div
              className="relative bg-muted overflow-hidden"
              style={{ aspectRatio: thumbnailAspectRatio }}
            >
              {imgError ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-muted/80">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-2" />
                  <span className="text-xs text-muted-foreground font-medium">
                    Processing thumbnail...
                  </span>
                </div>
              ) : resolvedThumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${resolvedThumbnailUrl}${retryKey ? `?t=${retryKey}` : ''}`}
                  alt={video.title}
                  className="absolute inset-0 w-full h-full object-cover"
                  onLoad={handleThumbnailLoad}
                  onError={() => {
                    setImgError(true);
                    setTimeout(() => {
                      setRetryKey(Date.now());
                      setImgError(false);
                    }, 10000);
                  }}
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-muted/80 text-xs text-muted-foreground font-medium">
                  Thumbnail unavailable
                </div>
              )}
            </div>
          ) : (
            <Link href={`/projects/${projectId}/videos/${video.id}`}>
              {/* Thumbnail */}
              <div
                className="relative bg-muted overflow-hidden"
                style={{ aspectRatio: thumbnailAspectRatio }}
              >
                {imgError ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-muted/80">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-2" />
                    <span className="text-xs text-muted-foreground font-medium">
                      Processing thumbnail...
                    </span>
                    <span className="text-[11px] text-muted-foreground/90">
                      Video may already be playable
                    </span>
                  </div>
                ) : resolvedThumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`${resolvedThumbnailUrl}${retryKey ? `?t=${retryKey}` : ''}`}
                    alt={video.title}
                    className="absolute inset-0 w-full h-full object-cover transition-transform group-hover:scale-105"
                    onLoad={handleThumbnailLoad}
                    onError={() => {
                      setImgError(true);
                      // Check again after 10 seconds in case Bunny is still processing
                      setTimeout(() => {
                        setRetryKey(Date.now());
                        setImgError(false);
                      }, 10000);
                    }}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center bg-muted/80 text-xs text-muted-foreground font-medium">
                    Thumbnail unavailable
                  </div>
                )}
                {!imgError && (
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <Play className="h-12 w-12 text-white" fill="white" />
                  </div>
                )}
              </div>
            </Link>
          )}

          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-2">
              {selectionMode ? (
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium truncate">{video.title}</h3>
                  <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Badge variant="secondary" className="text-xs">
                        v{video.currentVersion}
                      </Badge>
                      <span className="text-xs">{video.duration}</span>
                    </span>
                    <span className="flex items-center gap-1">
                      <MessageSquare className="h-3.5 w-3.5" />
                      {video.commentCount}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" />
                      {video.lastUpdated}
                    </span>
                  </div>
                </div>
              ) : (
                <Link href={`/projects/${projectId}/videos/${video.id}`} className="min-w-0 flex-1">
                  <h3 className="font-medium truncate">{video.title}</h3>
                  <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Badge variant="secondary" className="text-xs">
                        v{video.currentVersion}
                      </Badge>
                      <span className="text-xs">{video.duration}</span>
                    </span>
                    <span className="flex items-center gap-1">
                      <MessageSquare className="h-3.5 w-3.5" />
                      {video.commentCount}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" />
                      {video.lastUpdated}
                    </span>
                  </div>
                </Link>
              )}

              {canManage && !selectionMode ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                      disabled={isDeleting}
                    >
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {canSelect && (
                      <DropdownMenuItem onSelect={() => onEnterSelectionMode?.()}>
                        <CheckSquare className="mr-2 h-4 w-4" />
                        Select
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem asChild>
                      <Link href={`/projects/${projectId}/videos/${video.id}/share`}>
                        <Share2 className="mr-2 h-4 w-4" />
                        Share
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setShowEditDialog(true)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setShowVersionDialog(true)}>
                      <Plus className="mr-2 h-4 w-4" />
                      Add Version
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setShowMoveDialog(true)}>
                      <FolderInput className="mr-2 h-4 w-4" />
                      Move to project
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive"
                      onSelect={() => setShowDeleteDialog(true)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : canSelect && !selectionMode ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onEnterSelectionMode?.()}>
                      <CheckSquare className="mr-2 h-4 w-4" />
                      Select
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {isDeleting && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/60 backdrop-blur-[1px]">
            <div className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm font-medium shadow-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Deleting...
            </div>
          </div>
        )}
      </div>

      {/* Edit Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Video</DialogTitle>
            <DialogDescription>Update the video title and description.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                disabled={isSaving}
              />
            </div>
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={3}
                disabled={isSaving}
              />
            </div>
            {editError && (
              <p className="text-sm text-destructive flex items-center gap-1">
                <AlertCircle className="h-4 w-4" />
                {editError}
              </p>
            )}
            <Button
              onClick={handleEdit}
              disabled={!editTitle.trim() || isSaving}
              className="w-full"
            >
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Version Dialog */}
      <Dialog open={showVersionDialog} onOpenChange={setShowVersionDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Version</DialogTitle>
            <DialogDescription>
              Upload a new version of &quot;{video.title}&quot;. The new version will become active.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label>Video URL</Label>
              <div className="relative">
                <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="https://youtube.com/watch?v=..."
                  value={versionUrl}
                  onChange={(e) => handleVersionUrlChange(e.target.value)}
                  className="pl-10"
                  disabled={isCreatingVersion}
                />
              </div>
              {versionUrlError && (
                <p className="text-sm text-destructive flex items-center gap-1">
                  <AlertCircle className="h-4 w-4" />
                  {versionUrlError}
                </p>
              )}
              {versionSource && (
                <p className="text-sm text-green-600 flex items-center gap-1">
                  <CheckCircle2 className="h-4 w-4" />
                  {versionSource.providerId.charAt(0).toUpperCase() +
                    versionSource.providerId.slice(1)}{' '}
                  video detected
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Version Label (optional)</Label>
              <Input
                placeholder="e.g. Final Cut, Review Round 2"
                value={versionLabel}
                onChange={(e) => setVersionLabel(e.target.value)}
                disabled={isCreatingVersion}
              />
            </div>
            <Button
              onClick={handleCreateVersion}
              disabled={!versionSource || isCreatingVersion}
              className="w-full"
            >
              {isCreatingVersion && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add Version {video.currentVersion + 1}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{video.title}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this video, all its versions, and all comments. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Move to another project */}
      <MoveVideosDialog
        open={showMoveDialog}
        onOpenChange={setShowMoveDialog}
        projectId={projectId}
        videoIds={[video.id]}
        onMoved={() => onDeleted?.(video.id)}
      />
    </>
  );
}
