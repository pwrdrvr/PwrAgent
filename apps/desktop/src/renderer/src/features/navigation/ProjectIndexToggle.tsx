import type { ReactElement } from "react";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

/**
 * Shows and hides the sidebar's project index. It sits beside the lens
 * switch rather than inside it: it is a layout choice, not a lens.
 *
 * The preference is the operator's even when the index cannot draw (one
 * project, or a sidebar too narrow for it), so the button stays live and its
 * tooltip says why the column is missing.
 *
 * The name stays "Project index" and `aria-pressed` carries the state. A
 * name that flipped between Show and Hide would contradict the pressed
 * state ("Hide project index, pressed").
 */
export function ProjectIndexToggle(props: {
  hidden: boolean;
  /** Why the index is on but not drawn, if it is. Read when the tooltip
   *  opens: the narrow-sidebar case is decided by CSS, not by React state. */
  unavailableReason?: () => string | undefined;
  onToggle: () => void;
}): ReactElement {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const tooltipText = (): string => {
    if (props.hidden) return "Show project index";
    const reason = props.unavailableReason?.();
    return reason ? `Hide project index · ${reason}` : "Hide project index";
  };
  const show = (target: HTMLElement): void => tooltip.show(target, tooltipText());
  return (
    <>
      <button
        type="button"
        className={`sidebar__project-index-toggle${props.hidden ? "" : " is-on"}`}
        aria-label="Project index"
        aria-pressed={!props.hidden}
        onClick={() => {
          tooltip.hide();
          props.onToggle();
        }}
        onMouseEnter={(event) => show(event.currentTarget)}
        onMouseLeave={tooltip.hide}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={tooltip.hide}
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
