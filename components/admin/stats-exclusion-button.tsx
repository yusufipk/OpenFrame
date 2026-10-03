'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/** One click to leave a test or internal account out of the admin counts, or put it back. */
export function StatsExclusionButton({ userId, excluded }: { userId: string; excluded: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ excludedFromStats: !excluded }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || 'Could not update the account');
      }
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the account');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 w-fit px-1.5 text-xs text-muted-foreground"
      disabled={busy}
      onClick={toggle}
    >
      {excluded ? 'Count in stats' : 'Exclude from stats'}
    </Button>
  );
}
