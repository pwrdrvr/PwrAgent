import type { NavigationThreadSummary } from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
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
  const threadKey = threadSummaryIdentityKey(thread);
  return (
    thread.threadStatus === "active"
    || thinkingThreadKeys?.[threadKey] === true
  );
}

export function formatActiveThreadCount(count: number): string {
  return `${count} active thread${count === 1 ? "" : "s"}`;
}

/**
 * Inbox membership includes both a thread that is new to the operator and an
 * existing thread updated since it was last seen. Directory summaries call
 * this "to review" rather than collapsing it into the live-turn count.
 */
export function isThreadAwaitingReview(thread: NavigationThreadSummary): boolean {
  return thread.inbox.inInbox;
}

export function formatReviewThreadCount(count: number): string {
  return `${count} thread${count === 1 ? "" : "s"} to review`;
}

/**
 * Membership test for the Attention lens: a live turn, or waiting to be
 * reviewed. Shares both predicates with the tab's two counts and with the
 * directory-header counts, so the queue's length and the numbers on the tab
 * can never disagree.
 */
export function isThreadNeedingAttention(
  thread: NavigationThreadSummary,
  thinkingThreadKeys?: Record<string, boolean>,
): boolean {
  return (
    isThreadActive(thread, thinkingThreadKeys)
    || isThreadAwaitingReview(thread)
  );
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
