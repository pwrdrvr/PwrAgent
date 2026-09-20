import { useEffect, useState } from "react";
import type { ReviewRunMode } from "@pwragent/shared";
import type { ReviewRunModeDecision } from "../../lib/review-run-mode";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { ComposerDropdown } from "./ComposerDropdown";

const REVIEW_LOCATION_OPTIONS: Array<{
  label: string;
  value: ReviewRunMode;
}> = [
  { label: "Codex Inline", value: "codex-inline" },
  { label: "Codex Sub Agent", value: "codex-sub-agent" },
  { label: "PwrAgent Sub Agent", value: "pwragent-sub-agent" },
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
  const selectedLabel = props.decision.explicitRunModeSupported
    ? REVIEW_LOCATION_OPTIONS.find((option) => option.value === props.decision.runMode)?.label
    : "Owner default";
  const accessibleLabel = props.decision.helpText
    ? `Review mode: ${selectedLabel}. ${props.decision.helpText}`
    : `Review mode: ${selectedLabel}`;

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
        ariaLabel="Review mode"
        disabled={props.decision.controlDisabled}
        onChange={(value) => props.onChange(value as ReviewRunMode)}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) hideTooltip();
        }}
        options={REVIEW_LOCATION_OPTIONS.map((option) => ({
          ...option,
          label: !props.decision.explicitRunModeSupported && option.value === props.decision.runMode
            ? "Owner default" : option.label,
          disabled: option.value === "pwragent-sub-agent"
            ? props.decision.subagentDisabled
            : option.value === "codex-inline"
              ? props.decision.inlineDisabled : props.decision.nativeDisabled,
        }))}
        value={props.decision.runMode}
      />
      {tooltipNode}
    </div>
  );
}
