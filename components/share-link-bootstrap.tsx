'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

interface ShareLinkBootstrapProps {
  videoId: string;
  shareToken: string;
}

export function ShareLinkBootstrap({ videoId, shareToken }: ShareLinkBootstrapProps) {
  const router = useRouter();
  const [error, setError] = useState('');

  useEffect(() => {
    let isCancelled = false;

    async function establishSession() {
      try {
        const response = await fetch(`/watch/${videoId}/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shareToken }),
        });

        if (isCancelled) return;

        if (response.ok) {
          router.replace(`/watch/${videoId}`);
          router.refresh();
          return;
        }

        const payload = (await response.json().catch(() => null)) as { requiresPassword?: boolean; error?: string } | null;
        if (payload?.requiresPassword) {
          router.replace(`/watch/${videoId}?unlock=1`);
          return;
        }

        setError(payload?.error || 'Invalid or expired share link');
      } catch {
        if (!isCancelled) {
          setError('Failed to open share link');
        }
      }
    }

    void establishSession();
    return () => {
      isCancelled = true;
    };
  }, [router, shareToken, videoId]);

  return (
    <div className="h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm text-center space-y-3">
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
        <h1 className="text-lg font-semibold">Opening shared video</h1>
        <p className="text-sm text-muted-foreground">{error || 'Verifying link access...'}</p>
      </div>
    </div>
  );
}
