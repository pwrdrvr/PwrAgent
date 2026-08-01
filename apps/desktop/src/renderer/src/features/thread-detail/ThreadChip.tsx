import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { buildThreadUrl } from "@pwragent/shared";
import { ThreadIcon } from "../../icons";
import { useLiveThreadLink } from "../../lib/thread-links";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import {
  CopyContextMenu,
  type CopyContextMenuPosition,
  type CopyContextMenuTarget,
} from "../chrome/CopyContextMenu";

type ThreadChipProps = {
  /**
   * Link text the author wrote, used only when the resolved thread has no
   * title. The chip prefers the thread's live title so a renamed thread does
   * not keep showing whatever it was called when the link was written.
   */
  fallbackLabel?: string;
  link: ResolvedThreadLink;
  onOpen: (link: ResolvedThreadLink) => void;
};

export function ThreadChip(props: ThreadChipProps) {
  const link = useLiveThreadLink(props.link);
  const [contextMenuPosition, setContextMenuPosition] =
    useState<CopyContextMenuPosition>();
  const tooltipController = useViewportTooltip({ className: "viewport-tooltip" });

  const label = link.title.trim() || props.fallbackLabel?.trim() || link.threadId;
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
        <span className="thread-chip__label">{label}</span>
      </span>
      {tooltipController.tooltipNode}
      {contextMenuPosition ? (
        <CopyContextMenu
          position={contextMenuPosition}
          targets={threadCopyTargets(link, label)}
          onClose={() => setContextMenuPosition(undefined)}
        />
      ) : null}
    </>
  );
}

export function threadCopyTargets(
  link: ResolvedThreadLink,
  label: string,
): CopyContextMenuTarget[] {
  const targets: CopyContextMenuTarget[] = [
    {
      label: "Copy Thread Link",
      value: buildThreadUrl({
        backend: link.backend,
        threadId: link.threadId,
      }),
    },
    {
      label: "Copy Thread ID",
      value: link.threadId,
      separated: true,
    },
    {
      label: "Copy Thread Name",
      value: label,
    },
  ];

  if (link.gitBranch) {
    targets.push({
      label: "Copy Branch Name",
      value: link.gitBranch,
    });
  }

  return targets;
}
