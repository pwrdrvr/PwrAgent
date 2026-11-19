import type { ReactElement } from "react";
import type { AutomationSchedulingStatus } from "@pwragent/shared";
import { AutomationsIcon } from "../../icons";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { describeAutomationSchedulingStatus } from "../automations/useAutomationSchedulingStatus";

/**
 * The window-level Automations button. Every placement (sidebar masthead,
 * title bar, thread header) renders this one, so a window whose scheduled
 * automations run in another instance shows them paused in all of them.
 */
export function AutomationsButton(props: {
  active?: boolean;
  /** Placement classes added to `sidebar__icon-button`. */
  className?: string;
  schedulingStatus?: AutomationSchedulingStatus;
  onClick?: () => void;
}): ReactElement {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const paused = describeAutomationSchedulingStatus(props.schedulingStatus);
  const ariaLabel = paused ? `Open automations, ${paused.ariaSuffix}` : "Open automations";
  const tooltipText = paused?.tooltip ?? "Open automations";
  const className = [
    "sidebar__icon-button",
    props.className,
    props.active ? "is-active" : undefined,
    paused ? "is-automations-paused" : undefined,
  ].filter(Boolean).join(" ");
  return (
    <>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-pressed={props.active}
        className={className}
        onBlur={tooltip.hide}
        onClick={() => {
          tooltip.hide();
          props.onClick?.();
        }}
        onFocus={(event) => tooltip.show(event.currentTarget, tooltipText)}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, tooltipText)}
        onMouseLeave={tooltip.hide}
      >
        <AutomationsIcon size={16} strokeWidth={1.5} aria-hidden="true" />
        {paused ? (
          <span aria-hidden="true" className="status-dot status-dot--suspended automations-paused-dot" />
        ) : null}
      </button>
      {tooltip.tooltipNode}
    </>
  );
}
