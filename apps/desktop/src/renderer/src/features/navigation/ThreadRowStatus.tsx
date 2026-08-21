import type { NavigationThreadSummary } from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import { readRendererFederationTarget } from "../../lib/federation-window";
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
 * Whether a row is a peer's thread carried into this window by a pin or a
 * mounted parent, rather than one this instance owns.
 *
 * The distinction is load-bearing for the Attention tab: turns are driven by
 * the registry of the instance that owns them (see `buildQuitBlockerSnapshot`
 * in the main process), so only local work can hold this app's shutdown open.
 *
 * Only meaningful in a window that can hold both kinds. A window fronting a
 * peer reads its whole navigation snapshot through that peer, and
 * `stampRemoteNavigationSnapshot` stamps EVERY row it returns — so this
 * predicate answers "yes" for all of them and a local-vs-remote split there
 * degenerates to "0 here, everything elsewhere". A viewer has to decide "is
 * any of this mine?" from its own scope instead, which is why `Sidebar` gates
 * on the window target before it consults this at all.
 */
export function isThreadRemoteWork(thread: NavigationThreadSummary): boolean {
  return thread.federation?.ref.target.scope === "remote";
}

/**
 * Whether this window tells a peer's turns apart from its own at all.
 *
 * The main window can hold both kinds, and only its own turns hold shutdown
 * open, so it colours them apart: accent here, neutral elsewhere. A window
 * fronting a peer is exactly the window where that question has no content —
 * every row in it is that peer's work (the main process stamps the whole
 * snapshot remote, see `isThreadRemoteWork`), and closing the viewer
 * interrupts none of it. Telling the operator what quitting would do to work
 * they cannot interrupt is worse than saying nothing, so a viewer keeps the
 * plain accent everywhere and counts the peer's turns the way an unfederated
 * instance counts its own.
 *
 * One gate for every surface that colours a turn: the Attention tab's split
 * counts, the thread rows' scanners, and the transcript's pending line. They
 * agree by construction — a row's beam is neutral exactly when the tab counts
 * it under "elsewhere".
 */
export function windowSplitsTurnsByMachine(): boolean {
  return readRendererFederationTarget() === undefined;
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
  /**
   * The live turn belongs to another instance. Same beam, neutral tokens:
   * the accent means "this holds the app open", and a peer's turn does not.
   * The caller decides — the sidebar row gates it on
   * `windowSplitsTurnsByMachine()` to match its Attention tab, the Star Map
   * card on the bare `isThreadRemoteWork` to match its Attention chip — so
   * the mark always agrees with the readout that counts it.
   */
  remoteWork?: boolean;
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
    // "on another instance" echoes `formatRemoteActiveThreadCount`, the
    // phrase the Attention tab already reads out for the same turns.
    const label = props.remoteWork ? "Thinking on another instance" : "Thinking";
    return (
      <span
        aria-label={label}
        className={`thread-row__status-indicator thread-row__status-indicator--thinking${
          props.remoteWork ? " thread-row__status-indicator--remote" : ""
        }`}
        data-remote-work={props.remoteWork ? "true" : undefined}
        data-thread-status="thinking"
        role="img"
        title={label}
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
