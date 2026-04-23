'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function RefreshR2StatsButton() {
  const router = useRouter();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/stats/refresh-r2', {
        method: 'POST',
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = (payload as { error?: string }).error || 'Failed to refresh R2 stats';
        setError(message);
        return;
      }

      router.refresh();
    } catch {
      setError('Failed to refresh R2 stats');
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleRefresh}
        disabled={isRefreshing}
      >
        {isRefreshing ? (
          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="mr-1.5 h-4 w-4" />
        )}
        {isRefreshing ? 'Refreshing...' : 'Refresh R2 Stats'}
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
