import type { AppServerBackendKind, FederationTarget, NavigationThreadSummary, ThreadDependencyCondition } from "@pwragent/shared";
import type { ThreadSearchCandidate } from "../thread-search/ThreadSearchPicker";
import { threadMachineFrom } from "../thread-search/thread-address";

/** A prerequisite thread as the waiting thread's owner stores it. */
export type DependencyThread = Pick<ThreadDependencyCondition, "backend" | "threadId" | "title" | "target">;

/** The thread that waits, and the machine that owns its wait, as this window names it. */
export type WaitingThread = {
  backend: AppServerBackendKind;
  threadId: string;
  owner?: FederationTarget;
};

/**
 * What a wait records for a search row, or nothing when it cannot: the
 * waiting thread itself, or a row this window cannot name from the owner.
 * The row's machine is named relative to the wait's owner, as the owner
 * stores it: no `target` for the owner's own machine.
 */
export function dependencyThread(
  thread: NavigationThreadSummary,
  waiting: WaitingThread,
  localInstanceId: string | undefined,
): DependencyThread | undefined {
  const owner = waiting.owner?.scope === "remote" ? waiting.owner.instanceId : undefined;
  const machine = threadMachineFrom(thread, owner, localInstanceId);
  if (!machine) return undefined;
  if (!machine.instanceId && thread.source === waiting.backend && thread.id === waiting.threadId) return undefined;
  return {
    backend: thread.source,
    threadId: thread.id,
    ...(machine.instanceId ? { target: { scope: "remote", instanceId: machine.instanceId } } : {}),
    ...(thread.title?.trim() ? { title: thread.title.trim().slice(0, 200) } : {}),
  };
}

/** The rows a wait can depend on, each with what it records. */
export function dependencyThreadCandidates(
  threads: readonly NavigationThreadSummary[],
  waiting: WaitingThread,
  localInstanceId: string | undefined,
): ThreadSearchCandidate<DependencyThread>[] {
  return threads.flatMap((thread) => {
    const target = dependencyThread(thread, waiting, localInstanceId);
    return target ? [{ thread, target }] : [];
  });
}

/** A prerequisite's identity as the owner stores it, machine included. */
export const dependencyThreadIdentity = (value: Pick<DependencyThread, "backend" | "threadId" | "target">): string =>
  JSON.stringify([value.target?.instanceId ?? null, value.backend, value.threadId]);
