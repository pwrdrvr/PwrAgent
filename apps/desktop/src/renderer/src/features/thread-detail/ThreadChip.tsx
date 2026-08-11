import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { PopoutIcon, ThreadIcon } from "../../icons";
import { useLiveThreadLink, useThreadLinks } from "../../lib/thread-links";
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
  contextMenuClassName?: string;
  onOpen: (link: ResolvedThreadLink) => void;
};

export function ThreadChip(props: ThreadChipProps) {
  const link = useLiveThreadLink(props.link);
  const threadLinks = useThreadLinks();
  const contextMenuInvokerRef = useRef<HTMLSpanElement>(null);
  const [contextMenuPosition, setContextMenuPosition] =
    useState<ChipContextMenuPosition>();
  const tooltipController = useViewportTooltip({ className: "viewport-tooltip" });
  const popoutTooltipController = useViewportTooltip({
    className: "viewport-tooltip",
  });

  const liveTitle = link.title.trim();
  const fallbackLabel = props.fallbackLabel?.trim();
  const label = link.titleSource === "fallback" && fallbackLabel
    ? fallbackLabel
    : liveTitle || fallbackLabel || link.threadId;
  const tooltip = link.gitBranch
    ? `${label}\n${link.gitBranch} — open thread`
    : `${label}\nOpen thread`;
  const remoteInstanceLabel = link.instanceLabel ?? link.instanceId;
  const remoteViewerTooltip = remoteInstanceLabel
    ? `Open this thread in the remote viewer window for ${remoteInstanceLabel}`
    : undefined;

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
      <span className="thread-chip-group">
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
        {link.instanceId && remoteViewerTooltip ? (
          <span
            aria-label={`Open remote viewer for ${remoteInstanceLabel}`}
            className="thread-chip__popout"
            role="button"
            tabIndex={0}
            onBlur={popoutTooltipController.hide}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              popoutTooltipController.hide();
              event.currentTarget.blur();
              threadLinks?.openRemoteViewer(link);
            }}
            onFocus={(event) =>
              popoutTooltipController.show(event.currentTarget, remoteViewerTooltip)
            }
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              popoutTooltipController.hide();
              event.currentTarget.blur();
              threadLinks?.openRemoteViewer(link);
            }}
            onMouseEnter={(event) =>
              popoutTooltipController.show(event.currentTarget, remoteViewerTooltip)
            }
            onMouseLeave={popoutTooltipController.hide}
          >
            <PopoutIcon size={11} aria-hidden="true" />
          </span>
        ) : null}
      </span>
      {tooltipController.tooltipNode}
      {popoutTooltipController.tooltipNode}
      {contextMenuPosition && contextMenuInvokerRef.current ? (
        <ChipContextMenu
          className={props.contextMenuClassName}
          items={threadCopyTargets(link, label)}
          position={contextMenuPosition}
          returnFocusTo={contextMenuInvokerRef.current}
          onClose={() => setContextMenuPosition(undefined)}
        />
      ) : null}
    </>
  );
}
