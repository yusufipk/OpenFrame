'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, UploadCloud, XCircle } from 'lucide-react';
import { toast } from 'sonner';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import {
  cleanupPendingProjectUpload,
  getDefaultTitleFromFile,
  isVideoFile,
  uploadProjectVideo,
  type ActiveTusUpload,
  type PendingProjectUploadCleanup,
} from '@/lib/client/project-video-upload';
import type { DirectUploadProvider } from '@/components/video-page/types';

type ProjectOption = {
  id: string;
  name: string;
  description?: string | null;
};

type QueueItemStatus = 'pending' | 'uploading' | 'done' | 'error' | 'cancelled';

type QueueItem = {
  id: string;
  file: File;
  status: QueueItemStatus;
  progress: number;
  error?: string;
};

interface VideoDragDropUploaderProps {
  fixedProjectId?: string;
  fixedProjectName?: string;
  workspaceId?: string;
  projectOptions?: ProjectOption[];
  canUpload?: boolean;
  directUploadProvider?: DirectUploadProvider;
}

function hasFileData(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types || []).includes('Files');
}

function createQueueItem(file: File): QueueItem {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
    file,
    status: 'pending',
    progress: 0,
  };
}

export function VideoDragDropUploader({
  fixedProjectId,
  fixedProjectName,
  workspaceId,
  projectOptions,
  canUpload = false,
  directUploadProvider = 'bunny',
}: VideoDragDropUploaderProps) {
  const router = useRouter();

  const [projects, setProjects] = useState<ProjectOption[]>(projectOptions ?? []);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showCancelUploadDialog, setShowCancelUploadDialog] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(fixedProjectId ?? null);
  const [selectedProjectName, setSelectedProjectName] = useState<string | null>(
    fixedProjectName ?? null
  );

  const activeTusUploadRef = useRef<ActiveTusUpload | null>(null);
  const pendingUploadRef = useRef<(PendingProjectUploadCleanup & { projectId: string }) | null>(
    null
  );
  const cancelRequestedRef = useRef(false);
  const dragDepthRef = useRef(0);
  const hasLoadedProjectsRef = useRef(false);

  const needsProjectSelection = !fixedProjectId;
  const bunnyCdnHostname = useMemo(() => resolvePublicBunnyCdnHostname(), []);

  const projectsById = useMemo(() => {
    return new Map(projects.map((project) => [project.id, project.name]));
  }, [projects]);

  const pendingCount = queue.filter((item) => item.status === 'pending').length;
  const doneCount = queue.filter((item) => item.status === 'done').length;
  const errorCount = queue.filter((item) => item.status === 'error').length;
  const totalCount = queue.length;
  const hasQueue = totalCount > 0;

  const ensureProjectsLoaded = useCallback(async () => {
    if (!canUpload) return;
    if (!needsProjectSelection) return;
    if (hasLoadedProjectsRef.current) return;
    if (projectOptions && projectOptions.length > 0) {
      setProjects(projectOptions);
      hasLoadedProjectsRef.current = true;
      return;
    }

    setIsLoadingProjects(true);
    try {
      const pageSize = 100;
      let page = 1;
      let totalPages = 1;
      const collected = new Map<string, ProjectOption>();

      while (page <= totalPages) {
        const query = new URLSearchParams({
          limit: pageSize.toString(),
          page: page.toString(),
        });
        if (workspaceId) {
          query.set('workspaceId', workspaceId);
        }

        const response = await fetch(`/api/projects?${query.toString()}`, {
          cache: 'no-store',
        });
        const payload = (await response.json().catch(() => null)) as {
          data?: { projects?: Array<{ id: string; name: string; description?: string | null }> };
          meta?: { totalPages?: number };
          error?: string;
        } | null;

        if (!response.ok) {
          throw new Error(payload?.error || 'Failed to load projects');
        }

        const pageProjects = payload?.data?.projects || [];
        for (const project of pageProjects) {
          collected.set(project.id, {
            id: project.id,
            name: project.name,
            description: project.description ?? null,
          });
        }

        totalPages = Math.max(payload?.meta?.totalPages ?? page, page);
        page += 1;
      }

      setProjects(Array.from(collected.values()));
      hasLoadedProjectsRef.current = true;
    } catch (error) {
      console.error('Failed to load projects for upload:', error);
      toast.error('Failed to load projects for upload');
    } finally {
      setIsLoadingProjects(false);
    }
  }, [canUpload, needsProjectSelection, projectOptions, workspaceId]);

  useEffect(() => {
    if (!canUpload) {
      setDialogOpen(false);
      setQueue([]);
    }
  }, [canUpload]);

  useEffect(() => {
    hasLoadedProjectsRef.current = false;
    if (projectOptions && projectOptions.length > 0) {
      setProjects(projectOptions);
    } else if (needsProjectSelection) {
      setProjects([]);
    }
  }, [needsProjectSelection, projectOptions, workspaceId]);

  const resetUploadState = useCallback(() => {
    activeTusUploadRef.current = null;
    pendingUploadRef.current = null;
    setIsUploading(false);
    setUploadStatus('');
    setUploadProgress(0);
  }, []);

  const cancelPendingUpload = useCallback(async () => {
    if (!isUploading) return;
    cancelRequestedRef.current = true;

    if (activeTusUploadRef.current) {
      try {
        await Promise.resolve(activeTusUploadRef.current.abort(false));
      } catch {
        // Ignore abort failures and continue cleanup.
      } finally {
        activeTusUploadRef.current = null;
      }
    }

    const pending = pendingUploadRef.current;
    if (pending) {
      await cleanupPendingProjectUpload(pending.projectId, pending);
    }

    setQueue((prev) =>
      prev.map((item) =>
        item.status === 'uploading' || item.status === 'pending'
          ? { ...item, status: 'cancelled' as const }
          : item
      )
    );

    resetUploadState();
    setShowCancelUploadDialog(false);
    toast.info('Upload cancelled');
  }, [isUploading, resetUploadState]);

  const uploadQueueToProject = useCallback(
    async (files: File[], projectId: string, projectName?: string) => {
      if (files.length === 0) return;

      setDialogOpen(true);
      cancelRequestedRef.current = false;
      setIsUploading(true);
      setSelectedProjectId(projectId);
      setSelectedProjectName(projectName ?? projectsById.get(projectId) ?? null);

      const initialQueue = files.map(createQueueItem);
      setQueue(initialQueue);

      let successCount = 0;
      let failCount = 0;

      for (let index = 0; index < initialQueue.length; index++) {
        if (cancelRequestedRef.current) break;

        const item = initialQueue[index];
        setUploadProgress(0);
        setUploadStatus(`Uploading ${index + 1} of ${initialQueue.length}: ${item.file.name}`);

        setQueue((prev) =>
          prev.map((entry) =>
            entry.id === item.id
              ? { ...entry, status: 'uploading', progress: 0, error: undefined }
              : entry
          )
        );

        try {
          await uploadProjectVideo(projectId, item.file, {
            provider: directUploadProvider,
            bunnyCdnHostname,
            onProgress: (progress) => {
              setUploadProgress(progress);
              setQueue((prev) =>
                prev.map((entry) => (entry.id === item.id ? { ...entry, progress } : entry))
              );
            },
            onStatus: (status) => {
              setUploadStatus(`Uploading ${index + 1} of ${initialQueue.length}: ${status}`);
            },
            onTusUploadReady: (upload) => {
              activeTusUploadRef.current = upload;
            },
            onPendingUpload: (pending) => {
              pendingUploadRef.current = { ...pending, projectId };
            },
            isCancelled: () => cancelRequestedRef.current,
          });

          if (cancelRequestedRef.current) break;

          pendingUploadRef.current = null;
          activeTusUploadRef.current = null;
          successCount += 1;

          setQueue((prev) =>
            prev.map((entry) =>
              entry.id === item.id ? { ...entry, status: 'done', progress: 100 } : entry
            )
          );
        } catch (error) {
          if (cancelRequestedRef.current) break;

          pendingUploadRef.current = null;
          activeTusUploadRef.current = null;
          failCount += 1;

          const message = error instanceof Error ? error.message : 'Failed to upload video';
          setQueue((prev) =>
            prev.map((entry) =>
              entry.id === item.id ? { ...entry, status: 'error', error: message } : entry
            )
          );
          toast.error(`${item.file.name}: ${message}`);
        }
      }

      resetUploadState();

      if (cancelRequestedRef.current) {
        return;
      }

      if (successCount > 0) {
        router.refresh();
      }

      if (successCount > 0 && failCount === 0) {
        toast.success(
          successCount === 1
            ? `Video uploaded to ${projectName ?? projectsById.get(projectId) ?? 'project'}`
            : `${successCount} videos uploaded to ${projectName ?? projectsById.get(projectId) ?? 'project'}`
        );
        if (fixedProjectId) {
          setDialogOpen(false);
          setQueue([]);
        }
      } else if (successCount > 0 && failCount > 0) {
        toast.warning(`${successCount} uploaded, ${failCount} failed`);
      } else if (failCount > 0) {
        toast.error('All uploads failed');
      }
    },
    [bunnyCdnHostname, directUploadProvider, fixedProjectId, projectsById, resetUploadState, router]
  );

  const handleDropFiles = useCallback(
    (files: File[]) => {
      if (!canUpload) {
        toast.error('You do not have permission to upload videos here');
        return;
      }

      const videoFiles = files.filter(isVideoFile);
      const invalidCount = files.length - videoFiles.length;

      if (videoFiles.length === 0) {
        toast.error('Please drop valid video files');
        return;
      }

      if (invalidCount > 0) {
        toast.error(`${invalidCount} file${invalidCount === 1 ? '' : 's'} skipped (not a video)`);
      }

      if (fixedProjectId) {
        void uploadQueueToProject(videoFiles, fixedProjectId, fixedProjectName);
        return;
      }

      setQueue(videoFiles.map(createQueueItem));
      setDialogOpen(true);
      void ensureProjectsLoaded();
    },
    [canUpload, ensureProjectsLoaded, fixedProjectId, fixedProjectName, uploadQueueToProject]
  );

  useEffect(() => {
    const handleDragEnter = (event: DragEvent) => {
      if (!hasFileData(event.dataTransfer)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDragActive(true);
    };

    const handleDragOver = (event: DragEvent) => {
      if (!hasFileData(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    };

    const handleDragLeave = (event: DragEvent) => {
      if (!hasFileData(event.dataTransfer)) return;
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDragActive(false);
      }
    };

    const handleDrop = (event: DragEvent) => {
      if (!hasFileData(event.dataTransfer)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragActive(false);

      const allFiles = Array.from(event.dataTransfer?.files ?? []);
      if (allFiles.length === 0) return;

      handleDropFiles(allFiles);
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, [handleDropFiles]);

  const closeDialog = useCallback(() => {
    setQueue([]);
    setUploadStatus('');
    setUploadProgress(0);
    setSelectedProjectId(fixedProjectId ?? null);
    setSelectedProjectName(fixedProjectName ?? null);
  }, [fixedProjectId, fixedProjectName]);

  return (
    <>
      {isDragActive && (
        <div className="pointer-events-none fixed inset-0 z-[100] bg-background/80 backdrop-blur-sm">
          <div className="flex h-full items-center justify-center px-4">
            <div className="w-full max-w-2xl rounded-2xl border-2 border-dashed border-primary bg-background p-10 text-center shadow-2xl">
              <UploadCloud className="mx-auto mb-4 h-10 w-10 text-primary" />
              <p className="text-lg font-semibold">Drop videos to upload</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {fixedProjectId
                  ? `Upload multiple videos to ${fixedProjectName ?? 'current project'}`
                  : 'Drop multiple videos, then choose a project.'}
              </p>
            </div>
          </div>
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            if (isUploading) {
              setShowCancelUploadDialog(true);
              return;
            }
            closeDialog();
          }
          setDialogOpen(open);
        }}
      >
        <DialogContent className="border-2 border-border bg-background text-foreground sm:max-w-xl">
          <DialogHeader className="space-y-1">
            <DialogTitle className="text-2xl font-bold">
              {needsProjectSelection ? 'Choose a project' : 'Uploading videos'}
            </DialogTitle>
            <DialogDescription>
              {hasQueue
                ? totalCount === 1
                  ? `Upload 1 video${needsProjectSelection ? ' to:' : ''}`
                  : `Upload ${totalCount} videos${needsProjectSelection ? ' to:' : ''}`
                : 'Drop video files anywhere on this page to start.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {hasQueue && (
              <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                {queue.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0"
                  >
                    {item.status === 'done' ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
                    ) : item.status === 'error' ? (
                      <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                    ) : item.status === 'uploading' ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                    ) : item.status === 'cancelled' ? (
                      <XCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <div className="h-4 w-4 shrink-0 rounded-full border border-muted-foreground/40" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{item.file.name}</p>
                      {item.error ? (
                        <p className="truncate text-xs text-destructive">{item.error}</p>
                      ) : (
                        <p className="truncate text-xs text-muted-foreground">
                          {getDefaultTitleFromFile(item.file)}
                          {item.status === 'uploading' && item.progress > 0
                            ? ` · ${item.progress}%`
                            : ''}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!fixedProjectId && (
              <div className="space-y-2">
                {isLoadingProjects ? (
                  <p className="text-sm text-muted-foreground">Loading projects...</p>
                ) : projects.length > 0 ? (
                  <div className="max-h-80 overflow-y-auto border border-border">
                    {projects.map((project) => (
                      <button
                        key={project.id}
                        tabIndex={hasQueue && !isUploading ? 0 : -1}
                        disabled={!hasQueue || isUploading || pendingCount === 0}
                        aria-disabled={!hasQueue || isUploading || pendingCount === 0}
                        className={`block w-full border-b border-border p-4 text-left transition-colors last:border-b-0 ${selectedProjectId === project.id ? 'bg-accent' : 'bg-background'} ${!hasQueue || isUploading ? 'opacity-60' : 'hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'}`}
                        onClick={() => {
                          if (!hasQueue || isUploading) return;
                          const pendingFiles = queue
                            .filter((item) => item.status === 'pending')
                            .map((item) => item.file);
                          if (pendingFiles.length === 0) return;
                          setSelectedProjectId(project.id);
                          setSelectedProjectName(project.name);
                          void uploadQueueToProject(pendingFiles, project.id, project.name);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          if (!hasQueue || isUploading) return;
                          event.preventDefault();
                          const pendingFiles = queue
                            .filter((item) => item.status === 'pending')
                            .map((item) => item.file);
                          if (pendingFiles.length === 0) return;
                          setSelectedProjectId(project.id);
                          setSelectedProjectName(project.name);
                          void uploadQueueToProject(pendingFiles, project.id, project.name);
                        }}
                      >
                        <p className="text-2xl font-semibold leading-tight text-foreground">
                          {project.name}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {project.description || 'Project'}
                        </p>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No projects available</p>
                )}
              </div>
            )}

            {(selectedProjectId || fixedProjectId) && (
              <p className="text-sm text-muted-foreground">
                Target:{' '}
                <span className="font-medium text-foreground">
                  {selectedProjectName ??
                    fixedProjectName ??
                    projectsById.get(selectedProjectId ?? '')}
                </span>
              </p>
            )}

            {isUploading && (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {uploadStatus || 'Uploading...'}
                </p>
                {uploadProgress > 0 && uploadProgress < 100 && (
                  <div className="h-2 w-full rounded-full bg-secondary">
                    <div
                      className="h-2 rounded-full bg-primary transition-all"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                )}
                {totalCount > 1 && (
                  <p className="text-xs text-muted-foreground">
                    {doneCount} of {totalCount} complete
                    {errorCount > 0 ? ` · ${errorCount} failed` : ''}
                  </p>
                )}
              </div>
            )}

            {!fixedProjectId && !isUploading && hasQueue && pendingCount > 0 && (
              <p className="text-xs text-muted-foreground">
                Click a project card to start uploading {pendingCount} video
                {pendingCount === 1 ? '' : 's'}.
              </p>
            )}

            {!isUploading && hasQueue && (doneCount > 0 || errorCount > 0) && (
              <p className="text-xs text-muted-foreground">
                {doneCount > 0 ? `${doneCount} uploaded` : ''}
                {doneCount > 0 && errorCount > 0 ? ', ' : ''}
                {errorCount > 0 ? `${errorCount} failed` : ''}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showCancelUploadDialog} onOpenChange={setShowCancelUploadDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel upload?</AlertDialogTitle>
            <AlertDialogDescription>
              {totalCount > 1
                ? 'Video uploads are in progress. If you cancel now, the current upload and any remaining queued files will be discarded.'
                : 'A video upload is in progress. If you cancel now, the current upload will be discarded.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!isUploading}>Keep uploading</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!isUploading}
              onClick={() => {
                void cancelPendingUpload();
              }}
            >
              Cancel upload
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
