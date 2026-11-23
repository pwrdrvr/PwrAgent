export type CodexSkillProfile = {
  id: string;
  name: string;
  hiddenSkills: string[];
};

export type CodexThreadSkillProfile = {
  profileId: string;
  profileName: string;
  hiddenSkills: string[];
};

export const CODEX_SKILL_PROFILE_NAME_LIMIT = 40;

export function codexSkillProfileNameError(
  name: string,
  profiles: readonly CodexSkillProfile[],
  id: string,
): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Name the profile.";
  if (trimmed.length > CODEX_SKILL_PROFILE_NAME_LIMIT) {
    return `Use at most ${CODEX_SKILL_PROFILE_NAME_LIMIT} characters.`;
  }
  if (profiles.some((profile) => profile.id !== id && profile.name.toLowerCase() === trimmed.toLowerCase())) {
    return `A profile named ${trimmed} already exists.`;
  }
  return undefined;
}

export function snapshotCodexSkillProfile(
  profile: CodexSkillProfile,
): CodexThreadSkillProfile {
  return {
    profileId: profile.id,
    profileName: profile.name,
    hiddenSkills: [...profile.hiddenSkills],
  };
}
