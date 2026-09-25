type Entry = { nextAt: number; checkedAt: number; running: boolean };

/** Bounds background checks without keeping permission results between commands. */
export class PermissionScheduler<T> {
  private readonly entries = new Map<T, Entry>();
  private running = 0;

  constructor(
    private readonly refresh: (key: T) => Promise<void>,
    private readonly failed: (key: T) => void,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = 15_000,
    private readonly timeoutMs = 3_000,
    private readonly concurrency = 4
  ) {}

  add(key: T, phase: number): void {
    const now = this.now();
    this.entries.set(key, {
      checkedAt: now,
      nextAt: now + Math.max(0, Math.min(this.intervalMs, phase)),
      running: false,
    });
  }

  remove(key: T): void {
    this.entries.delete(key);
  }

  checked(key: T): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.checkedAt = this.now();
    entry.nextAt = entry.checkedAt + this.intervalMs;
  }

  clear(): void {
    this.entries.clear();
  }

  tick(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      // A saturated background queue must not leave revoked viewers connected indefinitely.
      if (now - entry.checkedAt > this.intervalMs + this.timeoutMs) {
        this.entries.delete(key);
        this.failed(key);
      }
    }
    const due = [...this.entries].filter(([, entry]) => !entry.running && entry.nextAt <= now);
    due.sort((a, b) => a[1].nextAt - b[1].nextAt);
    for (const [key, entry] of due) {
      if (this.running >= this.concurrency) break;
      entry.running = true;
      entry.nextAt = now + this.intervalMs;
      this.running++;
      void Promise.resolve()
        .then(() => {
          if (this.entries.get(key) === entry) return this.refresh(key);
        })
        .then(() => {
          if (this.entries.get(key) === entry) entry.checkedAt = Math.max(entry.checkedAt, now);
        })
        .catch(() => {
          if (this.entries.get(key) !== entry) return;
          this.entries.delete(key);
          this.failed(key);
        })
        .finally(() => {
          entry.running = false;
          this.running--;
          this.tick();
        });
    }
  }
}

export function permissionCheckPhase(participantId: string): number {
  let hash = 0;
  for (const char of participantId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return hash % 15_000;
}
