'use client';

import { memo } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ChevronDown,
  GitCompareArrows,
  ListChecks,
  MoreVertical,
  Plus,
  Share2,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { DownloadControls } from '@/components/video-page/download-controls';
import { VersionDeleteDialog } from '@/components/video-page/version-delete-dialog';
import { VersionActionsDialog } from '@/components/video-page/version-actions-dialog';
import type {
  BunnyDownloadPreference,
  DownloadTarget,
  Version,
} from '@/components/video-page/types';
import type { VideoSource } from '@/lib/video-providers';

interface VideoPageHeaderProps {
  mode: 'dashboard' | 'watch';
  backHref: string;
  title: string;
  projectName: string;
  isFullscreenMode: boolean;
  cursorIdle: boolean;
  isPlaying: boolean;
  versions: Version[];
  activeVersion: Version;
  activeVersionId: string | null;
  onVersionSelect: (versionId: string) => void;
  onDeleteCurrentVersionClick: () => void;
  showDeleteVersionDialog: boolean;
  setShowDeleteVersionDialog: (open: boolean) => void;
  isDeletingVersion: boolean;
  onDeleteVersion: () => void;
  videoCanDownload: boolean;
  isDownloadingVideo: boolean;
  activeDownloadTarget: DownloadTarget | null;
  onDownload: (preference?: BunnyDownloadPreference) => void;
  projectId?: string;
  videoId: string;
  bunnyUploadsEnabled: boolean;
  showVersionDialog: boolean;
  setShowVersionDialog: (open: boolean) => void;
  newVersionMode: 'url' | 'file';
  setNewVersionMode: (mode: 'url' | 'file') => void;
  newVersionUrl: string;
  handleNewVersionUrlChange: (url: string) => void;
  newVersionUrlError: string;
  newVersionSource: VideoSource | null;
  newVersionFile: File | null;
  setNewVersionFile: (file: File | null) => void;
  newVersionLabel: string;
  setNewVersionLabel: (value: string) => void;
  newVersionUploadStatus: string;
  newVersionUploadProgress: number;
  isCreatingVersion: boolean;
  onCreateVersion: () => void;
  onOpenCompare: () => void;
  canRequestApproval: boolean;
  canShareVideo: boolean;
  hasPendingApprovalRequest: boolean;
  onOpenApprovalRequest: () => void;
  onOpenApprovalsPanel: () => void;
}

