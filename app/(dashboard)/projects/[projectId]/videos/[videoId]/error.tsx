'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Film } from 'lucide-react';

export default function VideoError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Video player error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4 p-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="relative">
          <Film className="h-12 w-12 text-muted-foreground" />
          <AlertTriangle className="absolute -bottom-1 -right-1 h-6 w-6 text-destructive" />
        </div>
        <h1 className="text-2xl font-bold">Video Player Error</h1>
        <p className="text-muted-foreground max-w-md">
          Something went wrong with the video player. This could be due to a network issue or a
          problem with the video file.
        </p>
        {error.digest && <p className="text-muted-foreground text-xs">Error ID: {error.digest}</p>}
      </div>
      <div className="flex gap-2">
        <Button onClick={reset} variant="default">
          Reload video
        </Button>
        <Button onClick={() => window.history.back()} variant="outline">
          Go back
        </Button>
      </div>
    </div>
  );
}
