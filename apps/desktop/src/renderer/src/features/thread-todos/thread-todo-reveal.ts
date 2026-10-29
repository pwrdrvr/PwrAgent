import { createContext, useContext } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";

/**
 * A request, from a thread row's to-do chip, to show that thread's cards.
 * Each click makes a new object, so the request is its own identity.
 */
export type ThreadTodoRevealRequest = { threadKey: string };

/**
 * Opens a thread with its to-dos in view. A context for the same reason as
 * ThreadTodoCountsContext: the chip sits several list components below App.
 */
export const ThreadTodoRevealContext = createContext<
  ((thread: NavigationThreadSummary) => void) | undefined
>(undefined);

export function useThreadTodoReveal(): ((thread: NavigationThreadSummary) => void) | undefined {
  return useContext(ThreadTodoRevealContext);
}

const consumed = new WeakSet<ThreadTodoRevealRequest>();

/**
 * True once per request, for the first surface that shows its thread: the
 * transcript's card stack or the rail's To-dos panel. A surface that mounts
 * later, as the panel does when the operator switches rail tabs, does not
 * act on the same click again.
 */
export function consumeThreadTodoReveal(
  request: ThreadTodoRevealRequest | undefined,
  threadKey: string,
): boolean {
  if (!request || request.threadKey !== threadKey || consumed.has(request)) return false;
  consumed.add(request);
  return true;
}
