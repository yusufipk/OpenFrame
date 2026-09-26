import { describe, expect, it, vi } from 'vitest';
import { PermissionScheduler, permissionCheckPhase } from '@/lib/live-review/permission-scheduler';

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('live permission scheduler', () => {
  it('spreads checks, bounds concurrency and drains overdue work as capacity frees', async () => {
    let now = 0;
    const releases: Array<() => void> = [];
    const refresh = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const scheduler = new PermissionScheduler(refresh, vi.fn(), () => now, 15_000, 3_000, 2);
    scheduler.add('a', 1000);
    scheduler.add('b', 2000);
    scheduler.add('c', 2000);
    scheduler.tick();
    await settle();
    expect(refresh).not.toHaveBeenCalled();
    now = 1000;
    scheduler.tick();
    await settle();
    expect(refresh.mock.calls).toEqual([['a']]);
    now = 2000;
    scheduler.tick();
    await settle();
    expect(refresh.mock.calls).toEqual([['a'], ['b']]);
    scheduler.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
    releases[0]();
    await settle();
    expect(refresh.mock.calls).toEqual([['a'], ['b'], ['c']]);
    releases[1]();
    releases[2]();
    await settle();
  });

  it('uses a fresh command check to defer background work, without duplicate in-flight checks', async () => {
    let now = 0;
    let release!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const scheduler = new PermissionScheduler(refresh, vi.fn(), () => now);
    scheduler.add('a', 1000);
    now = 900;
    scheduler.checked('a');
    now = 1000;
    scheduler.tick();
    await settle();
    expect(refresh).not.toHaveBeenCalled();
    now = 15_900;
    scheduler.tick();
    scheduler.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    scheduler.remove('a');
    release();
    await settle();
    now = 40_000;
    scheduler.tick();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('fails closed for a stalled check and never retries a removed entry', async () => {
    let now = 0;
    let reject!: (reason: Error) => void;
    const refresh = vi.fn(() => new Promise<void>((_, fail) => (reject = fail)));
    const failed = vi.fn();
    const scheduler = new PermissionScheduler(refresh, failed, () => now);
    scheduler.add('a', 0);
    scheduler.tick();
    await settle();
    now = 18_001;
    scheduler.tick();
    expect(failed.mock.calls).toEqual([['a']]);
    reject(new Error('late failure'));
    await settle();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('propagates refresh failure once and clears queued work on shutdown', async () => {
    const failed = vi.fn();
    const refresh = vi.fn(async () => {
      throw new Error('unavailable');
    });
    const scheduler = new PermissionScheduler(refresh, failed, () => 0);
    scheduler.add('a', 0);
    scheduler.tick();
    await settle();
    expect(failed.mock.calls).toEqual([['a']]);
    scheduler.add('b', 0);
    scheduler.clear();
    scheduler.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(permissionCheckPhase('alice')).toBe(8040);
    expect(permissionCheckPhase('bob')).toBe(7717);
  });
});
