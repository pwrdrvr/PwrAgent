import type { FederationTarget, NavigationThreadSummary, ThreadMergeHold } from "@pwragent/shared";
import type { ThreadSearchCandidate } from "../thread-search/ThreadSearchPicker";
import { threadMachineFrom } from "../thread-search/thread-address";

type Dependency = NonNullable<ThreadMergeHold["dependency"]>;

/** The thread that waits, and the machine that owns its wait, as this window names it. */
export type WaitingThread = {
  backend: ThreadMergeHold["backend"];
  threadId: string;
  owner?: FederationTarget;
};

/**
 * What a wait records for a search row, or nothing when it cannot: the
 * waiting thread itself, or a row this window cannot name from the owner.
 * The row's machine is named relative to the wait's owner, as the owner
 * stores it: `local` for the owner's own machine.
 */
export function mergeHoldDependency(
  thread: NavigationThreadSummary,
  waiting: WaitingThread,
  localInstanceId: string | undefined,
): Dependency | undefined {
  const owner = waiting.owner?.scope === "remote" ? waiting.owner.instanceId : undefined;
  const machine = threadMachineFrom(thread, owner, localInstanceId);
  if (!machine) return undefined;
  if (!machine.instanceId && thread.source === waiting.backend && thread.id === waiting.threadId) return undefined;
  return {
    backend: thread.source,
    threadId: thread.id,
    target: machine.instanceId ? { scope: "remote", instanceId: machine.instanceId } : { scope: "local" },
    ...(thread.title?.trim() ? { title: thread.title.trim().slice(0, 200) } : {}),
  };
}

/** The rows a wait can depend on, each with what it records. */
export function mergeHoldDependencyCandidates(
  threads: readonly NavigationThreadSummary[],
  waiting: WaitingThread,
  localInstanceId: string | undefined,
): ThreadSearchCandidate<Dependency>[] {
  return threads.flatMap((thread) => {
    const target = mergeHoldDependency(thread, waiting, localInstanceId);
    return target ? [{ thread, target }] : [];
  });
}
