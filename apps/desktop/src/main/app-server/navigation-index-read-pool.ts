import type { NavigationQueryIndex } from "./navigation-query-projection";

type Pending = { controller: AbortController; readers: number; promise: Promise<NavigationQueryIndex> };

/** In-flight source work is shared; completed indexes are owned by query generations. */
export class NavigationIndexReadPool {
  private readonly joinable = new Map<string, Pending>();
  private readonly physical = new Set<Pending>();
  private readers = 0;

  invalidate(key: string): void { this.joinable.delete(key); }

  read(key: string, load: (signal: AbortSignal) => Promise<NavigationQueryIndex>, signal?: AbortSignal): Promise<NavigationQueryIndex> {
    signal?.throwIfAborted();
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
      }).finally(() => {
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
          owned.controller.abort();
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
