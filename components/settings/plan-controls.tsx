'use client';

import { useCallback, useState } from 'react';
import { Loader2, Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export type PlanName = 'SOLO' | 'STUDIO';
export type IntervalName = 'MONTH' | 'YEAR';

/** The `plan` block of GET /api/billing. */
export interface PlanOverview {
  plan: PlanName;
  interval: IntervalName;
  isFounding: boolean;
  storageBlocks: number;
  maxStorageBlocks: number;
  storageCeilingOffer: 'studio' | 'contact';
  limitBytes: string;
  baseStorageBytes: string;
  storageBlockBytes: string;
  pending: {
    plan: PlanName;
    interval: IntervalName | null;
    storageBlocks: number;
    at: string;
    editorDemotionCount: number;
  } | null;
  editorCount: number;
  editorLimit: number | null;
  recommendedPlan: PlanName;
  showStudioUpsell: boolean;
  prices: {
    SOLO: Record<IntervalName, number>;
    STUDIO: Record<IntervalName, number>;
    storage: Record<IntervalName, number>;
  };
  available: {
    SOLO: Record<IntervalName, boolean>;
    STUDIO: Record<IntervalName, boolean>;
    storage: Record<IntervalName, boolean>;
  };
}

interface ApiOutcome {
  ok: boolean;
  error?: string;
  code?: string;
  details?: Record<string, string[]>;
  data?: { effective: 'now' | 'period_end'; effectiveAt: string | null };
}

async function callBilling(
  url: string,
  method: 'POST' | 'DELETE',
  body?: unknown
): Promise<ApiOutcome> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, ...payload };
    return { ok: true, data: payload.data };
  } catch {
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

/** Sends the customer to the invoice that holds a change until it is paid or confirmed. */
function followPendingPayment(result: ApiOutcome) {
  const url = result.details?.invoiceUrl?.[0];
  if (result.code === 'PAYMENT_ACTION_REQUIRED' && url) {
    window.location.href = url;
    return true;
  }
  return false;
}

const PLAN_LABEL: Record<PlanName, string> = { SOLO: 'Solo', STUDIO: 'Studio' };
const PLAN_HEADLINE: Record<PlanName, string> = {
  SOLO: 'You edit, your clients review',
  STUDIO: 'Your whole team uploads, one bill',
};
const PLAN_EDITORS: Record<PlanName, string> = { SOLO: '1 editor', STUDIO: 'Unlimited editors' };
const PLAN_STORAGE: Record<PlanName, string> = { SOLO: '200 GB storage', STUDIO: '1 TB storage' };

export function formatDollars(cents: number) {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function per(interval: IntervalName) {
  return interval === 'YEAR' ? 'yr' : 'mo';
}

function formatGigabytes(bytes: string | number) {
  const gb = Number(bytes) / 1024 ** 3;
  return gb >= 1024 && gb % 1024 === 0 ? `${gb / 1024} TB` : `${Math.round(gb)} GB`;
}

function IntervalToggle({
  value,
  onChange,
}: {
  value: IntervalName;
  onChange: (value: IntervalName) => void;
}) {
  return (
    <div className="inline-flex rounded-md border p-0.5 text-xs">
      {(['MONTH', 'YEAR'] as const).map((interval) => (
        <button
          key={interval}
          type="button"
          onClick={() => onChange(interval)}
          className={cn(
            'rounded px-3 py-1 font-medium transition-colors',
            value === interval
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {interval === 'MONTH' ? 'Monthly' : 'Yearly'}
        </button>
      ))}
    </div>
  );
}

/**
 * Plan choice before checkout. Shown to anyone without a subscription, including a
 * trial that is ending; an account that already has more than one editor sees
 * Studio recommended, because Solo would leave it unable to add anyone else.
 */
export function PlanPicker({
  overview,
  disabled,
  busy,
  onChoose,
}: {
  overview: PlanOverview;
  disabled: boolean;
  busy: boolean;
  /** Resolves to the error body when checkout was refused, or null once redirected. */
  onChoose: (
    plan: PlanName,
    interval: IntervalName,
    confirmDemotions?: string[]
  ) => Promise<{ code?: string; details?: Record<string, string[]> } | null>;
}) {
  const [interval, setInterval] = useState<IntervalName>('MONTH');
  const [demotion, setDemotion] = useState<{ ids: string[]; labels: string[] } | null>(null);
  const recommendStudio = overview.recommendedPlan === 'STUDIO';

  const choose = async (plan: PlanName, confirmDemotions?: string[]) => {
    const refusal = await onChoose(plan, interval, confirmDemotions);
    if (refusal?.code === 'DEMOTION_CONFIRMATION_REQUIRED') {
      setDemotion({
        ids: refusal.details?.editorIds ?? [],
        labels: refusal.details?.editorLabels ?? [],
      });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Reviewers are always free. You only pay for the people who upload.
        </p>
        <IntervalToggle value={interval} onChange={setInterval} />
      </div>
      {recommendStudio ? (
        <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          {overview.editorCount} people can upload in your workspaces. Solo includes one editor, so
          Studio keeps your team as it is.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {(['SOLO', 'STUDIO'] as const).map((plan) => {
          const available = overview.available[plan][interval];
          return (
            <div
              key={plan}
              className={cn(
                'flex flex-col gap-2 rounded-lg border p-4',
                overview.recommendedPlan === plan && recommendStudio && 'border-primary/60'
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{PLAN_LABEL[plan]}</span>
                {overview.recommendedPlan === plan && recommendStudio ? (
                  <Badge>Recommended</Badge>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">{PLAN_HEADLINE[plan]}</p>
              <p className="text-2xl font-semibold">
                {formatDollars(overview.prices[plan][interval])}
                <span className="text-sm font-normal text-muted-foreground">
                  {' '}
                  / {interval === 'YEAR' ? 'year' : 'month'}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                {PLAN_EDITORS[plan]} · {PLAN_STORAGE[plan]}
              </p>
              <Button
                className="mt-auto"
                variant={overview.recommendedPlan === plan ? 'default' : 'outline'}
                disabled={disabled || !available}
                onClick={() => void choose(plan)}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : `Choose ${PLAN_LABEL[plan]}`}
              </Button>
            </div>
          );
        })}
      </div>

      <Dialog open={demotion !== null} onOpenChange={(open) => !open && setDemotion(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Subscribe to Solo</DialogTitle>
            <DialogDescription>
              Solo includes one editor: you. Once your subscription starts, these people become
              reviewers. They keep access and can still comment, but cannot upload. Studio keeps
              everyone as they are.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-60 list-disc space-y-1 overflow-y-auto pl-5 text-sm">
            {demotion?.labels.map((label, i) => (
              <li key={demotion.ids[i] ?? i}>{label}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => {
                setDemotion(null);
                void choose('STUDIO');
              }}
            >
              Choose Studio instead
            </Button>
            <Button
              disabled={disabled}
              onClick={() => demotion && void choose('SOLO', demotion.ids)}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm and continue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Plan and interval changes for a running subscription, with the confirmations the
 * API asks for: which editors drop to reviewer on a move to Solo, and, for a
 * founding account, that moving to Studio gives up the founding terms.
 */
export function PlanChangePanel({
  overview,
  periodEnd,
  onChanged,
  onMessage,
}: {
  overview: PlanOverview;
  periodEnd: string | null;
  onChanged: () => Promise<void> | void;
  onMessage: (type: 'success' | 'error', text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [demotion, setDemotion] = useState<{
    ids: string[];
    labels: string[];
    plan: PlanName;
    interval: IntervalName;
  } | null>(null);
  const [foundingConfirm, setFoundingConfirm] = useState<IntervalName | null>(null);

  const submit = useCallback(
    async (
      plan: PlanName,
      interval: IntervalName,
      extra: {
        confirmDemotions?: string[];
        acknowledgeFoundingLoss?: boolean;
        confirmBelowUsage?: boolean;
      } = {}
    ) => {
      setBusy(true);
      let result = await callBilling('/api/billing/plan', 'POST', { plan, interval, ...extra });
      if (
        result.code === 'STORAGE_BELOW_USAGE' &&
        window.confirm(result.error ?? 'You are storing more than the new plan allows.')
      ) {
        result = await callBilling('/api/billing/plan', 'POST', {
          plan,
          interval,
          ...extra,
          confirmBelowUsage: true,
        });
      }
      setBusy(false);
      if (result.ok) {
        setDemotion(null);
        setFoundingConfirm(null);
        onMessage(
          'success',
          result.data?.effective === 'period_end' && result.data.effectiveAt
            ? `Done. The change takes effect on ${new Date(result.data.effectiveAt).toLocaleDateString()}.`
            : `You are now on ${PLAN_LABEL[plan]}, billed ${interval === 'YEAR' ? 'yearly' : 'monthly'}.`
        );
        await onChanged();
        return;
      }
      if (result.code === 'DEMOTION_CONFIRMATION_REQUIRED') {
        setDemotion({
          ids: result.details?.editorIds ?? [],
          labels: result.details?.editorLabels ?? [],
          plan,
          interval,
        });
        return;
      }
      if (result.code === 'FOUNDING_ACKNOWLEDGEMENT_REQUIRED') {
        setFoundingConfirm(interval);
        return;
      }
      if (result.code === 'STORAGE_BELOW_USAGE') return;
      if (followPendingPayment(result)) return;
      onMessage('error', result.error || 'Failed to change the plan');
      // Another tab may have just changed the plan; show what is true now.
      if (result.code === 'BILLING_CHANGE_PENDING') await onChanged();
    },
    [onChanged, onMessage]
  );

  const cancelPending = useCallback(async () => {
    setBusy(true);
    const result = await callBilling('/api/billing/plan', 'DELETE');
    setBusy(false);
    if (!result.ok) {
      onMessage('error', result.error || 'Failed to cancel the scheduled change');
      return;
    }
    onMessage('success', 'The scheduled change was cancelled.');
    await onChanged();
  }, [onChanged, onMessage]);

  const { plan, interval, pending } = overview;
  const otherPlan: PlanName = plan === 'SOLO' ? 'STUDIO' : 'SOLO';
  // Blocks move to the yearly storage price too, so that price has to exist as well.
  const canSwitchToYearly =
    interval === 'MONTH' &&
    overview.available[plan].YEAR &&
    (overview.storageBlocks === 0 || overview.available.storage.YEAR);
  const canSwitchToMonthly =
    interval === 'YEAR' &&
    overview.available[plan].MONTH &&
    (overview.storageBlocks === 0 || overview.available.storage.MONTH);
  const canMoveToStudio =
    plan === 'SOLO' && overview.showStudioUpsell && overview.available.STUDIO[interval];
  // Founding accounts are never offered Studio; they can still choose it themselves.
  const foundingCanChooseStudio =
    plan === 'SOLO' && overview.isFounding && overview.available.STUDIO[interval];
  const canMoveToSolo = plan === 'STUDIO' && overview.available.SOLO[interval];

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            {PLAN_LABEL[plan]}, billed {interval === 'YEAR' ? 'yearly' : 'monthly'}
            {overview.isFounding ? ' · Founding member' : ''}
          </p>
          <p className="text-sm text-muted-foreground">
            {overview.isFounding
              ? `Unlimited editors · ${PLAN_STORAGE[plan]}`
              : `${PLAN_EDITORS[plan]} · ${PLAN_STORAGE[plan]}`}{' '}
            · {formatDollars(overview.prices[plan][interval])}/{per(interval)}
          </p>
        </div>
      </div>

      {pending ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <p>
            On {new Date(pending.at).toLocaleDateString()} this changes to{' '}
            {PLAN_LABEL[pending.plan]}
            {pending.interval
              ? `, billed ${pending.interval === 'YEAR' ? 'yearly' : 'monthly'}`
              : ''}
            {pending.storageBlocks !== overview.storageBlocks
              ? `, with ${pending.storageBlocks} extra storage block${pending.storageBlocks === 1 ? '' : 's'}`
              : ''}
            .
            {pending.editorDemotionCount > 0
              ? ` ${pending.editorDemotionCount} editor${pending.editorDemotionCount === 1 ? '' : 's'} will become reviewer${pending.editorDemotionCount === 1 ? '' : 's'} then.`
              : ''}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={busy}
            onClick={cancelPending}
          >
            Keep my current plan
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canMoveToStudio && !pending ? (
          <Button size="sm" disabled={busy} onClick={() => submit('STUDIO', interval)}>
            Upgrade to Studio ({formatDollars(overview.prices.STUDIO[interval])}/{per(interval)})
          </Button>
        ) : null}
        {canSwitchToYearly && !pending ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => submit(plan, 'YEAR')}>
            Switch to yearly ({formatDollars(overview.prices[plan].YEAR)}/yr)
          </Button>
        ) : null}
        {canSwitchToMonthly && !pending ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => submit(plan, 'MONTH')}>
            Switch to monthly at renewal
          </Button>
        ) : null}
        {foundingCanChooseStudio && !pending ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            disabled={busy}
            onClick={() => submit('STUDIO', interval)}
          >
            Change plan
          </Button>
        ) : null}
        {canMoveToSolo && !pending ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => submit(otherPlan, interval)}
          >
            Move to Solo at renewal
          </Button>
        ) : null}
      </div>
      {canMoveToSolo || canSwitchToMonthly ? (
        <p className="text-xs text-muted-foreground">
          Moving down takes effect when the current period ends
          {periodEnd ? ` (${new Date(periodEnd).toLocaleDateString()})` : ''}. Moving up takes
          effect now and is prorated.
        </p>
      ) : null}

      <Dialog open={demotion !== null} onOpenChange={(open) => !open && setDemotion(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move to Solo</DialogTitle>
            <DialogDescription>
              Solo includes one editor: you. When the change takes effect, these people become
              reviewers. They keep access and can still comment, but cannot upload. Nothing else
              changes until then.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-60 list-disc space-y-1 overflow-y-auto pl-5 text-sm">
            {demotion?.labels.map((label, i) => (
              <li key={demotion.ids[i] ?? i}>{label}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDemotion(null)} disabled={busy}>
              Stay on Studio
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                demotion &&
                submit(demotion.plan, demotion.interval, { confirmDemotions: demotion.ids })
              }
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm and schedule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={foundingConfirm !== null}
        onOpenChange={(open) => !open && setFoundingConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave your founding terms?</DialogTitle>
            <DialogDescription>
              Your account keeps founding terms only on its current plan: unlimited editors at{' '}
              {formatDollars(overview.prices.SOLO.MONTH)}/mo. If you move to Studio and come back
              later, the founding terms are gone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFoundingConfirm(null)} disabled={busy}>
              Keep founding terms
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                foundingConfirm &&
                submit('STUDIO', foundingConfirm, { acknowledgeFoundingLoss: true })
              }
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Move to Studio'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The "Extra storage" row: 100 GB blocks with + and -, the resulting quota and price.
 * More applies now; fewer at the period end, with a warning when the new quota would
 * be below what is already stored.
 */
export function ExtraStorageRow({
  overview,
  usedBytes,
  onChanged,
  onMessage,
}: {
  overview: PlanOverview;
  usedBytes: string | null;
  onChanged: () => Promise<void> | void;
  onMessage: (type: 'success' | 'error', text: string) => void;
}) {
  const current = overview.pending?.storageBlocks ?? overview.storageBlocks;
  const [blocks, setBlocks] = useState(current);
  const [busy, setBusy] = useState(false);
  const [belowUsage, setBelowUsage] = useState(false);

  const blockBytes = Number(overview.storageBlockBytes);
  const baseBytes = Number(overview.baseStorageBytes);
  const newLimit = baseBytes + blocks * blockBytes;
  const blockPrice = overview.prices.storage[overview.interval];
  const atCeiling = blocks >= overview.maxStorageBlocks;
  // Adding storage now is refused while any change waits for the period end.
  const addBlockedByPending = overview.pending !== null && blocks >= overview.storageBlocks;
  const available = overview.available.storage[overview.interval];
  const wouldBeBelowUsage = usedBytes !== null && Number(usedBytes) >= newLimit;

  const apply = useCallback(
    async (confirmBelowUsage = false) => {
      setBusy(true);
      const result = await callBilling('/api/billing/storage', 'POST', {
        blocks,
        confirmBelowUsage,
      });
      setBusy(false);
      if (result.ok) {
        setBelowUsage(false);
        onMessage(
          'success',
          result.data?.effective === 'period_end' && result.data.effectiveAt
            ? `Storage changes on ${new Date(result.data.effectiveAt).toLocaleDateString()}. You keep your current quota until then.`
            : `Your quota is now ${formatGigabytes(newLimit)}.`
        );
        await onChanged();
        return;
      }
      if (result.code === 'STORAGE_BELOW_USAGE') {
        setBelowUsage(true);
        return;
      }
      if (followPendingPayment(result)) return;
      onMessage('error', result.error || 'Failed to change storage');
      // Another tab may have just changed the storage; show what is true now.
      if (result.code === 'BILLING_CHANGE_PENDING') await onChanged();
    },
    [blocks, newLimit, onChanged, onMessage]
  );

  return (
    <div className="space-y-2 rounded-lg border p-4" id="extra-storage">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Extra storage</p>
          <p className="text-xs text-muted-foreground">
            100 GB for {formatDollars(blockPrice)}/{per(overview.interval)} each. Adding takes
            effect now; removing at the end of the period.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="icon"
            variant="outline"
            aria-label="Remove 100 GB"
            disabled={busy || blocks <= 0}
            onClick={() => {
              setBlocks((value) => Math.max(0, value - 1));
              setBelowUsage(false);
            }}
          >
            <Minus className="h-4 w-4" />
          </Button>
          <span className="w-8 text-center text-sm font-medium tabular-nums">{blocks}</span>
          <Button
            size="icon"
            variant="outline"
            aria-label="Add 100 GB"
            disabled={busy || atCeiling || !available || addBlockedByPending}
            onClick={() => {
              setBlocks((value) => value + 1);
              setBelowUsage(false);
            }}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Total quota: {formatGigabytes(newLimit)} · Extra storage:{' '}
        {formatDollars(blocks * blockPrice)}/{per(overview.interval)}
      </p>
      {atCeiling ? (
        overview.storageCeilingOffer === 'studio' ? (
          <p className="text-xs text-muted-foreground">
            Solo includes up to {overview.maxStorageBlocks} extra blocks. Studio gives you 1 TB for{' '}
            {formatDollars(overview.prices.STUDIO.MONTH)}/mo.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Need more?{' '}
            <a className="underline" href="mailto:info@open-frame.net">
              Let&apos;s talk
            </a>
            .
          </p>
        )
      ) : null}
      {addBlockedByPending && !atCeiling ? (
        <p className="text-xs text-muted-foreground">
          To go above {overview.storageBlocks} blocks now, cancel the change scheduled for renewal
          first.
        </p>
      ) : null}
      {wouldBeBelowUsage && blocks < overview.storageBlocks ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          You are using more than {formatGigabytes(newLimit)}. Nothing will be deleted, but new
          uploads will stop until you are under the new quota.
        </p>
      ) : null}
      {blocks !== current ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => apply(belowUsage)}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : belowUsage ? (
              'Reduce anyway'
            ) : blocks > overview.storageBlocks ? (
              // Measured from what is running, not from a pending reduction.
              `Add ${blocks - overview.storageBlocks} × 100 GB now`
            ) : blocks === overview.storageBlocks ? (
              'Keep my current storage'
            ) : (
              'Reduce at renewal'
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBlocks(current);
              setBelowUsage(false);
            }}
          >
            Reset
          </Button>
        </div>
      ) : null}
    </div>
  );
}
