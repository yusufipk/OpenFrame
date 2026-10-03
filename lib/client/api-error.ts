// What a failed API call is worth showing the person who made it.
//
// Every route answers with `{ error, code? }`, and the code is the part that
// says whether there is anything the caller can do. Losing it on the way to a
// toast is how a full trial account ends up reading "Failed to upload" and
// trying the same upload again.

import { toast } from 'sonner';

/** The machine-readable half of an error response. Mirrors ErrorCode in lib/api-response.ts. */
export const API_ERROR_CODES = {
  /** Out of room because the account has not subscribed, not because the plan is full. */
  TRIAL_STORAGE_LIMIT_EXCEEDED: 'TRIAL_STORAGE_LIMIT_EXCEEDED',
  /** A paying account is full; the add-on lives in the storage card in settings. */
  STORAGE_LIMIT_EXCEEDED: 'STORAGE_LIMIT_EXCEEDED',
  /** Someone else's account is full; the uploader's own settings cannot help. */
  STORAGE_LIMIT_EXCEEDED_ASK_OWNER: 'STORAGE_LIMIT_EXCEEDED_ASK_OWNER',
} as const;

export interface ApiErrorPayload {
  error?: string;
  code?: string;
}

/**
 * A failure that came back from our own API, with the code still attached.
 *
 * The upload helpers throw rather than return, so without this the code is gone
 * by the time anything is in a position to show it.
 */
export class ApiRequestError extends Error {
  readonly code: string | null;

  constructor(message: string, code?: string | null) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code ?? null;
  }
}

/** Builds the error to throw from a parsed `{ error, code }` body. */
export function apiRequestError(
  payload: ApiErrorPayload | null,
  fallback: string
): ApiRequestError {
  return new ApiRequestError(payload?.error || fallback, payload?.code);
}

/**
 * Whether this failure is the trial ceiling, for callers that draw the way out
 * themselves rather than handing it to `toastApiError`.
 */
export function isTrialStorageError(source: unknown): boolean {
  return codeOf(source) === API_ERROR_CODES.TRIAL_STORAGE_LIMIT_EXCEEDED;
}

/**
 * Whether this failure is a paying account that is full, where the storage settings
 * hold the way out. Not true for an uploader on someone else's account.
 */
export function isPaidStorageError(source: unknown): boolean {
  return codeOf(source) === API_ERROR_CODES.STORAGE_LIMIT_EXCEEDED;
}

function codeOf(source: unknown): string | null {
  if (source instanceof ApiRequestError) return source.code;
  if (source && typeof source === 'object' && 'code' in source) {
    const code = (source as ApiErrorPayload).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function messageOf(source: unknown, fallback: string): string {
  if (source instanceof Error) return source.message || fallback;
  if (source && typeof source === 'object' && 'error' in source) {
    const message = (source as ApiErrorPayload).error;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

export interface ToastApiErrorOptions {
  /** Prepended as `${prefix}: ${message}`, for per-file failures in a batch. */
  prefix?: string;
}

/**
 * Shows an API failure, with a way out attached when there is one.
 *
 * Takes either a parsed response body or a thrown error, so the same call works
 * whether the caller checked `res.ok` itself or caught what an upload helper
 * threw. On the trial storage ceiling it adds a link to the billing settings,
 * because subscribing is the only thing that makes the upload possible and the
 * uploader has no way to know that from "storage limit exceeded".
 */
export function toastApiError(
  source: unknown,
  fallback: string,
  options: ToastApiErrorOptions = {}
): void {
  const message = messageOf(source, fallback);
  const text = options.prefix ? `${options.prefix}: ${message}` : message;

  if (isTrialStorageError(source)) {
    toast.error(text, {
      // Longer than a plain error: this one is asking for a decision rather than
      // just reporting, and it disappears under the cursor at the usual timing.
      duration: 12000,
      action: {
        // The message ends in "Upgrade to get 200 GB", so the button is the verb
        // that sentence just used rather than a second name for the same thing.
        label: 'Upgrade',
        onClick: () => {
          window.location.href = '/settings';
        },
      },
    });
    return;
  }

  // The message names the remedy (add 100 GB, move up a plan, or neither when the
  // subscription is ending), and the button goes straight to the storage controls
  // instead of the top of the settings page.
  if (codeOf(source) === API_ERROR_CODES.STORAGE_LIMIT_EXCEEDED) {
    toast.error(text, {
      duration: 12000,
      action: {
        label: 'Storage settings',
        onClick: () => {
          window.location.href = '/settings#storage';
        },
      },
    });
    return;
  }

  toast.error(text);
}
