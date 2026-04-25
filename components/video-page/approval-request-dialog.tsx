'use client';

import { useMemo, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type { ApprovalRequest } from '@/components/video-page/types';
import type { ApprovalCandidate } from '@/components/video-page/hooks/use-approvals';

interface ApprovalRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: ApprovalCandidate[];
  currentUserId: string | null;
  activePendingRequest: ApprovalRequest | null;
  isLoadingCandidates: boolean;
  isSubmittingRequest: boolean;
  error: string;
  onRefreshCandidates: () => void;
  onCreateRequest: (approverIds: string[], message?: string) => Promise<boolean>;
}

export function ApprovalRequestDialog({
  open,
  onOpenChange,
  candidates,
  currentUserId,
  activePendingRequest,
  isLoadingCandidates,
  isSubmittingRequest,
  error,
  onRefreshCandidates,
  onCreateRequest,
}: ApprovalRequestDialogProps) {
  const [selectedApproverIds, setSelectedApproverIds] = useState<string[]>([]);
  const [message, setMessage] = useState('');

  const selectableCandidates = useMemo(
    () => candidates.filter((candidate) => candidate.id !== currentUserId),
    [candidates, currentUserId]
  );

  const toggleApprover = (userId: string) => {
    setSelectedApproverIds((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]
    );
  };

  const handleCreate = async () => {
    const success = await onCreateRequest(selectedApproverIds, message.trim() || undefined);
    if (success) {
      setSelectedApproverIds([]);
      setMessage('');
      onOpenChange(false);
    }
  };

  const isBlockedByPendingRequest = !!activePendingRequest;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Request Approval</DialogTitle>
          <DialogDescription>Select one or more approvers for this version.</DialogDescription>
        </DialogHeader>

        {isBlockedByPendingRequest ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            A pending approval request already exists for this version.
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Approvers ({selectedApproverIds.length} selected)
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={onRefreshCandidates}
              disabled={isLoadingCandidates}
            >
              {isLoadingCandidates ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh'}
            </Button>
          </div>
          <div className="max-h-56 overflow-y-auto rounded-md border p-2 space-y-1">
            {selectableCandidates.length === 0 ? (
              <p className="text-sm text-muted-foreground px-2 py-3">
                No eligible approvers found.
              </p>
            ) : (
              selectableCandidates.map((candidate) => {
                const selected = selectedApproverIds.includes(candidate.id);
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    className="w-full rounded-md border p-2 text-left hover:bg-accent/50 transition-colors"
                    onClick={() => toggleApprover(candidate.id)}
                    disabled={isBlockedByPendingRequest}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <Avatar className="h-7 w-7">
                          <AvatarImage src={candidate.image ?? undefined} />
                          <AvatarFallback>
                            {(candidate.name || candidate.email || 'U').charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {candidate.name || 'Unnamed'}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {candidate.email || 'No email'}
                          </p>
                        </div>
                      </div>
                      {selected ? (
                        <Badge variant="default" className="gap-1">
                          <Check className="h-3 w-3" />
                          Selected
                        </Badge>
                      ) : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Message (optional)</p>
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Include context for the approvers..."
            rows={3}
            maxLength={2000}
            disabled={isBlockedByPendingRequest}
          />
        </div>

        <DialogFooter>
          <Button
            onClick={handleCreate}
            disabled={
              isSubmittingRequest || isBlockedByPendingRequest || selectedApproverIds.length === 0
            }
          >
            {isSubmittingRequest ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Create Request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
