import type { CodexSkillProfile, CodexThreadSkillProfile } from "@pwragent/shared/contracts/codex-skill-profiles";
import { SkillIcon } from "../../icons";
import { ComposerDropdown, type ComposerDropdownOption } from "./ComposerDropdown";

export type CodexSkillProfileControlProps = {
  profiles?: readonly CodexSkillProfile[];
  selected?: CodexSkillProfile;
  selectionId?: string | null;
  snapshot?: CodexThreadSkillProfile;
  disabled: boolean;
  onChange?: (id: string | null) => void;
  onEdit?: () => void;
};

/** What a thread's fixed skill profile reads as: its chip label and tooltip. */
export function describeCodexSkillProfileSnapshot(
  snapshot: CodexThreadSkillProfile,
  profiles: readonly CodexSkillProfile[] | undefined,
): { label: string; tooltip: string } {
  const { profileId, profileName, hiddenSkills } = snapshot;
  const saved = profiles?.find(({ id }) => id === profileId);
  const deleted = profiles !== undefined && saved === undefined;
  const count = hiddenSkills.length;
  const edited = saved && (saved.name !== profileName
    || saved.hiddenSkills.length !== count
    || hiddenSkills.some((name) => !saved.hiddenSkills.includes(name)));
  const tooltip = deleted
    ? `${profileName} was deleted. This thread still hides the ${count} skills it started with.`
    : edited
      ? `This thread hides the ${count} skills ${profileName} listed when it started. Your later edits apply to new threads.`
      : `${profileName} hides ${count} skills on this thread. It was set when the thread started. Start a new thread to use another profile.`;
  return { label: `${profileName} −${count}${deleted ? " · deleted" : ""}`, tooltip };
}

/**
 * The choices a new thread's skill profile offers, or undefined when there is
 * nothing to choose. The row's dropdown and its folded ⋮ rows share them.
 */
export function codexSkillProfileOptions(
  props: Pick<CodexSkillProfileControlProps, "profiles" | "selected" | "selectionId" | "onChange">,
): { options: ComposerDropdownOption[]; tooltip: string } | undefined {
  if ((!props.profiles?.length && !props.selectionId) || !props.onChange) return undefined;
  const selected = props.selected;
  const missingProfile = !selected && props.selectionId
    ? { value: props.selectionId, label: "Profile unavailable", disabled: true, description: "Choose another profile or Codex skills." }
    : undefined;
  return {
    options: [
      { value: "", label: "Codex skills", description: "Nothing hidden. Uses your Codex settings." },
      ...(missingProfile ? [missingProfile] : []),
      ...(props.profiles ?? []).map(({ id, name, hiddenSkills }) => ({
        value: id,
        label: name,
        selectedLabel: `${name} −${hiddenSkills.length}`,
        description: `Hides ${hiddenSkills.length} skills`,
      })),
    ],
    tooltip: selected
      ? `${selected.name} hides ${selected.hiddenSkills.length} skills on this thread. Other skills keep their Codex settings.`
      : missingProfile?.description ?? "Nothing hidden. Uses your Codex settings.",
  };
}

export function CodexSkillProfileControl(props: CodexSkillProfileControlProps) {
  if (props.snapshot) {
    const { label, tooltip } = describeCodexSkillProfileSnapshot(props.snapshot, props.profiles);
    return (
      <span className="composer__fixed-value tooltip-target" aria-label="Skill profile" data-tooltip={tooltip} tabIndex={0}>
        <SkillIcon size={13} aria-hidden="true" />
        {label}
      </span>
    );
  }
  const choices = codexSkillProfileOptions(props);
  if (!choices) return null;
  return (
    <ComposerDropdown
      ariaLabel="Skill profile"
      compact
      disabled={props.disabled}
      icon={SkillIcon}
      menuAction={props.onEdit ? { label: "Edit skill profiles…", onSelect: props.onEdit } : undefined}
      onChange={(value) => props.onChange?.(value || null)}
      options={choices.options}
      tooltip={choices.tooltip}
      value={props.selectionId ?? ""}
    />
  );
}
