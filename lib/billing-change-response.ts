import {
  apiErrors,
  errorResponse,
  ErrorCode,
  HttpStatus,
  successResponse,
  withCacheControl,
} from '@/lib/api-response';
import type { BillingChangeResult, ChargeConfirmation } from '@/lib/billing-changes';

/**
 * Reads the `confirmCharge` a client echoes back from CHARGE_CONFIRMATION_REQUIRED.
 * Anything malformed reads as no confirmation, which only previews again.
 */
export function readChargeConfirmation(value: unknown): ChargeConfirmation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { amountDueCents, prorationDate } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(amountDueCents) || !Number.isSafeInteger(prorationDate)) {
    return undefined;
  }
  return { amountDueCents: amountDueCents as number, prorationDate: prorationDate as number };
}

/** Turns a billing change result into the response the settings page acts on. */
export function billingChangeResponse(result: BillingChangeResult) {
  if (result.ok) {
    return withCacheControl(
      successResponse({
        effective: result.effective,
        effectiveAt: result.effectiveAt?.toISOString() ?? null,
      }),
      'private, no-store'
    );
  }

  const { error } = result;
  switch (error.code) {
    case 'NO_SUBSCRIPTION':
    case 'PRICE_UNAVAILABLE':
    case 'INVALID':
      return apiErrors.badRequest(error.message);
    case 'CHANGE_PENDING':
      return errorResponse(error.message, HttpStatus.CONFLICT, ErrorCode.BILLING_CHANGE_PENDING);
    case 'BLOCK_LIMIT':
      return errorResponse(
        error.message,
        HttpStatus.FORBIDDEN,
        error.offer === 'studio'
          ? ErrorCode.STORAGE_BLOCK_LIMIT_UPGRADE
          : ErrorCode.STORAGE_BLOCK_LIMIT_CONTACT
      );
    case 'BELOW_USAGE':
      return errorResponse(error.message, HttpStatus.CONFLICT, ErrorCode.STORAGE_BELOW_USAGE, {
        usedBytes: [error.usedBytes.toString()],
        newLimitBytes: [error.newLimitBytes.toString()],
      });
    case 'DEMOTION_CONFIRMATION_REQUIRED':
      return errorResponse(
        error.message,
        HttpStatus.CONFLICT,
        ErrorCode.DEMOTION_CONFIRMATION_REQUIRED,
        {
          editorIds: error.editors.map((editor) => editor.id),
          editorLabels: error.editors.map(
            (editor) => editor.name?.trim() || editor.email || 'Unnamed user'
          ),
        }
      );
    case 'FOUNDING_ACKNOWLEDGEMENT_REQUIRED':
      return errorResponse(
        error.message,
        HttpStatus.CONFLICT,
        ErrorCode.FOUNDING_ACKNOWLEDGEMENT_REQUIRED
      );
    case 'CHARGE_CONFIRMATION_REQUIRED':
      return errorResponse(
        error.message,
        HttpStatus.CONFLICT,
        ErrorCode.CHARGE_CONFIRMATION_REQUIRED,
        {
          amountDueCents: [String(error.amountDueCents)],
          currency: [error.currency],
          prorationDate: [String(error.prorationDate)],
          renewsAt: error.renewsAt ? [error.renewsAt.toISOString()] : [],
        }
      );
    case 'PAYMENT_ACTION_REQUIRED':
      return errorResponse(
        error.message,
        HttpStatus.BAD_REQUEST,
        ErrorCode.PAYMENT_ACTION_REQUIRED,
        error.invoiceUrl ? { invoiceUrl: [error.invoiceUrl] } : undefined
      );
    case 'PAYMENT_FAILED':
      return errorResponse(error.message, HttpStatus.BAD_REQUEST, ErrorCode.PAYMENT_FAILED);
  }
}
