import { useEffect, useRef, useState } from "react";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { PrChip } from "../pr-status/PrChip";
import { ReactionPicker } from "./ReactionPicker";
import { ThreadMetaChips } from "./ThreadMetaChips";
import { getThreadRowStatus, ThreadRowStatus } from "./ThreadRowStatus";

const HOVER_PREFETCH_DELAY_MS = 750;

type ThreadRowProps = {
  approvalRequestThreadKeys?: Record<string, boolean>;
  compact?: boolean;
  includeLinkedDirectories?: boolean;
  linkedDirectoryMode?: "label" | "kind";
  selectedThreadKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  thread: NavigationThreadSummary;
  onOpenContextMenu: (
    thread: NavigationThreadSummary,
    position: { x: number; y: number; anchorTop?: number }
  ) => void;
  /**
   * Fired after a 750ms hover over a non-merged PR chip. The parent
   * decides whether to actually issue an IPC fetch (e.g. dedupe by
   * thread key, respect terminal-state short-circuit on the main side).
   */
  onPrefetchPullRequests?: (thread: NavigationThreadSummary) => void;
  onSelectThread: (thread: NavigationThreadSummary) => void;
  onSetReaction?: (
    thread: NavigationThreadSummary,
    emoji: string,
    present: boolean,
  ) => Promise<void>;
  onOpenPullRequest?: (url: string) => void;
};

export function ThreadRow(props: ThreadRowProps) {
  const threadKey = buildThreadIdentityKey(props.thread.source, props.thread.id);
  const selected =
    threadKey === props.selectedThreadKey;
  const status = getThreadRowStatus(props.thread, props.thinkingThreadKeys);
  const [pickerOpen, setPickerOpen] = useState(false);
  const addReactionRef = useRef<HTMLButtonElement>(null);
  const reactions = props.thread.reactions ?? [];
  const canReact = Boolean(props.onSetReaction);
  // Pull straight from the navigation snapshot — main persists PR state
  // to the overlay store and surfaces it through the snapshot, so the
  // chips render instantly on app launch and stay in sync without any
  // renderer-side cache.
  const prs = props.thread.prs ?? [];
  const showRepoPrefix = needsRepoPrefix(prs);
  const openPr = props.onOpenPullRequest ?? defaultOpenPullRequest;
  const hasNonTerminalPr = prs.some(
    (pr) => pr.state !== "merged" && pr.state !== "closed",
  );
  // Hover prefetch: 750ms intent timer — long enough that simply scrolling
  // past doesn't fire, short enough that a deliberate hover beats the
  // user's first click.
  const hoverTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (hoverTimerRef.current !== undefined) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = undefined;
    }
  }, []);
  const armHoverPrefetch = (): void => {
    if (!props.onPrefetchPullRequests) return;
    if (!hasNonTerminalPr) return;
    if (hoverTimerRef.current !== undefined) return;
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = undefined;
      props.onPrefetchPullRequests?.(props.thread);
    }, HOVER_PREFETCH_DELAY_MS);
  };
  const cancelHoverPrefetch = (): void => {
    if (hoverTimerRef.current !== undefined) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = undefined;
    }
  };

  const toggleReaction = (emoji: string): void => {
    if (!props.onSetReaction) {
      return;
    }
    const present = !reactions.includes(emoji);
    void props.onSetReaction(props.thread, emoji, present);
  };

  return (
    <div
      className="thread-row-shell"
      role="listitem"
      onContextMenu={(event) => {
        event.preventDefault();
        props.onOpenContextMenu(props.thread, {
          x: event.clientX,
          y: event.clientY,
        });
      }}
    >
      <button
        aria-pressed={selected}
        className={`thread-row${props.compact ? " thread-row--compact" : ""}${
          selected ? " is-selected" : ""
        }`}
        type="button"
        onClick={() => props.onSelectThread(props.thread)}
      >
        <span className="thread-row__header">
          <span className="thread-row__heading">
            <ThreadRowStatus status={status} />
            <span className="thread-row__title">{props.thread.title}</span>
          </span>
          <span className="thread-row__time">
            {formatRelativeTime(props.thread.updatedAt)}
          </span>
        </span>

        <ThreadMetaChips
          hasApprovalRequest={props.approvalRequestThreadKeys?.[threadKey] === true}
          includeLinkedDirectories={props.includeLinkedDirectories}
          linkedDirectoryMode={props.linkedDirectoryMode}
          thread={props.thread}
        />

        {prs.length > 0 ? (
          <span
            className="thread-row__pr-chips"
            onMouseEnter={armHoverPrefetch}
            onMouseLeave={cancelHoverPrefetch}
          >
            {prs.map((pr) => (
              <PrChip
                key={pr.url}
                pr={pr}
                showRepoPrefix={showRepoPrefix}
                onOpen={openPr}
              />
            ))}
          </span>
        ) : null}
      </button>

      {canReact || reactions.length > 0 ? (
        <div className="thread-row__reactions">
          {reactions.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`Remove reaction ${emoji} from thread`}
              className="thread-row__reaction"
              onClick={(event) => {
                event.stopPropagation();
                toggleReaction(emoji);
              }}
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}

          {canReact ? (
            <div className="thread-row__reaction-picker-wrap">
              <button
                ref={addReactionRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={pickerOpen}
                aria-label="Add reaction to thread"
                className="thread-row__add-reaction"
                onClick={(event) => {
                  event.stopPropagation();
                  setPickerOpen((open) => !open);
                }}
              >
                <span aria-hidden="true">+</span>
              </button>
              <ReactionPicker
                open={pickerOpen}
                current={reactions}
                anchorRef={addReactionRef}
                onSelect={(emoji) => {
                  toggleReaction(emoji);
                  setPickerOpen(false);
                }}
                onDismiss={() => setPickerOpen(false)}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <button
        aria-haspopup="menu"
        aria-label="Open thread actions"
        className="thread-row__overflow-button"
        title={`Open thread actions for ${props.thread.title}`}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          props.onOpenContextMenu(props.thread, {
            x: rect.left,
            y: rect.bottom + 4,
            anchorTop: rect.top,
          });
        }}
      >
        ...
      </button>
    </div>
  );
}

function needsRepoPrefix(prs: PrSummary[]): boolean {
  if (prs.length <= 1) {
    return false;
  }
  const firstKey = `${prs[0]!.org}/${prs[0]!.repo}`;
  return prs.some((pr) => `${pr.org}/${pr.repo}` !== firstKey);
}

function defaultOpenPullRequest(url: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) {
    return "now";
  }

  const deltaMinutes = Math.max(
    0,
    Math.round((Date.now() - timestamp) / (1000 * 60))
  );

  if (deltaMinutes < 1) {
    return "now";
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`;
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h`;
  }

  const deltaDays = Math.round(deltaHours / 24);
  if (deltaDays < 7) {
    return `${deltaDays}d`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}
