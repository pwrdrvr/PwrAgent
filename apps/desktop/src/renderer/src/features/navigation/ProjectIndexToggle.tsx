import type { ReactElement } from "react";
import { tooltipHandlers, useViewportTooltip } from "../../lib/useViewportTooltip";

/**
 * Shows and hides the sidebar's project index. It sits beside the lens
 * switch rather than inside it: it is a layout choice, not a lens.
 *
 * The preference is the operator's even when the index cannot draw (one
 * project), so the button stays live and its tooltip says why the column is
 * missing.
 */
export function ProjectIndexToggle(props: {
  hidden: boolean;
  /** Why the index is on but not drawn, if it is. */
  unavailableReason?: string;
  onToggle: () => void;
}): ReactElement {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const label = props.hidden ? "Show project index" : "Hide project index";
  const tooltipText = !props.hidden && props.unavailableReason
    ? `${label} · ${props.unavailableReason}`
    : label;
  return (
    <>
      <button
        type="button"
        className={`sidebar__project-index-toggle${props.hidden ? "" : " is-on"}`}
        aria-label={label}
        aria-pressed={!props.hidden}
        onClick={() => {
          tooltip.hide();
          props.onToggle();
        }}
        {...tooltipHandlers(tooltip, tooltipText)}
      >
        <ProjectIndexGlyph />
      </button>
      {tooltip.tooltipNode}
    </>
  );
}

/** A panel with a column of name lines on its left. */
function ProjectIndexGlyph(): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="2" strokeWidth="1.4" />
      <path d="M6.5 3v10" strokeWidth="1.4" />
      <path d="M3.8 5.5h1M3.8 8h1M3.8 10.5h1" strokeWidth="1.3" />
    </svg>
  );
}
