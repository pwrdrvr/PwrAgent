import type {
  FederationRemoteTarget,
  NavigationThreadSummary,
} from "@pwragent/shared";
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
 * Which machine a row's work actually runs on.
 *
 * Two things make a row remote, and only checking one of them gets it wrong on
 * a surface that matters. A federation-stamped row is a peer's thread carried
 * into an unscoped window by a pin or a mounted parent. A window that fronts a
 * peer is the other case: its snapshot comes from that peer, so every row in it
 * is the peer's work and none of them carry a stamp — from the owner's side
 * they are local, and the stamp is only added on the way into someone else's
 * window.
 *
 * The distinction is load-bearing for the Attention tab: turns are driven by
 * the registry of the instance that owns them (see `buildQuitBlockerSnapshot`
 * in the main process), so only local work can hold this app's shutdown open.
 */
export function isThreadRemoteWork(
  thread: NavigationThreadSummary,
  federationWindowTarget?: FederationRemoteTarget,
): boolean {
  return (
    federationWindowTarget !== undefined
    || thread.federation?.ref.target.scope === "remote"
  );
}

export function formatLocalActiveThreadCount(count: number): string {
  return `${formatActiveThreadCount(count)} on this machine`;
}

export function formatRemoteActiveThreadCount(count: number): string {
  return `${formatActiveThreadCount(count)} on other instances`;
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
