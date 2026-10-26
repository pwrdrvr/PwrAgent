import type { MessagingBindingRecord } from "@pwragent/messaging-interface";

/**
 * Whether a binding belongs to a thread. The thread ids must match. The
 * backends must match too, unless the binding never recorded one: older
 * bindings lack a backend, and a strict match would drop them. Threads that
 * moved between backends keep their bindings through the same rule.
 *
 * The stores' `findActiveBindingsForThread` and the navigation snapshot
 * builders share this predicate, so a thread's chips and the controller's
 * bindings never disagree.
 */
export function isBindingForThread(
  binding: Pick<MessagingBindingRecord, "backend" | "threadId">,
  thread: {
    backend: MessagingBindingRecord["backend"];
    threadId: MessagingBindingRecord["threadId"];
  },
): boolean {
  if (binding.threadId !== thread.threadId) return false;
  return !binding.backend || binding.backend === thread.backend;
}

/**
 * Order a thread's bindings by creation, then id. Do not order by the
 * store's `updated_at`: every status card render rewrites it, and the chips
 * would trade places.
 */
export function compareBindingsByCreation(
  left: Pick<MessagingBindingRecord, "createdAt" | "id">,
  right: Pick<MessagingBindingRecord, "createdAt" | "id">,
): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}
