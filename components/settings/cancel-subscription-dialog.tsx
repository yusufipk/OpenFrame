'use client';

import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import {
  CANCELLATION_NOTE_MAX_LENGTH,
  CANCELLATION_REASONS,
  type CancellationReason,
} from '@/lib/cancellation-reasons';

interface CancelSubscriptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When access ends if the cancellation goes through, or null when unknown. */
  periodEnd: string | null;
  /** True for a subscription that is still inside its Stripe trial. */
  isTrial: boolean;
  /** Unpaid subscriptions end now; cancellation does not extend access. */
  canceledImmediately?: boolean;
  /** Resolves true once the cancellation went through; false keeps the dialog and its answer. */
  onConfirm: (input: {
    reason: CancellationReason | null;
    note: string | null;
  }) => Promise<boolean>;
}

/**
 * One question, five answers, no default, all of it skippable.
 *
 * The answer is the whole reason this dialog exists instead of a plain confirm,
 * and the way to get honest answers is to make them cheap: one click, no
 * required field, and a cancel button that works with nothing selected. A
 * free-text box appears only under the two answers where the detail is worth
 * more than the category.
 */
export function CancelSubscriptionDialog({
  open,
  onOpenChange,
  periodEnd,
  isTrial,
  canceledImmediately = false,
  onConfirm,
}: CancelSubscriptionDialogProps) {
  const [reason, setReason] = useState<CancellationReason | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const selected = CANCELLATION_REASONS.find((entry) => entry.value === reason) ?? null;
  const showNote = selected?.askForDetail ?? false;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (submitting) return;
      if (!next) {
        setReason(null);
        setNote('');
      }
      onOpenChange(next);
    },
    [onOpenChange, submitting]
  );

  const handleConfirm = useCallback(async () => {
    setSubmitting(true);
    try {
      const trimmed = note.trim();
      const done = await onConfirm({
        reason,
        note: showNote && trimmed.length > 0 ? trimmed : null,
      });
      // A failed request keeps the answer on screen. Wiping a typed note
      // because Stripe timed out is the fastest way to never get it back.
      if (done) {
        setReason(null);
        setNote('');
      }
    } finally {
      setSubmitting(false);
    }
  }, [note, onConfirm, reason, showNote]);

  const endsOn = periodEnd ? new Date(periodEnd).toLocaleDateString() : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel your {isTrial ? 'trial' : 'subscription'}?</DialogTitle>
          <DialogDescription>
            {canceledImmediately
              ? 'This subscription ends immediately. Canceling does not extend access to your workspaces. Automatic collection stops for its open invoices. Eligible current-period subscription invoices are canceled; charges for prior service and other items may still be owed.'
              : endsOn
                ? `Everything stays on until ${endsOn}. Nothing is deleted before then, and you will not be charged again.`
                : 'Everything stays on until the end of the current period. Nothing is deleted before then, and you will not be charged again.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm font-medium">
            What is the main reason?{' '}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </p>
          <RadioGroup
            value={reason ?? ''}
            onValueChange={(value) => setReason(value as CancellationReason)}
            disabled={submitting}
          >
            {CANCELLATION_REASONS.map((entry) => (
              <Label
                key={entry.value}
                htmlFor={`cancel-reason-${entry.value}`}
                className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm font-normal transition-colors hover:bg-accent/50 has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-primary/5"
              >
                <RadioGroupItem value={entry.value} id={`cancel-reason-${entry.value}`} />
                {entry.label}
              </Label>
            ))}
          </RadioGroup>

          {showNote ? (
            <div className="space-y-1.5">
              <Label htmlFor="cancel-reason-note" className="text-sm">
                {reason === 'MISSING_FEATURE' ? 'What was missing?' : 'Tell us more'}{' '}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="cancel-reason-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={CANCELLATION_NOTE_MAX_LENGTH}
                rows={3}
                disabled={submitting}
                className="text-sm md:text-sm"
              />
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            Keep {isTrial ? 'trial' : 'subscription'}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Cancelling...
              </>
            ) : (
              `Cancel ${isTrial ? 'trial' : 'subscription'}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
