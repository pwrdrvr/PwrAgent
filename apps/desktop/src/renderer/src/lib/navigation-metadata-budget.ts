/** Serialized-equivalent backing, shared by every metadata consumer in this renderer process. */
export const NAVIGATION_METADATA_MAX_RETAINED_BYTES = 8 * 1024 * 1024;
export const NAVIGATION_METADATA_MAX_TRANSIENT_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_CONSUMERS = 256;

type Pending = { key: string; bytes: number; cancelled: boolean; };

export class NavigationMetadataBudget {
  private readonly retained = new Map<string, number>();
  private readonly pending = new Set<Pending>();
  private retainedBytes = 0;
  private transientBytes = 0;

  constructor(
    private readonly maxRetainedBytes = NAVIGATION_METADATA_MAX_RETAINED_BYTES,
    private readonly maxTransientBytes = NAVIGATION_METADATA_MAX_TRANSIENT_BYTES,
  ) {}

  begin(key: string): { reserve: (bytes: number) => void; unreserve: (bytes: number) => void; commit: () => void; dispose: () => void } {
    if (this.pending.size >= MAX_METADATA_CONSUMERS
      || (!this.retained.has(key) && this.retained.size >= MAX_METADATA_CONSUMERS)) {
      throw new Error("Navigation metadata admission is full. Retry after another view closes.");
    }
    for (const previous of this.pending) if (previous.key === key) previous.cancelled = true;
    const pending: Pending = { key, bytes: 0, cancelled: false };
    this.pending.add(pending);
    const dispose = (): void => {
      if (!this.pending.delete(pending)) return;
      this.transientBytes -= pending.bytes;
    };
    return {
      reserve: (bytes) => {
        if (pending.cancelled || !this.pending.has(pending)) throw new Error("Navigation metadata read cancelled.");
        if (!Number.isSafeInteger(bytes) || bytes < 0 || this.transientBytes + bytes > this.maxTransientBytes) {
          throw new Error("Navigation metadata exceeds its transient byte budget.");
        }
        pending.bytes += bytes;
        this.transientBytes += bytes;
      },
      unreserve: (bytes) => {
        if (!this.pending.has(pending) || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > pending.bytes) {
          throw new Error("Invalid navigation metadata reservation.");
        }
        pending.bytes -= bytes;
        this.transientBytes -= bytes;
      },
      commit: () => {
        if (pending.cancelled || !this.pending.has(pending)) throw new Error("Navigation metadata read cancelled.");
        const bytes = this.retainedBytes - (this.retained.get(key) ?? 0) + pending.bytes;
        if (bytes > this.maxRetainedBytes) throw new Error("Navigation metadata exceeds its retained byte budget.");
        if (pending.bytes === 0) this.retained.delete(key);
        else this.retained.set(key, pending.bytes);
        this.retainedBytes = bytes;
        dispose();
      },
      dispose,
    };
  }

  release(key: string): void {
    this.retainedBytes -= this.retained.get(key) ?? 0;
    this.retained.delete(key);
    // A cancelled reader still owns its temporary backing until its promise settles.
    for (const pending of this.pending) if (pending.key === key) pending.cancelled = true;
  }

  usage(): { retainedBytes: number; transientBytes: number } {
    return { retainedBytes: this.retainedBytes, transientBytes: this.transientBytes };
  }
}

export const navigationGeometryBudget = new NavigationMetadataBudget();
export const navigationExactRowsBudget = new NavigationMetadataBudget();
