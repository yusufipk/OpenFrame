// contentTransaction runs Serializable, and Postgres can abort one of two
// transactions that never touched the same rows. Those aborts are retried; real
// refusals and lock timeouts are not. The callback throws the errors Prisma and
// the pg driver adapter actually raise, so the classification is what is tested.

import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ContentError, contentTransaction } from '@/lib/content-mutations';
import { seedProject } from '../factories';

function knownError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('conflict', {
    code,
    clientVersion: 'test',
    meta,
  });
}

/**
 * What @prisma/adapter-pg throws from a model call or from COMMIT: an Error
 * whose `cause` carries the mapped kind and the original SQLSTATE.
 */
function adapterError(originalCode: string) {
  const kind = originalCode === '40001' ? 'TransactionWriteConflict' : 'postgres';
  return Object.assign(new Error(kind === 'postgres' ? 'driver error' : kind), {
    name: 'DriverAdapterError',
    cause: { kind, originalCode },
  });
}

/** Throws each of `failures` on successive attempts, then answers 'done'. */
function failingThen(failures: unknown[]) {
  const calls = { count: 0 };
  const run = async () => {
    const failure = failures[calls.count];
    calls.count += 1;
    if (failure) throw failure;
    return 'done';
  };
  return { calls, run };
}

describe('contentTransaction retries', () => {
  it('runs again after a serialization abort and returns the second result', async () => {
    const { project } = await seedProject();
    const { calls, run } = failingThen([knownError('P2034')]);

    await expect(contentTransaction([project.id], run)).resolves.toBe('done');
    expect(calls.count).toBe(2);
  });

  it('treats adapter conflicts, adapter deadlocks and raw 40001 as the same abort', async () => {
    const { project } = await seedProject();
    const { calls, run } = failingThen([adapterError('40001'), adapterError('40P01')]);
    const raw = failingThen([
      knownError('P2010', { driverAdapterError: { cause: { originalCode: '40001' } } }),
      knownError('P2010', { driverAdapterError: { cause: { originalCode: '40P01' } } }),
    ]);

    await expect(contentTransaction([project.id], run)).resolves.toBe('done');
    await expect(contentTransaction([project.id], raw.run)).resolves.toBe('done');
    expect(calls.count).toBe(3);
    expect(raw.calls.count).toBe(3);
  });

  it('gives up with a 409 after three aborts in a row', async () => {
    const { project } = await seedProject();
    const { calls, run } = failingThen([
      knownError('P2034'),
      knownError('P2034'),
      knownError('P2034'),
      knownError('P2034'),
    ]);

    const error = await contentTransaction([project.id], run).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContentError);
    expect((error as ContentError).status).toBe(409);
    expect(calls.count).toBe(3);
  });

  it('does not repeat a lock timeout or a refusal from the callback', async () => {
    const { project } = await seedProject();
    const lockTimeout = failingThen([adapterError('55P03')]);
    const refusal = failingThen([new ContentError(403, 'No')]);

    const timedOut = await contentTransaction([project.id], lockTimeout.run).catch((e) => e);
    const refused = await contentTransaction([project.id], refusal.run).catch((e) => e);

    expect(timedOut).toBeInstanceOf(ContentError);
    expect((timedOut as ContentError).status).toBe(409);
    expect(lockTimeout.calls.count).toBe(1);
    expect((refused as ContentError).status).toBe(403);
    expect(refusal.calls.count).toBe(1);
  });

  it('does not repeat an attempt that ran for a while before it aborted', async () => {
    const { project } = await seedProject();
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const calls = { count: 0 };
    const slowThenAbort = async () => {
      calls.count += 1;
      now += 6000; // Past the quick-abort window, as a long bulk delete would be.
      throw knownError('P2034');
    };

    try {
      const error = await contentTransaction([project.id], slowThenAbort, 120000).catch(
        (e: unknown) => e
      );
      expect((error as ContentError).status).toBe(409);
      expect(calls.count).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
});
