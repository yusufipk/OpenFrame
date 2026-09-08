// Shared by the cancellation dialog (client) and the cancel route (server), so
// nothing in here may pull in the database or Stripe.

import type { CancellationReason } from '@prisma/client';

export type { CancellationReason };

/** Longest note the cancellation dialog accepts. Matches the column width. */
export const CANCELLATION_NOTE_MAX_LENGTH = 500;

/**
 * The one question asked on the way out, and the order it is asked in.
 *
 * Five answers, no default. The list is short so the answer takes one click,
 * and it is ordered by how often the pattern has shown up in customer replies:
 * paying accounts that never ran a single real delivery outnumber every other
 * kind of churn, so "not using it" comes first.
 */
export const CANCELLATION_REASONS: ReadonlyArray<{
  value: CancellationReason;
  label: string;
  /** Whether the dialog opens a free-text field under this answer. */
  askForDetail: boolean;
}> = [
  { value: 'NOT_USING', label: 'I am not using it enough', askForDetail: false },
  { value: 'MISSING_FEATURE', label: 'It is missing something I need', askForDetail: true },
  {
    value: 'PRICE_OR_BILLING',
    label: 'The price or billing did not work for me',
    askForDetail: false,
  },
  { value: 'PROJECT_ENDED', label: 'The project or client work ended', askForDetail: false },
  { value: 'OTHER', label: 'Something else', askForDetail: true },
];

export function isCancellationReason(value: unknown): value is CancellationReason {
  return CANCELLATION_REASONS.some((entry) => entry.value === value);
}

export function getCancellationReasonLabel(reason: CancellationReason | null): string {
  if (!reason) return 'No reason given';
  return CANCELLATION_REASONS.find((entry) => entry.value === reason)?.label ?? reason;
}
