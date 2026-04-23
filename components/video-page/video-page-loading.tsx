'use client';

import { memo } from 'react';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface VideoPageLoadingProps {
  containerHeight: string;
  mode: 'dashboard' | 'watch';
  isFullscreenMode: boolean;
  cursorIdle: boolean;
  isPlaying: boolean;
  showComments: boolean;
}

export const VideoPageLoading = memo(function VideoPageLoading({
  containerHeight,
  mode,
  isFullscreenMode,
  cursorIdle,
  isPlaying,
  showComments,
}: VideoPageLoadingProps) {
  return (
    <div className={cn(containerHeight, 'flex flex-col bg-background overflow-hidden')}>
      <div className="flex-1 flex overflow-hidden min-h-0">
        <div
          className={cn(
            'flex-1 flex flex-col overflow-hidden min-h-0',
            isFullscreenMode && 'relative'
          )}
        >
          <div
            className={cn(
              'shrink-0 flex items-center justify-between h-12 px-4 border-b bg-background/50',
              isFullscreenMode &&
                cursorIdle &&
                isPlaying &&
                'opacity-0 pointer-events-none transition-opacity duration-300'
            )}
          >
            <div className="flex items-center gap-3">
              <Skeleton className="h-4 w-12" />
              <Separator orientation="vertical" className="h-5" />
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-24" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-32 rounded-md" />
              {mode === 'dashboard' && <Skeleton className="h-8 w-28 rounded-md" />}
            </div>
          </div>
          <div className="flex-1 bg-black min-h-0" />
          <div
            className={cn(
              'shrink-0 px-4 py-2 bg-background border-t',
              isFullscreenMode &&
                cursorIdle &&
                isPlaying &&
                'opacity-0 pointer-events-none transition-opacity duration-300'
            )}
          >
            <div className="flex items-center gap-1 mb-2">
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-4 w-24 ml-1" />
              <div className="ml-auto">
                <Skeleton className="h-8 w-12 rounded-md" />
              </div>
            </div>
            <Skeleton className="h-8 w-full rounded" />
          </div>
        </div>
        <div
          className={cn(
            'hidden lg:flex w-80 shrink-0 border-l bg-card flex-col overflow-hidden',
            isFullscreenMode && !showComments && 'hidden'
          )}
        >
          <div className="shrink-0 flex items-center justify-between p-4 border-b">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-5" />
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-6 rounded-full" />
            </div>
            <Skeleton className="h-8 w-28 rounded-md" />
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-6 w-6 rounded-full" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                  <Skeleton className="h-5 w-14 rounded" />
                </div>
                <Skeleton className="h-4 w-full mb-1" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ))}
          </div>
          <div className="shrink-0 border-t p-4">
            <Skeleton className="h-20 w-full rounded-md" />
            <div className="flex items-center justify-between mt-2">
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-8 w-20 rounded-md" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
