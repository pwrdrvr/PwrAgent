import { getMainLogger } from "../log";

export type GitReadRequest = {
  userAction?: boolean;
  caller?: string;
};

/** One allowance for the process, not one per directory, window, or client. */
export class GitUserRefreshBudget {
  private tokens = 10;
  private updatedAt: number;
  private lastErrorAt = -Infinity;
  private denied = 0;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly report: (details: object) => void = (details) =>
      getMainLogger("pwragent:git-info").error("Git user refresh budget exhausted", details),
  ) {
    this.updatedAt = now();
  }

  tryTake(key: string, caller?: string): boolean {
    const now = Math.max(this.updatedAt, this.now());
    this.tokens = Math.min(10, this.tokens + (now - this.updatedAt) / 1_000);
    this.updatedAt = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    this.denied += 1;
    // A bad caller must not turn its read storm into a logging storm.
    if (now - this.lastErrorAt >= 10_000) {
      this.report({ directory: key, caller, denied: this.denied, capacity: 10, refillPerSecond: 1 });
      this.lastErrorAt = now;
      this.denied = 0;
    }
    return false;
  }
}

const userRefreshBudget = new GitUserRefreshBudget();

type Entry<T> = { expiresAt: number } & (
  | { failed: false; value: T }
  | { failed: true; error: unknown }
);

/** No I/O before this cache's decision. Undefined is a cacheable result too. */
export class GitReadCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly pending = new Map<string, Promise<T>>();
  private readonly now: () => number;

  constructor(private readonly options: {
    ttlMs: number;
    ttlFor?: (value: T, key: string) => number;
    now?: () => number;
    budget?: GitUserRefreshBudget;
    maxEntries?: number;
  }) {
    this.now = options.now ?? (() => performance.now());
  }

  read(
    key: string,
    // Nested caches receive the admitted decision, never the caller's claim.
    load: (admission: { userRefresh: boolean }) => Promise<T>,
    request: GitReadRequest = {},
    reused?: (reason: "cache-hit" | "pending-reuse") => void,
  ): Promise<T> {
    const pending = this.pending.get(key);
    if (pending) {
      reused?.("pending-reuse");
      return pending;
    }
    const cached = this.entries.get(key);
    const bypass = request.userAction === true
      && (this.options.budget ?? userRefreshBudget).tryTake(key, request.caller);
    if (cached && !bypass && cached.expiresAt > this.now()) {
      reused?.("cache-hit");
      return cached.failed ? Promise.reject(cached.error) : Promise.resolve(cached.value);
    }
    // Defer the loader until pending is installed, including synchronous failures.
    const result = Promise.resolve().then(() => load({ userRefresh: bypass })).then((value) => {
      // A mutation during the read must not publish pre-mutation facts.
      if (this.pending.get(key) === result) {
        this.remember(key, {
          failed: false, value,
          expiresAt: this.now() + (this.options.ttlFor?.(value, key) ?? this.options.ttlMs),
        });
      }
      return value;
    }, (error: unknown) => {
      if (this.pending.get(key) === result) {
        this.remember(key, { failed: true, error, expiresAt: this.now() + this.options.ttlMs });
      }
      throw error;
    }).finally(() => {
      if (this.pending.get(key) === result) this.pending.delete(key);
    });
    this.pending.set(key, result);
    return result;
  }

  private remember(key: string, entry: Entry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > (this.options.maxEntries ?? 4_096)) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  /** Only completed application mutations invalidate; user intent is a read hint. */
  invalidate(key: string): void {
    this.entries.delete(key);
    this.pending.delete(key);
  }

  invalidateWhere(matches: (key: string) => boolean): void {
    for (const key of new Set([...this.entries.keys(), ...this.pending.keys()])) {
      if (matches(key)) this.invalidate(key);
    }
  }
}
