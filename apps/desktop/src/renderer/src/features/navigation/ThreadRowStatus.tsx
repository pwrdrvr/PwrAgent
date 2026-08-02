import type { NavigationThreadSummary } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { ThinkingScanner } from "../thread-detail/ThinkingScanner";

export type ThreadRowStatusKind = "thinking" | "unread";

/**
 * A thread is live when the backend reports an active turn or the renderer has
 * just initiated one and is waiting for that status to round-trip. Keep this
 * predicate shared with aggregate activity counts so their numbers match the
 * animated thread-row marker exactly.
 */
export function isThreadActive(
  thread: NavigationThreadSummary,
  thinkingThreadKeys?: Record<string, boolean>,
): boolean {
  const threadKey = buildThreadIdentityKey(thread.source, thread.id);
  return (
    thread.threadStatus === "active"
    || thinkingThreadKeys?.[threadKey] === true
  );
}

export function formatActiveThreadCount(count: number): string {
  return `${count} active thread${count === 1 ? "" : "s"}`;
}

export function getThreadRowStatus(
  thread: NavigationThreadSummary,
  thinkingThreadKeys?: Record<string, boolean>
): ThreadRowStatusKind | undefined {
  if (isThreadActive(thread, thinkingThreadKeys)) {
    return "thinking";
  }

  if (thread.inbox.reason === "updated-since-seen") {
    return "unread";
  }

  return undefined;
}

type ThreadRowStatusProps = {
  status?: ThreadRowStatusKind;
};

export function ThreadRowStatus(props: ThreadRowStatusProps) {
  if (!props.status) {
    return null;
  }

  if (props.status === "thinking") {
    return (
      <span
        aria-label="Thinking"
        className="thread-row__status-indicator thread-row__status-indicator--thinking"
        data-thread-status="thinking"
        title="Thinking"
      >
        <ThinkingScanner compact />
      </span>
    );
  }

  return (
    <span
      aria-label="Unread update"
      className="thread-row__status-indicator thread-row__status-indicator--unread"
      data-thread-status="unread"
      title="Unread update"
    >
      <span aria-hidden="true" className="thread-row__status-cookie" />
    </span>
  );
}
