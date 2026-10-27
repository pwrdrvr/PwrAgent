import { buildThreadIdentityKey } from "@pwragent/shared";
import type { AppServerThreadSummary, ThreadTodo } from "@pwragent/shared";

type TodoOwner = Pick<AppServerThreadSummary, "id" | "source" | "title" | "archivedAt"> & { federation?: unknown };

/**
 * Cards outlive thread listings and archive events can be missed while the
 * app is closed. Use the owner's complete provider listing, never the
 * sidebar's loaded slice or the existence of an overlay, to decide which
 * cards are reachable. One listing serves every card, without per-card
 * provider lookups.
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
