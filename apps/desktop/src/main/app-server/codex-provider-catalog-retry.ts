import type { CodexModelProviderCatalogState } from "@pwragent/shared";

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
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private running = false;
  private closed = false;

  constructor(private readonly options: {
    /** Re-read the catalogs, publish the result, and return the new states. */
    refresh: () => Promise<readonly CodexModelProviderCatalogState[]>;
    /** After the catalog's one-minute failure window. */
    baseDelayMs?: number;
    maxDelayMs?: number;
  }) {}

  /** Look at the latest catalog states, as each read publishes them. */
  observe(states: readonly CodexModelProviderCatalogState[]): void {
    if (this.closed || this.running) return;
    if (!states.some((state) => state.status === "unavailable")) {
      this.clear();
      this.attempt = 0;
      return;
    }
    if (this.timer !== undefined) return;
    const base = this.options.baseDelayMs ?? 65_000;
    const delay = Math.min(base * 2 ** this.attempt, this.options.maxDelayMs ?? 10 * 60_000);
    this.timer = setTimeout(() => void this.fire(), delay);
    this.timer.unref?.();
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
    this.observe(states);
  }

  private clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
