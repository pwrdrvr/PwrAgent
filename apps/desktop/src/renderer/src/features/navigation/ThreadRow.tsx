import type { NavigationThreadSummary } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { ThreadMetaChips } from "./ThreadMetaChips";
import { getThreadRowStatus, ThreadRowStatus } from "./ThreadRowStatus";

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
  onSelectThread: (thread: NavigationThreadSummary) => void;
};

export function ThreadRow(props: ThreadRowProps) {
  const threadKey = buildThreadIdentityKey(props.thread.source, props.thread.id);
  const selected =
    threadKey === props.selectedThreadKey;
  const status = getThreadRowStatus(props.thread, props.thinkingThreadKeys);

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
      </button>

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
