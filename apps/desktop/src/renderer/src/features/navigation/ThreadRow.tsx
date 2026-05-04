import { useState } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { ReactionPicker } from "./ReactionPicker";
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
  onSetReaction?: (
    thread: NavigationThreadSummary,
    emoji: string,
    present: boolean,
  ) => Promise<void>;
};

export function ThreadRow(props: ThreadRowProps) {
  const threadKey = buildThreadIdentityKey(props.thread.source, props.thread.id);
  const selected =
    threadKey === props.selectedThreadKey;
  const status = getThreadRowStatus(props.thread, props.thinkingThreadKeys);
  const [pickerOpen, setPickerOpen] = useState(false);
  const reactions = props.thread.reactions ?? [];
  const canReact = Boolean(props.onSetReaction);

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
