import type { NavigationThreadSummary } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
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

  // role="img": an aria-label on a role-less span is a prohibited ARIA
  // attribute (axe aria-prohibited-attr) unless the closest ancestor is
  // a widget. The star-map card still nests this inside its open
  // button, but the sidebar's title line is a plain listitem subtree
  // since the transcript-gaps pass — the img role makes the label valid
  // on both surfaces and says what the mark is: a meaningful graphic.
  if (props.status === "thinking") {
    return (
      <span
        aria-label="Thinking"
        className="thread-row__status-indicator thread-row__status-indicator--thinking"
        data-thread-status="thinking"
        role="img"
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
      role="img"
      title="Unread update"
    >
      <span aria-hidden="true" className="thread-row__status-cookie" />
    </span>
  );
}
