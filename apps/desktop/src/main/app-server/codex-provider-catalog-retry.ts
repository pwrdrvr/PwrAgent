import type { CodexModelProviderCatalogState } from "@pwragent/shared/contracts/backend";

/** Starts and stops the retry's one timer. A test can fire it on demand. */
export type CodexProviderCatalogRetryTimer = {
  set: (run: () => Promise<void>, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
};

const systemTimer: CodexProviderCatalogRetryTimer = {
  set: (run, delayMs) => {
    const handle = setTimeout(() => void run(), delayMs);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Re-reads Codex model provider catalogs after a failed read, without the
 * operator asking.
 *
 * The Codex model list is cached until a config change or a Settings
 * refresh, so a provider whose `/models` read failed (network down, a 503)
 * would offer only its listed models until then. While any provider's
 * catalog is `unavailable`, this keeps one timer: the first retry waits out
 * the catalog's one-minute failure window, and each further failure doubles
 * the wait up to ten minutes. It schedules nothing while every provider is
 * healthy, and stops when the failing ones recover or are removed.
 */
export class CodexProviderCatalogRetry {
  private timer: unknown;
  private attempt = 0;
  private running = false;
  /** What other reads published while a refresh ran. */
  private observedWhileRunning: readonly CodexModelProviderCatalogState[] = [];
  private closed = false;

  constructor(private readonly options: {
    /** Re-read the catalogs, publish the result, and return the new states. */
    refresh: () => Promise<readonly CodexModelProviderCatalogState[]>;
    /** After the catalog's one-minute failure window. */
    baseDelayMs?: number;
    maxDelayMs?: number;
    timer?: CodexProviderCatalogRetryTimer;
  }) {}

  /** Look at the latest catalog states, as each read publishes them. */
  observe(states: readonly CodexModelProviderCatalogState[]): void {
    if (this.closed) return;
    if (this.running) {
      // A Settings save can read a provider while the retry runs. Its
      // failure must still arm the next retry once this one returns.
      this.observedWhileRunning = [...this.observedWhileRunning, ...states];
      return;
    }
    if (!states.some((state) => state.status === "unavailable")) {
      this.clear();
      this.attempt = 0;
      return;
    }
    if (this.timer !== undefined) return;
    const base = this.options.baseDelayMs ?? 65_000;
    const delay = Math.min(base * 2 ** this.attempt, this.options.maxDelayMs ?? 10 * 60_000);
    this.timer = (this.options.timer ?? systemTimer).set(() => this.fire(), delay);
  }

  close(): void {
    this.closed = true;
    this.clear();
  }

  private async fire(): Promise<void> {
    this.timer = undefined;
    this.attempt += 1;
    this.running = true;
    let states: readonly CodexModelProviderCatalogState[] | undefined;
    try {
      states = await this.options.refresh();
    } catch {
      // The refresh could not even run; try again on the same schedule.
      states = [{ id: "", name: "", status: "unavailable", listedCount: 0 }];
    } finally {
      this.running = false;
    }
    const observed = this.observedWhileRunning;
    this.observedWhileRunning = [];
    this.observe([...states, ...observed]);
  }

  private clear(): void {
    if (this.timer !== undefined) (this.options.timer ?? systemTimer).clear(this.timer);
    this.timer = undefined;
  }
}
