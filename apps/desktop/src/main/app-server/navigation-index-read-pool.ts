import type { NavigationQueryIndex } from "./navigation-query-projection";

type Pending = { controller: AbortController; readers: number; promise: Promise<NavigationQueryIndex> };

/** Shared physical reads with optional short, version-keyed, byte-bounded reuse. */
export class NavigationIndexReadPool {
  private readonly joinable = new Map<string, Pending>();
  private readonly physical = new Set<Pending>();
  private readers = 0;
  private readonly retained = new Map<string, { index: NavigationQueryIndex; bytes: number; expires: number; timer: ReturnType<typeof setTimeout>; owner: Pending }>();
  private retainedBytes = 0;

  constructor(private readonly retentionMs = 0) {}

  private evict(key: string): void {
    const entry = this.retained.get(key);
    if (!entry) return;
    this.retained.delete(key);
    this.retainedBytes -= entry.bytes;
    clearTimeout(entry.timer);
    entry.owner.controller.abort();
  }

  private retain(key: string, index: NavigationQueryIndex, owner: Pending): void {
    if (!this.retentionMs || this.joinable.get(key) !== owner || owner.controller.signal.aborted) return;
    const bytes = Buffer.byteLength(JSON.stringify({ ...index, inputRequestThreadKeys: [...(index.inputRequestThreadKeys ?? [])] }));
    if (bytes > 8 * 1024 * 1024) return;
    this.evict(key);
    while (this.retained.size >= 8 || this.retainedBytes + bytes > 8 * 1024 * 1024) this.evict(this.retained.keys().next().value!);
    const timer = setTimeout(() => this.evict(key), this.retentionMs);
    timer.unref?.();
    this.retained.set(key, { index, bytes, expires: Date.now() + this.retentionMs, timer, owner });
    this.retainedBytes += bytes;
  }

  retainedUsage(): { entries: number; bytes: number } { return { entries: this.retained.size, bytes: this.retainedBytes }; }

  invalidate(key: string): void { this.joinable.delete(key); this.evict(key); }

  read(key: string, load: (signal: AbortSignal) => Promise<NavigationQueryIndex>, signal?: AbortSignal): Promise<NavigationQueryIndex> {
    signal?.throwIfAborted();
    const retained = this.retained.get(key);
    if (retained && retained.expires > Date.now()) return Promise.resolve(retained.index);
    if (retained) this.evict(key);
    if (this.readers >= 256) return Promise.reject(new Error("Navigation index consumer admission is full."));
    let pending = this.joinable.get(key);
    if (!pending) {
      if (this.physical.size >= 8) return Promise.reject(new Error("Navigation index source admission is full."));
      const controller = new AbortController();
      pending = { controller, readers: 0, promise: Promise.resolve(undefined as unknown as NavigationQueryIndex) };
      const owned = pending;
      this.physical.add(owned);
      this.joinable.set(key, owned);
      owned.promise = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return load(controller.signal);
      }).then((index) => { this.retain(key, index, owned); return index; }).finally(() => {
        this.physical.delete(owned);
        if (this.joinable.get(key) === owned) this.joinable.delete(key);
      });
    }
    const owned = pending;
    owned.readers += 1;
    this.readers += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = (): boolean => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", abort);
        this.readers -= 1;
        owned.readers -= 1;
        if (!owned.readers) {
          if (this.joinable.get(key) === owned) this.joinable.delete(key);
          if (this.retained.get(key)?.owner !== owned) owned.controller.abort();
        }
        return true;
      };
      const abort = (): void => { if (release()) reject(signal?.reason ?? new Error("Navigation index read cancelled.")); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      owned.promise.then((index) => { if (release()) resolve(index); }, (error) => { if (release()) reject(error); });
    });
  }

  usage(): { physical: number; readers: number } { return { physical: this.physical.size, readers: this.readers }; }
}
