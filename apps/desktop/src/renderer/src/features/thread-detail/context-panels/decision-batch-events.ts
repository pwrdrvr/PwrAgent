import type { AgentEvent } from "@pwragent/shared";

/**
 * The owner announced that one of this thread's decision batches moved:
 * it started, finished another tenth of its items, or ended. The batch
 * itself is read from the owner; the event only says to read again.
 */
export function isDecisionBatchEventFor(
  event: AgentEvent,
  thread: { backend: string; threadId: string },
): boolean {
  const notification = event.notification;
  return notification.method === "thread/decisionBatches/updated"
    && event.backend === thread.backend
    && notification.params.threadId === thread.threadId;
}