export const VideoPageHeader = memo(function VideoPageHeader({
  mode,
  backHref,
  title,
  projectName,
  isFullscreenMode,
  cursorIdle,
  isPlaying,
  versions,
  activeVersion,
  activeVersionId,
  onVersionSelect,
  onDeleteCurrentVersionClick,
  showDeleteVersionDialog,
  setShowDeleteVersionDialog,
  isDeletingVersion,
  onDeleteVersion,
  videoCanDownload,
  isDownloadingVideo,
  activeDownloadTarget,
  onDownload,
  projectId,
  videoId,
  bunnyUploadsEnabled,
  showVersionDialog,
  setShowVersionDialog,
  newVersionMode,
  setNewVersionMode,
  newVersionUrl,
  handleNewVersionUrlChange,
  newVersionUrlError,
  newVersionSource,
  newVersionFile,
  setNewVersionFile,
  newVersionLabel,
  setNewVersionLabel,
  newVersionUploadStatus,
  newVersionUploadProgress,
  isCreatingVersion,
  onCreateVersion,
  onOpenCompare,
  canRequestApproval,
  canShareVideo,
  hasPendingApprovalRequest,
  onOpenApprovalRequest,
  onOpenApprovalsPanel,
}: VideoPageHeaderProps) {
  const canManageVideo = canShareVideo || canRequestApproval;

  return (
    <div
      className={cn(
        'shrink-0 flex items-center justify-between h-12 px-4 border-b bg-background/50 gap-3',
        isFullscreenMode
          ? 'absolute top-0 left-0 right-0 z-50 transition-opacity duration-300'
          : '',
        isFullscreenMode && cursorIdle && isPlaying && 'opacity-0 pointer-events-none'
      )}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <Link
          href={backHref}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Link>
        <Separator orientation="vertical" className="h-5 shrink-0" />
        <div className="hidden sm:flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium truncate">{title}</span>
          <span className="text-xs text-muted-foreground shrink-0">•</span>
          <span className="text-xs text-muted-foreground truncate">{projectName}</span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Badge variant="secondary" className="mr-2">
                v{activeVersion.versionNumber}
              </Badge>
              {activeVersion.versionLabel || `Version ${activeVersion.versionNumber}`}
              <ChevronDown className="h-4 w-4 ml-2" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {versions.map((version) => (
              <DropdownMenuItem key={version.id} onClick={() => onVersionSelect(version.id)}>
                <Badge
                  variant={version.id === activeVersionId ? 'default' : 'secondary'}
                  className="mr-2"
                >
                  v{version.versionNumber}
                </Badge>
                {version.versionLabel || `Version ${version.versionNumber}`}
                <span className="ml-auto text-xs text-muted-foreground">
                  {version._count.comments} comments
                </span>
              </DropdownMenuItem>
            ))}
            {mode === 'dashboard' && versions.length > 1 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={onDeleteCurrentVersionClick}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Current Version
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <VersionDeleteDialog
          open={showDeleteVersionDialog}
          onOpenChange={setShowDeleteVersionDialog}
          isDeletingVersion={isDeletingVersion}
          onDelete={onDeleteVersion}
        />

        <div className="hidden sm:block">
          <DownloadControls
            activeVersion={activeVersion}
            videoCanDownload={videoCanDownload}
            isDownloading={isDownloadingVideo}
            activeDownloadTarget={activeDownloadTarget}
            onDownload={onDownload}
          />
        </div>

        {mode === 'dashboard' && (
          <>
            {canManageVideo ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowVersionDialog(true)}
                className="hidden sm:inline-flex"
              >
                <Plus className="h-4 w-4 mr-1" />
                New Version
              </Button>
            ) : null}

            <Button
              variant="outline"
              size="sm"
              onClick={onOpenApprovalsPanel}
              className="hidden sm:inline-flex"
            >
              <ListChecks className="h-4 w-4 mr-1" />
              Approvals
              {hasPendingApprovalRequest ? (
                <Badge variant="default" className="ml-2 hidden xl:inline-flex">
                  Pending
                </Badge>
              ) : null}
            </Button>

            {versions.length >= 2 && (
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenCompare}
                className="hidden sm:inline-flex"
              >
                <GitCompareArrows className="h-4 w-4 mr-1" />
                Compare
              </Button>
            )}

            {canManageVideo ? (
              <div className="hidden">
                <VersionActionsDialog
                  open={showVersionDialog}
                  onOpenChange={setShowVersionDialog}
                  bunnyUploadsEnabled={bunnyUploadsEnabled}
                  newVersionMode={newVersionMode}
                  onNewVersionModeChange={setNewVersionMode}
                  newVersionUrl={newVersionUrl}
                  onNewVersionUrlChange={handleNewVersionUrlChange}
                  newVersionUrlError={newVersionUrlError}
                  newVersionSource={newVersionSource}
                  newVersionFile={newVersionFile}
                  onNewVersionFileChange={setNewVersionFile}
                  newVersionLabel={newVersionLabel}
                  onNewVersionLabelChange={setNewVersionLabel}
                  newVersionUploadStatus={newVersionUploadStatus}
                  newVersionUploadProgress={newVersionUploadProgress}
                  isCreatingVersion={isCreatingVersion}
                  versionsCount={versions.length}
                  onCreateVersion={onCreateVersion}
                />
              </div>
            ) : null}

            {(canShareVideo || canRequestApproval) && (
              <div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="w-7 px-0 self-center">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {canShareVideo ? (
                      <DropdownMenuItem asChild>
                        <Link href={`/projects/${projectId}/videos/${videoId}/share`}>
                          <Share2 className="h-4 w-4 mr-2" />
                          Share Video
                        </Link>
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem disabled>
                        <Share2 className="h-4 w-4 mr-2" />
                        Share Video
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onSelect={onOpenApprovalRequest}
                      disabled={!canRequestApproval}
                    >
                      <ShieldCheck className="h-4 w-4 mr-2" />
                      Request Approval
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
