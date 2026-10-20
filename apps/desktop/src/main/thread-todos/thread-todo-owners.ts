import { buildThreadIdentityKey } from "@pwragent/shared";
import type { NavigationThreadSummary, ThreadTodo } from "@pwragent/shared";

type TodoOwner = Pick<NavigationThreadSummary, "id" | "source" | "title" | "archivedAt" | "federation">;

/**
 * Cards outlive thread listings and archive events can be missed while the
 * app is closed. Use the complete owner index, never the sidebar's loaded
 * slice or the existence of an overlay, to decide which cards are reachable.
 * One shared index read serves every card, without per-card provider lookups.
 */
export async function listThreadTodosForAvailableOwners(
  todos: ThreadTodo[],
  loadOwners: () => Promise<readonly TodoOwner[]>,
): Promise<ThreadTodo[]> {
  if (todos.length === 0) return [];
  const owners = new Map((await loadOwners())
    .filter((thread) => !thread.federation && thread.archivedAt === undefined)
    .map((thread) => [buildThreadIdentityKey(thread.source, thread.id), thread]));
  return todos.flatMap((todo) => {
    const owner = owners.get(buildThreadIdentityKey(todo.backend, todo.threadId));
    return owner ? [{ ...todo, threadTitle: owner.title }] : [];
  });
}
