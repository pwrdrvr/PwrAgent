type Profiler = {
  start: () => Promise<void>;
  stop: (reason: string) => Promise<void>;
};

type Owner = {
  key: string;
  create: () => Promise<Profiler | null>;
};

// Windows share the main V8 isolate. Serialize ownership changes, including
// settings changes and window closure, before connecting another inspector.
export class SharedHotCpuProfiler {
  private readonly owners = new Map<symbol, Owner>();
  private active: { key: string; profiler: Profiler } | null = null;
  private queue: Promise<void> = Promise.resolve();

  acquire(owner: symbol, request: Owner): Promise<void> {
    return this.enqueue(async () => {
      this.owners.set(owner, request);
      await this.reconcile("settings-changed");
    });
  }

  release(owner: symbol, reason: string): Promise<void> {
    return this.enqueue(async () => {
      this.owners.delete(owner);
      await this.reconcile(reason);
    });
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.queue.then(action, action);
    this.queue = result.catch(() => {});
    return result;
  }

  private async reconcile(reason: string): Promise<void> {
    const desired = [...this.owners.values()].at(-1);
    if (desired && desired.key === this.active?.key) return;
    if (this.active) {
      const previous = this.active;
      this.active = null;
      await previous.profiler.stop(reason);
    }
    if (!desired) return;
    const profiler = await desired.create();
    if (!profiler) return;
    try {
      await profiler.start();
      this.active = { key: desired.key, profiler };
    } catch (error) {
      await profiler.stop("start-failed");
      throw error;
    }
  }
}
