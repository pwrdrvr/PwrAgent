import type { AppServerSkillSummary } from "@pwragnt/shared";
import { buildSkillTooltip } from "../../lib/skill-mentions";

type SkillChipProps = {
  label?: string;
  skill: AppServerSkillSummary;
};

export function SkillChip(props: SkillChipProps) {
  const tooltip = buildSkillTooltip(props.skill);

  return (
    <span
      className="thread-row__chip skill-chip tooltip-target"
      data-tooltip={tooltip || undefined}
      tabIndex={tooltip ? 0 : -1}
    >
      <span aria-hidden="true" className="thread-row__chip-icon">
        🧰
      </span>
      {props.label ?? `$${props.skill.name}`}
    </span>
  );
}
