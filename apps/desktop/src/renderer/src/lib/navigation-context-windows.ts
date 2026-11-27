import type { NavigationQueryPage } from "@pwragent/shared/contracts/navigation";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { readCodexContextWindow, threadContextWindowReading, type ThreadContextWindowReading as Reading } from "@pwragent/shared/thread-context-window";
import { threadSummaryIdentityKey } from "./federated-thread-events";

function sameReading(left: Reading, right: Reading | undefined): boolean {
  return left.totalTokens === right?.totalTokens && left.modelContextWindow === right.modelContextWindow;
}

/** Window-local fills. Only the mounted hover card subscribes to its identity. */
export class NavigationContextWindows {
  private readonly live = new Map<string, { reading: Reading; session: boolean }>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly confirmed = new Set<string>();

  read(key: string, projected?: Reading): Reading | undefined {
    const live = this.live.get(key);
    return live?.session ? projected ?? live.reading : live?.reading ?? projected;
  }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    this.listeners.set(key, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }

  observe(key: string, backend: AgentEvent["backend"], notification: AgentEvent["notification"], projected?: Reading): void {
    const session = notification.method === "thread/contextWindow/updated" && notification.params.source === "session";
    if (notification.method === "thread/contextWindow/updated" && notification.params.source === "compaction") return;
    const previous = this.live.get(key);
    if (session && (previous || projected)) return;
    const reading = notification.method === "thread/contextWindow/updated"
      ? threadContextWindowReading(notification.params.usedTokens, notification.params.modelContextWindow)
      : backend === "codex" && notification.method === "thread/tokenUsage/updated" ? readCodexContextWindow(notification.params.tokenUsage) : undefined;
    if (!reading) return;

    // A valid repeat is still newer than any confirmation already in flight.
    this.confirmed.delete(key);
    if (previous && session === previous.session && sameReading(reading, previous.reading)) return;
    this.live.set(key, { reading, session });
    this.notify(key);
  }

  observePage(page: NavigationQueryPage): void {
    if (!this.live.size) return;
    for (const { row } of page.entries) {
      if (!row.contextWindow) continue;
      const key = threadSummaryIdentityKey(row);
      const live = this.live.get(key);
      if (live && (live.session || sameReading(live.reading, row.contextWindow))) this.confirmed.add(key);
    }
  }

  // A different resource may still land an older copy. Hand back to the row
  // only after the reads settle and the presented row reflects the owner.
  settlePages(rows: ReadonlyMap<string, { contextWindow?: Reading }> | undefined): void {
    for (const key of this.confirmed) {
      const live = this.live.get(key);
      const projected = rows?.get(key)?.contextWindow;
      if (live && projected && (live.session || sameReading(live.reading, projected))) this.forget(key);
    }
    this.confirmed.clear();
  }

  forget(key: string): void {
    this.confirmed.delete(key);
    if (this.live.delete(key)) this.notify(key);
  }

  private notify(key: string): void {
    this.listeners.get(key)?.forEach((listener) => listener());
  }
}
