import { useEffect, useState } from "react";
import type { ReviewRunMode } from "@pwragent/shared";
import { SubAgentsIcon } from "../../icons";
import type { ReviewRunModeDecision } from "../../lib/review-run-mode";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { ComposerDropdown } from "./ComposerDropdown";

/**
 * The names alone do not separate these: two of the three differ only by the
 * vendor word, and none of them says whether the review shares this thread's
 * context or lands in a child. Every other picker in the review panel — all
 * four target cards above this row — explains itself, so this one does too.
 */
const REVIEW_LOCATION_OPTIONS: Array<{
  description: string;
  label: string;
  value: ReviewRunMode;
}> = [
  {
    label: "Codex Inline",
    value: "codex-inline",
    description: "An ordinary turn in this thread, with its context and model.",
  },
  {
    label: "Codex Sub Agent",
    value: "codex-sub-agent",
    description: "Codex's own reviewer, posted into this thread.",
  },
  {
    label: "PwrAgent Sub Agent",
    value: "pwragent-sub-agent",
    description: "A separate child thread. Works across providers.",
  },
];

function optionState(
  decision: ReviewRunModeDecision,
  value: ReviewRunMode,
): { disabled: boolean; reason?: string } {
  if (value === "pwragent-sub-agent") {
    return decision.subagentDisabled
      ? {
          disabled: true,
          reason: "This reviewer cannot run a managed review.",
        }
      : { disabled: false };
  }
  const disabled =
    value === "codex-inline" ? decision.inlineDisabled : decision.nativeDisabled;
  return disabled
    ? { disabled: true, reason: "Not available on this thread's owner." }
    : { disabled: false };
}

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
  const resolvedLabel = REVIEW_LOCATION_OPTIONS.find(
    (option) => option.value === props.decision.runMode,
  )?.label;
  // An owner that cannot take an explicit choice still resolves to a mode, and
  // that mode is what is about to run. Naming only the policy would leave the
  // one state the operator cannot change as the one they are told least about.
  const selectedLabel = props.decision.explicitRunModeSupported
    ? resolvedLabel
    : resolvedLabel ? `Owner default · ${resolvedLabel}` : "Owner default";
  const accessibleLabel = props.decision.helpText
    ? `Review run mode: ${selectedLabel}. ${props.decision.helpText}`
    : `Review run mode: ${selectedLabel}`;

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
        ariaLabel="Review run mode"
        disabled={props.decision.controlDisabled}
        icon={SubAgentsIcon}
        onChange={(value) => props.onChange(value as ReviewRunMode)}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) hideTooltip();
        }}
        options={REVIEW_LOCATION_OPTIONS.map((option) => {
          const state = optionState(props.decision, option.value);
          return {
            // ComposerDropdown draws its trigger from the selected option's
            // label, so the "Owner default" prefix has to live here rather
            // than on `selectedLabel` — which serves the accessible name only.
            label:
              option.value === props.decision.runMode
                ? selectedLabel ?? option.label
                : option.label,
            value: option.value,
            // An unavailable mode cannot be picked, so why it is off displaces
            // what it would have done.
            description: state.reason ?? option.description,
            disabled: state.disabled,
          };
        })}
        value={props.decision.runMode}
      />
      {tooltipNode}
    </div>
  );
}
