'use client';

import { useCallback, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const OWNER_CODE = 'EDITOR_LIMIT_REACHED';
const MEMBER_CODE = 'EDITOR_LIMIT_REACHED_ASK_OWNER';

/**
 * The upgrade screen for the editor limit. `handle` takes a parsed error body and
 * returns true when it was the editor limit, so callers fall back to their usual
 * error display for anything else. Only the account owner gets the upgrade button;
 * anyone else is told who can make the change.
 */
export function useEditorLimitDialog(): {
  handle: (payload: { error?: string; code?: string } | null | undefined) => boolean;
  dialog: ReactNode;
} {
  const [state, setState] = useState<{ message: string; canUpgrade: boolean } | null>(null);

  const handle = useCallback((payload: { error?: string; code?: string } | null | undefined) => {
    if (payload?.code !== OWNER_CODE && payload?.code !== MEMBER_CODE) return false;
    setState({
      message: payload.error ?? 'This plan has no room for another editor.',
      canUpgrade: payload.code === OWNER_CODE,
    });
    return true;
  }, []);

  const dialog = (
    <Dialog open={state !== null} onOpenChange={(open) => !open && setState(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {state?.canUpgrade ? 'Add your team with Studio' : 'No room for another editor'}
          </DialogTitle>
          <DialogDescription>{state?.message}</DialogDescription>
        </DialogHeader>
        {state?.canUpgrade ? (
          <p className="text-sm text-muted-foreground">
            Studio is $29/mo for unlimited editors and 1 TB of storage. Reviewers stay free on every
            plan.
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setState(null)}>
            Close
          </Button>
          {state?.canUpgrade ? (
            <Button asChild>
              <Link href="/settings">Upgrade to Studio</Link>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { handle, dialog };
}
