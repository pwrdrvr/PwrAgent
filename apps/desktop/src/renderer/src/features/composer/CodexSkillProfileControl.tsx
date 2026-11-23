import type { CodexSkillProfile, CodexThreadSkillProfile } from "@pwragent/shared/contracts/codex-skill-profiles";
import { SkillIcon } from "../../icons";
import { ComposerDropdown } from "./ComposerDropdown";

export function CodexSkillProfileControl(props: {
  profiles?: readonly CodexSkillProfile[];
  selected?: CodexSkillProfile;
  selectionId?: string | null;
  snapshot?: CodexThreadSkillProfile;
  disabled: boolean;
  onChange?: (id: string | null) => void;
  onEdit?: () => void;
}) {
  if (props.snapshot) {
    const { profileId, profileName, hiddenSkills } = props.snapshot;
    const saved = props.profiles?.find(({ id }) => id === profileId);
    const deleted = props.profiles !== undefined && saved === undefined;
    const count = hiddenSkills.length;
    const edited = saved && (saved.name !== profileName
      || saved.hiddenSkills.length !== count
      || hiddenSkills.some((name) => !saved.hiddenSkills.includes(name)));
    const tooltip = deleted
      ? `${profileName} was deleted. This thread still hides the ${count} skills it started with.`
      : edited
        ? `This thread hides the ${count} skills ${profileName} listed when it started. Your later edits apply to new threads.`
        : `${profileName} hides ${count} skills on this thread. It was set when the thread started. Start a new thread to use another profile.`;
    return (
      <span className="composer__fixed-value tooltip-target" aria-label="Skill profile" data-tooltip={tooltip} tabIndex={0}>
        <SkillIcon size={13} aria-hidden="true" />
        {profileName} −{count}{deleted ? " · deleted" : ""}
      </span>
    );
  }
  if ((!props.profiles?.length && !props.selectionId) || !props.onChange) return null;
  const selected = props.selected;
  const missingProfile = !selected && props.selectionId
    ? { value: props.selectionId, label: "Profile unavailable", disabled: true, description: "Choose another profile or Codex skills." }
    : undefined;
  return (
    <ComposerDropdown
      ariaLabel="Skill profile"
      compact
      disabled={props.disabled}
      icon={SkillIcon}
      menuAction={props.onEdit ? { label: "Edit skill profiles…", onSelect: props.onEdit } : undefined}
      onChange={(value) => props.onChange?.(value || null)}
      options={[
        { value: "", label: "Codex skills", description: "Nothing hidden. Uses your Codex settings." },
        ...(missingProfile ? [missingProfile] : []),
        ...(props.profiles ?? []).map(({ id, name, hiddenSkills }) => ({
          value: id,
          label: name,
          selectedLabel: `${name} −${hiddenSkills.length}`,
          description: `Hides ${hiddenSkills.length} skills`,
        })),
      ]}
      tooltip={selected
        ? `${selected.name} hides ${selected.hiddenSkills.length} skills on this thread. Other skills keep their Codex settings.`
        : missingProfile?.description ?? "Nothing hidden. Uses your Codex settings."}
      value={props.selectionId ?? ""}
    />
  );
}
