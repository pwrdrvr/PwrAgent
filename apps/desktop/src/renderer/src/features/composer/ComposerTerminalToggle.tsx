import { TerminalIcon } from "../../icons/TerminalIcon";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

export type ComposerTerminalToggleProps = {
  open: boolean;
  /** A shell is alive even when the panel is collapsed. */
  running?: boolean;
  disabledReason?: string;
  onToggle: () => void;
};

export function ComposerTerminalToggle(props: ComposerTerminalToggleProps) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const collapsedRunning = Boolean(props.running) && !props.open;
  const label = props.disabledReason
    ?? (props.open
      ? "Hide integrated terminal"
      : collapsedRunning
        ? "Show running integrated terminal"
        : "Open integrated terminal");

  return (
    <>
      <button
        type="button"
        className={`composer__toggle composer__terminal-toggle${
          props.open ? " is-active" : ""
        }${collapsedRunning ? " is-running" : ""}${
          props.disabledReason ? " is-disabled" : ""
        }`}
        aria-label={label}
        aria-pressed={props.open}
        // Keep unavailable remote terminals focusable so the tooltip explains why.
        aria-disabled={props.disabledReason ? true : undefined}
        onClick={() => {
          tooltip.hide();
          if (!props.disabledReason) props.onToggle();
        }}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, label)}
        onMouseLeave={tooltip.hide}
        onFocus={(event) => tooltip.show(event.currentTarget, label)}
        onBlur={tooltip.hide}
      >
        <TerminalIcon size={14} />
      </button>
      {tooltip.tooltipNode}
    </>
  );
}
