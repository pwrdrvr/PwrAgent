type Profiler = {
  start: () => Promise<void>;
  stop: (reason: string) => Promise<void>;
};

type Owner<TProfiler extends Profiler> = {
  key: string;
  create: () => Promise<TProfiler | null>;
  update?: (profiler: TProfiler) => void;
};

// Windows share the main V8 isolate. Serialize ownership changes, including
// settings changes and window closure, before connecting another inspector.
export class SharedHotCpuProfiler<TProfiler extends Profiler = Profiler> {
  private readonly owners = new Map<symbol, Owner<TProfiler>>();
  private active: { key: string; profiler: TProfiler } | null = null;
  private queue: Promise<void> = Promise.resolve();

  acquire(owner: symbol, request: Owner<TProfiler>): Promise<void> {
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
    if (desired && this.active?.key === desired.key) {
      desired.update?.(this.active.profiler);
      return;
    }
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
