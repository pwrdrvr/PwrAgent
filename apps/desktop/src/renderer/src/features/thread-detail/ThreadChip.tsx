import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ThreadIcon } from "../../icons";
import { useLiveThreadLink } from "../../lib/thread-links";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import {
  ChipContextMenu,
  type ChipContextMenuPosition,
} from "../chrome/ChipContextMenu";
import { threadCopyTargets } from "../chrome/ThreadChipContextMenu";

export { threadCopyTargets } from "../chrome/ThreadChipContextMenu";

type ThreadChipProps = {
  /**
   * Link text the author wrote or title hydrated with message provenance.
   * The chip prefers the thread's live title unless navigation still knows
   * only a fallback title from before the thread received its real name.
   */
  fallbackLabel?: string;
  link: ResolvedThreadLink;
  onOpen: (link: ResolvedThreadLink) => void;
};

export function ThreadChip(props: ThreadChipProps) {
  const link = useLiveThreadLink(props.link);
  const contextMenuInvokerRef = useRef<HTMLSpanElement>(null);
  const [contextMenuPosition, setContextMenuPosition] =
    useState<ChipContextMenuPosition>();
  const tooltipController = useViewportTooltip({ className: "viewport-tooltip" });

  const liveTitle = link.title.trim();
  const fallbackLabel = props.fallbackLabel?.trim();
  const label = link.titleSource === "fallback" && fallbackLabel
    ? fallbackLabel
    : liveTitle || fallbackLabel || link.threadId;
  const tooltip = link.gitBranch
    ? `${label}\n${link.gitBranch} — open thread`
    : `${label}\nOpen thread`;

  // role="button" span rather than a real <button>: the chip renders inside
  // markdown that may already sit within a clickable surface, and a nested
  // <button> is invalid HTML.
  const handleActivate = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    tooltipController.hide();
    event.currentTarget.blur();
    props.onOpen(link);
  };

  return (
    <>
      <span
        aria-label={`Open thread ${label}`}
        aria-haspopup="menu"
        className="chip thread-chip"
        data-thread-chip=""
        draggable={false}
        role="button"
        tabIndex={0}
        onBlur={tooltipController.hide}
        onClick={handleActivate}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          window.getSelection()?.removeAllRanges();
          tooltipController.hide();
          const rect = event.currentTarget.getBoundingClientRect();
          contextMenuInvokerRef.current = event.currentTarget;
          setContextMenuPosition({
            x: event.clientX,
            y: event.clientY,
            anchorTop: rect.top,
          });
        }}
        onDragStart={(event) => event.preventDefault()}
        onFocus={(event) => tooltipController.show(event.currentTarget, tooltip)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            handleActivate(event);
          }
        }}
        onMouseEnter={(event) => tooltipController.show(event.currentTarget, tooltip)}
        onMouseLeave={tooltipController.hide}
      >
        <ThreadIcon className="thread-chip__icon" size={12} />
        <span className="thread-chip__label">#{label.replace(/^#/, "")}</span>
      </span>
      {tooltipController.tooltipNode}
      {contextMenuPosition && contextMenuInvokerRef.current ? (
        <ChipContextMenu
          items={threadCopyTargets(link, label)}
          position={contextMenuPosition}
          returnFocusTo={contextMenuInvokerRef.current}
          onClose={() => setContextMenuPosition(undefined)}
        />
      ) : null}
    </>
  );
}
