import type { FederationTarget, NavigationThreadSummary, ThreadLinkRef } from "@pwragent/shared";

/** Legacy blocker ids have no backend. Resolve only an unambiguous row on
 * the cleanup owner's instance, never a same-id row on a different peer. */
export function resolveBackgroundCleanupThread(
  ref: ThreadLinkRef,
  threads: readonly NavigationThreadSummary[],
  windowTarget?: FederationTarget,
): (ThreadLinkRef & { title?: string }) | undefined {
  let found: NavigationThreadSummary | undefined;
  for (const thread of threads) {
    if (thread.id !== ref.threadId || (ref.backend && ref.backend !== thread.source)) continue;
    const target = thread.federation?.ref.target ?? windowTarget;
    const instanceId = target?.scope === "remote" ? target.instanceId : undefined;
    if (instanceId !== ref.instanceId) continue;
    if (found) return undefined;
    found = thread;
  }
  return found ? { ...ref, backend: found.source, title: found.title } : undefined;
}
