/**
 * Structured error logger that prevents sensitive internals from leaking to
 * log aggregators (Datadog, Sentry, etc.).
 *
 * - Prisma errors: only the error code is logged (messages can embed raw SQL
 *   fragments, WHERE-clause values, and internal column/table names).
 * - Stripe errors: message is safe and included; HTTP status code is appended.
 * - All other Error instances: only the message string is logged; stack traces
 *   are suppressed.
 * - Non-Error values (structured objects, strings, numbers): passed through
 *   unchanged, since they were already controlled by the caller.
 */

type SanitizedError = {
  type: string;
  message: string;
  code?: string;
};

function sanitizeError(err: unknown): SanitizedError | unknown {
  if (!(err instanceof Error)) {
    // Let structured objects, numbers, strings, etc. pass through as-is.
    return err;
  }

  const name = err.constructor?.name ?? err.name ?? 'Error';
  const anyErr = err as unknown as Record<string, unknown>;

  // Prisma client errors: their `.message` can embed raw SQL, WHERE-clause
  // values, and schema internals. Only safe to expose the Prisma error code.
  if (name.startsWith('PrismaClient')) {
    const code = typeof anyErr.code === 'string' ? anyErr.code : 'UNKNOWN';
    return {
      type: 'PrismaError',
      code,
      message: `Database error [${code}]`,
    } satisfies SanitizedError;
  }

  // Stripe SDK errors carry a `type` string and numeric `statusCode`; their
  // `.message` values are designed to be user-safe.
  if (typeof anyErr.type === 'string' && typeof anyErr.statusCode === 'number') {
    return {
      type: anyErr.type,
      code: String(anyErr.statusCode),
      message: err.message,
    } satisfies SanitizedError;
  }

  // All other Error instances: include message and type, never the stack.
  return { type: name, message: err.message } satisfies SanitizedError;
}

/**
 * Log an error with sanitized details.
 *
 * Use this everywhere in server-side code instead of `console.error(msg, error)`.
 */
export function logError(context: string, err: unknown): void {
  console.error(context, sanitizeError(err));
}
