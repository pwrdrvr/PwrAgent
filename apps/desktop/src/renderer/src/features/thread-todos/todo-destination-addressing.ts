import type { NavigationThreadSummary, ThreadTodo, ThreadTodoMessageTarget } from "@pwragent/shared";
import type { ThreadTodoLocalMachine } from "./thread-todos-view";

export type TodoDestinationCandidate = {
  thread: NavigationThreadSummary;
  target: ThreadTodoMessageTarget;
};

/**
 * The card's destination for a search result, relative to the card's owner,
 * or nothing when the card cannot address it: its own thread, or a thread on
 * this machine from a peer's card while this window does not know its own
 * machine id.
 *
 * A row names its owner relative to this window (`federation.ref.target`, or
 * nothing for this machine). A card names its owner the same way
 * (`todo.federationTarget`). The target names the row's owner relative to the
 * card's: no `instanceId` when they are the same machine.
 */
export function todoDestination(
  thread: NavigationThreadSummary,
  todo: ThreadTodo,
  localMachine: ThreadTodoLocalMachine | undefined,
): ThreadTodoMessageTarget | undefined {
  const owner = todo.federationTarget?.instanceId;
  const ref = thread.federation?.ref.target;
  const resultIsRemote = ref?.scope === "remote";
  const instanceId = ref?.scope === "remote" ? ref.instanceId : localMachine?.instanceId;
  if (owner && !instanceId) return undefined;
  const remote = instanceId !== owner && (owner !== undefined || resultIsRemote);
  if (!remote && thread.source === todo.backend && thread.id === todo.threadId) return undefined;
  return {
    backend: thread.source, threadId: thread.id, title: thread.title,
    ...(remote && instanceId ? { instanceId } : {}),
    ...(thread.federation?.instanceLabel ? { instanceLabel: thread.federation.instanceLabel }
      : localMachine?.label ? { instanceLabel: localMachine.label } : {}),
  };
}

/** The rows a card can address, each with its destination. */
export function addressableTodoDestinations(
  threads: readonly NavigationThreadSummary[],
  todo: ThreadTodo,
  localMachine: ThreadTodoLocalMachine | undefined,
): TodoDestinationCandidate[] {
  return threads.flatMap((thread) => {
    const target = todoDestination(thread, todo, localMachine);
    return target ? [{ thread, target }] : [];
  });
}
