import { getMainLogger } from "./log";
import type { RuntimeLeaseKind, RuntimeLeaseManager } from "./runtime-lease-manager";

export const RUNTIME_LEASE_RETRY_MS = 5_000;
const log = getMainLogger("pwragent:runtime-lease-retry");

/** Only blocked runtimes poll. Checks are read-only; acquisition stays atomic. */
export class RuntimeLeaseRetry {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  cancel(): number {
    clearTimeout(this.timer);
    this.timer = undefined;
    return ++this.generation;
  }

  schedule(
    manager: RuntimeLeaseManager,
    kind: RuntimeLeaseKind,
    generation: number,
    retry: () => Promise<unknown>,
  ): void {
    if (generation !== this.generation) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (generation !== this.generation) return;
      try {
        if (!manager.shouldRetryAcquisition(kind)) {
          this.schedule(manager, kind, generation, retry);
          return;
        }
        // A denied acquisition schedules the next check through its coordinator.
        void retry().catch((error: unknown) => {
          log.error("runtime lease recovery failed", { kind, error: String(error) });
        });
      } catch (error) {
        log.error("runtime lease recovery check failed", { kind, error: String(error) });
        this.schedule(manager, kind, generation, retry);
      }
    }, RUNTIME_LEASE_RETRY_MS);
    this.timer.unref?.();
  }
}
