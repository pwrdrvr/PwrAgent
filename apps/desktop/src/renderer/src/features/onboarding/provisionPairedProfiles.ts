import type { DesktopApi } from "../../lib/desktop-api";

/**
 * Profile-name guard matching the validation rule the main-process
 * `createDesktopPwrAgentProfile` and `setDesktopPwrAgentProfileCodexProfile`
 * IPC handlers enforce: lowercase letters, digits, underscores, hyphens —
 * 1 to 31 characters, must start with a letter or digit.
 */
export function isValidProfileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,30}$/.test(name);
}

export type PairedProfileApi = Pick<
  DesktopApi,
  | "createPwrAgentProfile"
  | "createCodexAuthProfile"
  | "setPwrAgentProfileCodexProfile"
>;

/**
 * For each name in the array, provision a paired PwrAgent + Codex auth
 * profile of the same name and wire the pairing. Invalid names are
 * silently skipped. Individual failures are logged and do NOT abort the
 * rest of the batch — the wizard's Finish path needs to land regardless
 * of one bad provisioning step. (The Settings → Profiles surface owns
 * recovery for partial provisioning.)
 *
 * Returns the list of names that successfully completed all three IPCs
 * for callers that want to surface "we created N of M" feedback.
 */
export async function provisionPairedProfiles(
  api: PairedProfileApi | undefined,
  names: readonly string[],
): Promise<string[]> {
  if (
    !api?.createPwrAgentProfile ||
    !api.createCodexAuthProfile ||
    !api.setPwrAgentProfileCodexProfile
  ) {
    return [];
  }
  const created: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!isValidProfileName(name)) continue;
    try {
      await api.createPwrAgentProfile({
        profile: name,
        // The operator went through the wizard to create this profile;
        // don't re-fire the wizard the moment they switch into it.
        // The flag is honored by the main-process handler in
        // `apps/desktop/src/main/ipc/profiles.ts`.
        seedOnboardingCompleted: true,
      });
      await api.createCodexAuthProfile({ profile: name });
      await api.setPwrAgentProfileCodexProfile({
        profile: name,
        codexProfile: name,
      });
      created.push(name);
    } catch (caught) {
      // eslint-disable-next-line no-console
      console.warn(
        `Onboarding: failed to provision paired profile "${name}"`,
        caught,
      );
    }
  }
  return created;
}
