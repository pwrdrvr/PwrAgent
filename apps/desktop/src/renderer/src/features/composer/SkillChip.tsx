import type { AppServerSkillSummary } from "@pwragent/shared";
import { buildSkillTooltip } from "../../lib/skill-mentions";

type SkillChipProps = {
  label?: string;
  onRemove?: () => void;
  skill: AppServerSkillSummary;
};

export function SkillChip(props: SkillChipProps) {
  const tooltip = buildSkillTooltip(props.skill);

  return (
    <span
      className={`thread-row__chip skill-chip tooltip-target${props.onRemove ? " skill-chip--removable" : ""}`}
      data-tooltip={tooltip || undefined}
      tabIndex={tooltip && !props.onRemove ? 0 : -1}
    >
      <span aria-hidden="true" className="thread-row__chip-icon">
        🧰
      </span>
      <span className="skill-chip__label">{props.label ?? `$${props.skill.name}`}</span>
      {props.onRemove ? (
        <button
          aria-label={`Remove $${props.skill.name}`}
          className="skill-chip__remove"
          type="button"
          onClick={props.onRemove}
        >
          x
        </button>
      ) : null}
    </span>
  );
}
