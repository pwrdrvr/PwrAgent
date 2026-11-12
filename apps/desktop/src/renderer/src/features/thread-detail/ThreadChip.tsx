import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { PopoutIcon, ThreadIcon } from "../../icons";
import {
  threadLinkNamesThisMachine,
  useLiveThreadLink,
  useThreadLinkHoverSource,
  useThreadLinks,
} from "../../lib/thread-links";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import {
  ChipContextMenu,
  type ChipContextMenuPosition,
} from "../chrome/ChipContextMenu";
import { threadCopyTargets } from "../chrome/ThreadChipContextMenu";
import { ThreadInfoCard, useThreadInfo } from "./ThreadInfoCard";

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
  // The hover card is built to the PR card's measurements and shares its rules.
  const tooltipController = useViewportTooltip({ className: "pr-status-card thread-info-card" });
  const popoutTooltipController = useViewportTooltip({
    className: "viewport-tooltip",
  });

  const liveTitle = link.title.trim();
  const fallbackLabel = props.fallbackLabel?.trim();
  const label = link.titleSource === "fallback" && fallbackLabel
    ? fallbackLabel
    : liveTitle || fallbackLabel || link.threadId;
  const threadInfo = useThreadInfo(link);
  const card = <ThreadInfoCard info={threadInfo.info} label={label} link={link} />;
  const latestCardRef = useRef(card);
  // A click focuses the chip on its way to opening the thread; only keyboard
  // focus opens the card, so a click starts no reads.
  const pointerFocusRef = useRef(false);
  latestCardRef.current = card;
  const tooltipVisible = tooltipController.visible;
  const updateTooltip = tooltipController.update;
  // Facts and cost land after the card opens; push them into the open card.
  // `info` changes only when a read settles, so this cannot loop.
  useEffect(() => {
    if (tooltipVisible) updateTooltip(latestCardRef.current);
  }, [threadInfo.info, label, tooltipVisible, updateTooltip]);
  // A window serving a peer keeps this machine's id on its links; the chip
  // itself opens those in the main window, so there is no remote viewer.
  const remoteInstanceLabel = threadLinkNamesThisMachine(link, threadLinks?.localInstanceId)
    ? undefined
    : link.instanceLabel ?? link.instanceId;
  const remoteViewerTooltip = remoteInstanceLabel
    ? `Open this thread in the remote viewer window for ${remoteInstanceLabel}`
    : undefined;

  // While the pointer (or keyboard focus) rests on the link, the sidebar card
  // it points at lights up in the same solid-accent style as a sub-thread
  // composer's source card — the link and its target read as one thing. Only
  // rows already on screen respond; nothing scrolls until the chip is
  // activated. Wired on the group so a remote link's pop-out button counts as
  // the same link: sliding from the chip onto it must not drop the highlight.
  const hoverSource = useThreadLinkHoverSource(link);

  // role="button" span rather than a real <button>: the chip renders inside
  // markdown that may already sit within a clickable surface, and a nested
  // <button> is invalid HTML.
  const handleActivate = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    tooltipController.hide();
    hoverSource.release();
    event.currentTarget.blur();
    props.onOpen(link);
  };

  return (
    <>
      <span
        className="thread-chip-group"
        onBlur={(event) => {
          // Focus moving between the chip and its pop-out stays in the group.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          hoverSource.hideFromFocus();
        }}
        onFocus={(event) => hoverSource.showFromFocus(event.target as Element)}
        onMouseEnter={hoverSource.showFromPointer}
        onMouseLeave={hoverSource.hideFromPointer}
      >
        <span
          aria-label={`Open thread ${label}`}
          aria-describedby={tooltipVisible ? tooltipController.tooltipId : undefined}
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
          onFocus={(event) => {
            if (pointerFocusRef.current) {
              pointerFocusRef.current = false;
              return;
            }
            threadInfo.load();
            tooltipController.show(event.currentTarget, latestCardRef.current);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              handleActivate(event);
            }
          }}
          onMouseEnter={(event) => {
            // Read only once the card opens, never on a pass over the chip.
            tooltipController.showAfterDelay(event.currentTarget, () => {
              threadInfo.load();
              return latestCardRef.current;
            });
          }}
          onMouseLeave={tooltipController.hide}
          onPointerDown={() => { pointerFocusRef.current = true; }}
          onPointerUp={() => { pointerFocusRef.current = false; }}
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
