import type { ReviewRunMode } from "@pwragent/shared";
import type { ReviewRunModeDecision } from "../../lib/review-run-mode";
import { ComposerDropdown } from "./ComposerDropdown";

const REVIEW_LOCATION_OPTIONS: Array<{
  label: string;
  value: ReviewRunMode;
}> = [
  { label: "This thread", value: "inline" },
  { label: "Separate thread", value: "managed-child" },
];

export function ReviewLocationDropdown(props: {
  decision: ReviewRunModeDecision;
  onChange: (runMode: ReviewRunMode) => void;
}) {
  const selectedLabel = props.decision.runMode === "managed-child"
    ? "Separate thread"
    : props.decision.explicitRunModeSupported
      ? "This thread"
      : "Owner default";
  const accessibleLabel = props.decision.helpText
    ? `Review location: ${selectedLabel}. ${props.decision.helpText}`
    : `Review location: ${selectedLabel}`;

  return (
    <div
      aria-label={accessibleLabel}
      className={`composer__review-location-chip${
        props.decision.helpText ? " tooltip-target" : ""
      }`}
      data-tooltip={props.decision.helpText}
      role="group"
      tabIndex={props.decision.helpText ? 0 : undefined}
    >
      <ComposerDropdown
        ariaLabel="Review location"
        disabled={props.decision.controlDisabled}
        onChange={(value) => props.onChange(value as ReviewRunMode)}
        options={REVIEW_LOCATION_OPTIONS.map((option) => ({
          ...option,
          label:
            option.value === "inline"
            && !props.decision.explicitRunModeSupported
              ? "Owner default"
              : option.label,
          disabled:
            option.value === "managed-child"
            && props.decision.separateThreadDisabled,
        }))}
        value={props.decision.runMode}
      />
    </div>
  );
}
