import { threadTodoThreadKey, type ThreadTodo, type TodoBusyThread } from "@pwragent/shared";

export function newestResolvedFirst(left: ThreadTodo, right: ThreadTodo): number {
  return (right.resolvedAt ?? right.updatedAt) - (left.resolvedAt ?? left.updatedAt);
}

/**
 * A fresh listing plus the last cards of each pinned thread whose owner was
 * busy, so that owner's cards stay while every other card is current.
 */
export function keepBusyThreadTodos(
  previous: readonly ThreadTodo[] | undefined,
  fresh: ThreadTodo[],
  busyThreads: readonly TodoBusyThread[] | undefined,
  order: (left: ThreadTodo, right: ThreadTodo) => number,
): ThreadTodo[] {
  if (!busyThreads?.length || !previous?.length) return fresh;
  const busyKeys = new Set(busyThreads.map((thread) => threadTodoThreadKey(thread)));
  const kept = previous.filter((todo) => busyKeys.has(threadTodoThreadKey(todo)));
  return kept.length > 0 ? [...fresh, ...kept].sort(order) : fresh;
}
