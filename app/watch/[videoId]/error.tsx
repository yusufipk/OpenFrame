'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Film } from 'lucide-react';

export default function WatchError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Watch page error:', error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="relative">
          <Film className="h-12 w-12 text-muted-foreground" />
          <AlertTriangle className="absolute -bottom-1 -right-1 h-6 w-6 text-destructive" />
        </div>
        <h1 className="text-2xl font-bold">Video Unavailable</h1>
        <p className="text-muted-foreground max-w-md">
          We couldn&apos;t load this video. It may have been removed or the link might be incorrect.
        </p>
        {error.digest && <p className="text-muted-foreground text-xs">Error ID: {error.digest}</p>}
      </div>
      <div className="flex gap-2">
        <Button onClick={reset} variant="default">
          Try again
        </Button>
        <Button onClick={() => (window.location.href = '/')} variant="outline">
          Go home
        </Button>
      </div>
    </div>
  );
}
