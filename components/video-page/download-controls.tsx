'use client';

import { memo } from 'react';
import { ChevronDown, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type {
  BunnyDownloadPreference,
  DownloadTarget,
  Version,
} from '@/components/video-page/types';

interface DownloadControlsProps {
  activeVersion: Version | null | undefined;
  videoCanDownload: boolean;
  isDownloading: boolean;
  activeDownloadTarget: DownloadTarget | null;
  onDownload: (preference?: BunnyDownloadPreference) => void;
  compact?: boolean;
}

interface DownloadMenuItemsProps {
  activeVersion: Version | null | undefined;
  videoCanDownload: boolean;
  isDownloading: boolean;
  activeDownloadTarget: DownloadTarget | null;
  onDownload: (preference?: BunnyDownloadPreference) => void;
}

export const DownloadControls = memo(function DownloadControls({
  activeVersion,
  videoCanDownload,
  isDownloading,
  activeDownloadTarget,
  onDownload,
  compact = false,
}: DownloadControlsProps) {
  if (!activeVersion) return null;

  const isVideoDownloadAvailable =
    videoCanDownload &&
    (activeVersion.providerId === 'bunny' || activeVersion.providerId === 'direct');

  if (activeVersion.providerId === 'bunny') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size={compact ? 'icon' : 'sm'}
            className={cn(
              compact && 'h-8 w-8',
              'transition-opacity duration-300',
              isDownloading && 'opacity-50 pointer-events-none'
            )}
            disabled={!isVideoDownloadAvailable || isDownloading}
          >
            {isDownloading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className={cn('h-4 w-4', !compact && 'mr-1')} />
            )}
            {!compact && (
              <>
                Download
                <ChevronDown className="h-4 w-4 ml-1" />
              </>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              onDownload('original');
            }}
            disabled={!isVideoDownloadAvailable || isDownloading}
          >
            {activeDownloadTarget === 'original' ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            Download Original
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              onDownload('compressed');
            }}
            disabled={!isVideoDownloadAvailable || isDownloading}
          >
            {activeDownloadTarget === 'compressed' ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            Download Compressed
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (compact) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className={cn(
              'h-8 w-8 transition-opacity duration-300',
              isDownloading && 'opacity-50 pointer-events-none'
            )}
            disabled={!isVideoDownloadAvailable || isDownloading}
          >
            {isDownloading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              onDownload();
            }}
            disabled={!isVideoDownloadAvailable || isDownloading}
          >
            {isDownloading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            Download
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        'transition-opacity duration-300',
        isDownloading && 'opacity-50 pointer-events-none'
      )}
      onClick={() => onDownload()}
      disabled={!isVideoDownloadAvailable || isDownloading}
    >
      {isDownloading ? (
        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
      ) : (
        <Download className="h-4 w-4 mr-1" />
      )}
      Download
    </Button>
  );
});

export const DownloadMenuItems = memo(function DownloadMenuItems({
  activeVersion,
  videoCanDownload,
  isDownloading,
  activeDownloadTarget,
  onDownload,
}: DownloadMenuItemsProps) {
  if (!activeVersion) return null;

  const isVideoDownloadAvailable =
    videoCanDownload &&
    (activeVersion.providerId === 'bunny' || activeVersion.providerId === 'direct');

  if (activeVersion.providerId === 'bunny') {
    return (
      <>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onDownload('original');
          }}
          disabled={!isVideoDownloadAvailable || isDownloading}
        >
          {activeDownloadTarget === 'original' ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          Download Original
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onDownload('compressed');
          }}
          disabled={!isVideoDownloadAvailable || isDownloading}
        >
          {activeDownloadTarget === 'compressed' ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          Download Compressed
        </DropdownMenuItem>
      </>
    );
  }

  return (
    <DropdownMenuItem
      onSelect={(event) => {
        event.preventDefault();
        onDownload();
      }}
      disabled={!isVideoDownloadAvailable || isDownloading}
    >
      {isDownloading ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : (
        <Download className="h-4 w-4 mr-2" />
      )}
      Download
    </DropdownMenuItem>
  );
});
