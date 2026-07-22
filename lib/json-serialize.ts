/**
 * JSON.stringify replacer that renders Prisma BigInt columns (sizeBytes) as
 * strings. Without it, JSON.stringify throws on any payload carrying one.
 */
export function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Converts values for JSON responses (e.g. Prisma BigInt fields).
 *
 * API routes do not need this — successResponse() serializes BigInt already.
 * Use it for payloads that bypass that helper, such as data handed from a
 * server component to a client component.
 */
export function toJsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, bigIntReplacer)) as T;
}
