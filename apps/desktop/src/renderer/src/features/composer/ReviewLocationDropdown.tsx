import { useEffect, useState } from "react";
import type { ReviewRunMode } from "@pwragent/shared";
import type { ReviewRunModeDecision } from "../../lib/review-run-mode";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { ComposerDropdown } from "./ComposerDropdown";

const REVIEW_LOCATION_OPTIONS: Array<{
  label: string;
  value: ReviewRunMode;
}> = [
  { label: "This thread", value: "inline" },
  { label: "Subagent", value: "managed-child" },
];

export function ReviewLocationDropdown(props: {
  decision: ReviewRunModeDecision;
  onChange: (runMode: ReviewRunMode) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const {
    hide: hideTooltip,
    show: showTooltip,
    tooltipNode,
    update: updateTooltip,
    visible: tooltipVisible,
  } = useViewportTooltip({ className: "viewport-tooltip" });
  const selectedLabel = props.decision.runMode === "managed-child"
    ? "Subagent"
    : props.decision.explicitRunModeSupported
      ? "This thread"
      : "Owner default";
  const accessibleLabel = props.decision.helpText
    ? `Review location: ${selectedLabel}. ${props.decision.helpText}`
    : `Review location: ${selectedLabel}`;

  useEffect(() => {
    if (!props.decision.helpText || menuOpen) {
      hideTooltip();
    } else if (tooltipVisible) {
      updateTooltip(props.decision.helpText);
    }
  }, [
    hideTooltip,
    menuOpen,
    props.decision.helpText,
    tooltipVisible,
    updateTooltip,
  ]);

  const showHelp = (target: HTMLElement): void => {
    if (props.decision.helpText && !menuOpen) {
      showTooltip(target, props.decision.helpText);
    }
  };

  return (
    <div
      aria-label={accessibleLabel}
      className="composer__review-location-chip"
      onBlur={hideTooltip}
      onFocus={(event) => showHelp(event.currentTarget)}
      onMouseEnter={(event) => showHelp(event.currentTarget)}
      onMouseLeave={hideTooltip}
      role="group"
      tabIndex={
        props.decision.helpText && props.decision.controlDisabled
          ? 0
          : undefined
      }
    >
      <ComposerDropdown
        ariaLabel="Review location"
        disabled={props.decision.controlDisabled}
        onChange={(value) => props.onChange(value as ReviewRunMode)}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) hideTooltip();
        }}
        options={REVIEW_LOCATION_OPTIONS.map((option) => ({
          ...option,
          label:
            option.value === "inline"
            && !props.decision.explicitRunModeSupported
              ? "Owner default"
              : option.label,
          disabled:
            option.value === "managed-child"
            && props.decision.subagentDisabled,
        }))}
        value={props.decision.runMode}
      />
      {tooltipNode}
    </div>
  );
}
