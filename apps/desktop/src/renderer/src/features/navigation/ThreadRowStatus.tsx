import type { NavigationThreadSummary } from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import { ThinkingScanner } from "../thread-detail/ThinkingScanner";

export type ThreadRowStatusKind = "thinking" | "unread";

export function getThreadRowStatus(
  thread: NavigationThreadSummary,
  thinkingThreadKeys?: Record<string, boolean>
): ThreadRowStatusKind | undefined {
  const threadKey = buildThreadIdentityKey(thread.source, thread.id);
  if (thinkingThreadKeys?.[threadKey]) {
    return "thinking";
  }

  if (thread.inbox.inInbox) {
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
      aria-label="Needs attention"
      className="thread-row__status-indicator thread-row__status-indicator--unread"
      data-thread-status="unread"
      title="Needs attention"
    >
      <span aria-hidden="true" className="thread-row__status-dot">
        !
      </span>
    </span>
  );
}
