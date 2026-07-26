import type { KeyboardEvent, MouseEvent } from "react";
import { ThreadIcon } from "../../icons";
import { useLiveThreadLink } from "../../lib/thread-links";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import type { ResolvedThreadLink } from "../../lib/thread-links";

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
        className="chip thread-chip"
        data-thread-chip=""
        role="button"
        tabIndex={0}
        onBlur={tooltipController.hide}
        onClick={handleActivate}
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
    </>
  );
}
