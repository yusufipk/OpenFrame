'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, UploadCloud } from 'lucide-react';
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

type ProjectOption = {
  id: string;
  name: string;
  description?: string | null;
};

interface VideoDragDropUploaderProps {
  fixedProjectId?: string;
  fixedProjectName?: string;
  workspaceId?: string;
  projectOptions?: ProjectOption[];
  canUpload?: boolean;
}

const VIDEO_FILE_EXTENSIONS = ['mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv'];
type ActiveTusUpload = { abort: (shouldTerminate?: boolean) => Promise<unknown> | void };

function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return !!ext && VIDEO_FILE_EXTENSIONS.includes(ext);
}

function extractVideoFile(dataTransfer: DataTransfer | null): File | null {
  if (!dataTransfer?.files?.length) return null;
  const files = Array.from(dataTransfer.files);
  return files.find(isVideoFile) ?? null;
}

function hasFileData(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types || []).includes('Files');
}

function getDefaultTitleFromFile(file: File): string {
  const withoutExt = file.name.replace(/\.[^/.]+$/, '').trim();
  return withoutExt || file.name;
}

export function VideoDragDropUploader({
  fixedProjectId,
  fixedProjectName,
  workspaceId,
  projectOptions,
  canUpload = false,
}: VideoDragDropUploaderProps) {
  const router = useRouter();

  const [projects, setProjects] = useState<ProjectOption[]>(projectOptions ?? []);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showCancelUploadDialog, setShowCancelUploadDialog] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(fixedProjectId ?? null);
  const [selectedProjectName, setSelectedProjectName] = useState<string | null>(fixedProjectName ?? null);

  const activeTusUploadRef = useRef<ActiveTusUpload | null>(null);
  const pendingUploadRef = useRef<{ projectId: string; videoId: string; uploadToken: string } | null>(null);
  const cancelRequestedRef = useRef(false);
  const dragDepthRef = useRef(0);
  const hasLoadedProjectsRef = useRef(false);

  const needsProjectSelection = !fixedProjectId;
  const bunnyCdnHostname = useMemo(() => resolvePublicBunnyCdnHostname(), []);

  const projectsById = useMemo(() => {
    return new Map(projects.map((project) => [project.id, project.name]));
  }, [projects]);

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
      setDroppedFile(null);
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

  const cleanupUploadState = useCallback(() => {
    activeTusUploadRef.current = null;
    pendingUploadRef.current = null;
    setIsUploading(false);
    setUploadStatus('');
    setUploadProgress(0);
  }, []);

  const cancelPendingUpload = useCallback(async () => {
    if (!isUploading) return;
    cancelRequestedRef.current = true;
    const pending = pendingUploadRef.current;

    if (activeTusUploadRef.current) {
      try {
        await Promise.resolve(activeTusUploadRef.current.abort(false));
      } catch {
        // Ignore abort failures and continue cleanup.
      } finally {
        activeTusUploadRef.current = null;
      }
    }

    if (pending) {
      try {
        await fetch(`/api/projects/${pending.projectId}/videos/bunny-init`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: pending.videoId, uploadToken: pending.uploadToken }),
        });
      } catch (error) {
        console.error('Failed to cleanup cancelled upload:', error);
      }
    }

    cleanupUploadState();
    setDroppedFile(null);
    setDialogOpen(false);
    setShowCancelUploadDialog(false);
    toast.info('Upload cancelled');
  }, [cleanupUploadState, isUploading]);

  const uploadFileToProject = useCallback(async (file: File, projectId: string, projectName?: string) => {
    setDialogOpen(true);
    cancelRequestedRef.current = false;
    setIsUploading(true);
    setUploadStatus('Initializing upload...');
    setUploadProgress(0);
    setSelectedProjectId(projectId);
    setSelectedProjectName(projectName ?? projectsById.get(projectId) ?? null);

    let createdVideoId: string | null = null;
    let uploadToken: string | null = null;

    try {
      const title = getDefaultTitleFromFile(file);

      const initResponse = await fetch(`/api/projects/${projectId}/videos/bunny-init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });

      const initPayload = (await initResponse.json().catch(() => null)) as {
        data?: {
          videoId: string;
          libraryId: string;
          signature: string;
          expirationTime: number;
          uploadToken: string;
        };
        error?: string;
      } | null;

      if (!initResponse.ok || !initPayload?.data) {
        throw new Error(initPayload?.error || 'Failed to initialize upload');
      }

      createdVideoId = initPayload.data.videoId;
      uploadToken = initPayload.data.uploadToken;
      pendingUploadRef.current = {
        projectId,
        videoId: createdVideoId,
        uploadToken,
      };

      const { Upload } = await import('tus-js-client');
      await new Promise<void>((resolve, reject) => {
        const upload = new Upload(file, {
          endpoint: 'https://video.bunnycdn.com/tusupload',
          retryDelays: [0, 3000, 5000, 10000, 20000],
          headers: {
            AuthorizationSignature: initPayload.data!.signature,
            AuthorizationExpire: initPayload.data!.expirationTime.toString(),
            VideoId: initPayload.data!.videoId,
            LibraryId: initPayload.data!.libraryId,
          },
          metadata: {
            filetype: file.type,
            title,
          },
          onError: (error) => {
            activeTusUploadRef.current = null;
            reject(new Error(error.message));
          },
          onProgress: (bytesUploaded, bytesTotal) => {
            const percentage = Number(((bytesUploaded / bytesTotal) * 100).toFixed(1));
            setUploadProgress(percentage);
            setUploadStatus(`Uploading... ${percentage}%`);
          },
          onSuccess: () => {
            activeTusUploadRef.current = null;
            resolve();
          },
        });

        activeTusUploadRef.current = upload;
        upload.start();
      });

      setUploadStatus('Saving video...');

      const createResponse = await fetch(`/api/projects/${projectId}/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: null,
          videoUrl: `https://iframe.mediadelivery.net/embed/${initPayload.data.libraryId}/${initPayload.data.videoId}`,
          providerId: 'bunny',
          videoId: initPayload.data.videoId,
          thumbnailUrl: bunnyCdnHostname
            ? `https://${bunnyCdnHostname}/${initPayload.data.videoId}/thumbnail.jpg`
            : null,
          duration: null,
          uploadToken,
        }),
      });

      const createPayload = (await createResponse.json().catch(() => null)) as { error?: string } | null;

      if (!createResponse.ok) {
        throw new Error(createPayload?.error || 'Failed to create video');
      }

      toast.success(`Video uploaded to ${projectName ?? projectsById.get(projectId) ?? 'project'}`);
      setDialogOpen(false);
      setDroppedFile(null);
      cleanupUploadState();
      router.push(`/projects/${projectId}`);
      router.refresh();
    } catch (error) {
      console.error('Drag-drop upload failed:', error);

      if (cancelRequestedRef.current) {
        setUploadStatus('');
        setUploadProgress(0);
        setIsUploading(false);
        return;
      }

      if (createdVideoId && uploadToken) {
        try {
          await fetch(`/api/projects/${projectId}/videos/bunny-init`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId: createdVideoId, uploadToken }),
          });
        } catch (cleanupError) {
          console.error('Failed to cleanup pending upload:', cleanupError);
        }
      }

      setUploadStatus('');
      setUploadProgress(0);
      setIsUploading(false);
      toast.error(error instanceof Error ? error.message : 'Failed to upload video');
    }
  }, [bunnyCdnHostname, cleanupUploadState, projectsById, router]);

  const handleDropFile = useCallback((file: File) => {
    if (!canUpload) {
      toast.error('You do not have permission to upload videos here');
      return;
    }

    setDroppedFile(file);

    if (fixedProjectId) {
      void uploadFileToProject(file, fixedProjectId, fixedProjectName);
      return;
    }

    setDialogOpen(true);
    void ensureProjectsLoaded();
  }, [canUpload, ensureProjectsLoaded, fixedProjectId, fixedProjectName, uploadFileToProject]);

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

      const videoFile = extractVideoFile(event.dataTransfer);
      if (!videoFile) {
        toast.error('Please drop a valid video file');
        return;
      }

      handleDropFile(videoFile);
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
  }, [handleDropFile]);

  return (
    <>
      {isDragActive && (
        <div className="pointer-events-none fixed inset-0 z-[100] bg-background/80 backdrop-blur-sm">
          <div className="flex h-full items-center justify-center px-4">
            <div className="w-full max-w-2xl rounded-2xl border-2 border-dashed border-primary bg-background p-10 text-center shadow-2xl">
              <UploadCloud className="mx-auto mb-4 h-10 w-10 text-primary" />
              <p className="text-lg font-semibold">Drop video to upload</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {fixedProjectId
                  ? `Upload to ${fixedProjectName ?? 'current project'}`
                  : 'Drop now, then choose a project card.'}
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
            setDroppedFile(null);
            setUploadStatus('');
            setUploadProgress(0);
            setSelectedProjectId(fixedProjectId ?? null);
            setSelectedProjectName(fixedProjectName ?? null);
          }
          setDialogOpen(open);
        }}
      >
        <DialogContent className="border-2 border-border bg-background text-foreground sm:max-w-xl">
          <DialogHeader className="space-y-1">
            <DialogTitle className="text-2xl font-bold">Choose a project</DialogTitle>
            <DialogDescription>
              {droppedFile
                ? 'Upload 1 video to:'
                : 'Drop a video file anywhere on this page to start.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!fixedProjectId && (
              <div className="space-y-2">
                {isLoadingProjects ? (
                  <p className="text-sm text-muted-foreground">Loading projects...</p>
                ) : projects.length > 0 ? (
                  <div className="max-h-80 overflow-y-auto border border-border">
                    {projects.map((project) => (
                      <button
                        key={project.id}
                        tabIndex={droppedFile && !isUploading ? 0 : -1}
                        disabled={!droppedFile || isUploading}
                        aria-disabled={!droppedFile || isUploading}
                        className={`block w-full border-b border-border p-4 text-left transition-colors last:border-b-0 ${selectedProjectId === project.id ? 'bg-accent' : 'bg-background'} ${!droppedFile || isUploading ? 'opacity-60' : 'hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'}`}
                        onClick={() => {
                          if (!droppedFile || isUploading) return;
                          setSelectedProjectId(project.id);
                          setSelectedProjectName(project.name);
                          void uploadFileToProject(droppedFile, project.id, project.name);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          if (!droppedFile || isUploading) return;
                          event.preventDefault();
                          setSelectedProjectId(project.id);
                          setSelectedProjectName(project.name);
                          void uploadFileToProject(droppedFile, project.id, project.name);
                        }}
                      >
                        <p className="text-2xl font-semibold leading-tight text-foreground">{project.name}</p>
                        <p className="mt-1 text-sm text-muted-foreground">{project.description || 'Project'}</p>
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
                Target: <span className="font-medium text-foreground">{selectedProjectName ?? fixedProjectName ?? projectsById.get(selectedProjectId ?? '')}</span>
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
                    <div className="h-2 rounded-full bg-primary transition-all" style={{ width: `${uploadProgress}%` }} />
                  </div>
                )}
              </div>
            )}

            {!fixedProjectId && !isUploading && droppedFile && (
              <p className="text-xs text-muted-foreground">
                Click a project card to start uploading.
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
              A video upload is in progress. If you cancel now, the current upload will be discarded.
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
