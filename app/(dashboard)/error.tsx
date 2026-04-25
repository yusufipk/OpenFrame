'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Dashboard error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4 p-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <AlertTriangle className="h-12 w-12 text-destructive" />
        <h1 className="text-2xl font-bold">Dashboard Error</h1>
        <p className="text-muted-foreground max-w-md">
          Something went wrong loading the dashboard. Your projects and videos are safe.
        </p>
        {error.digest && <p className="text-muted-foreground text-xs">Error ID: {error.digest}</p>}
      </div>
      <div className="flex gap-2">
        <Button onClick={reset} variant="default">
          Try again
        </Button>
        <Button onClick={() => (window.location.href = '/dashboard')} variant="outline">
          Go to dashboard
        </Button>
      </div>
    </div>
  );
}
