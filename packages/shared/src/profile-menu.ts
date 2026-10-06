/**
 * How many profiles get a Profiles-menu shortcut: ⌘1–⌘9 on macOS, Ctrl+1–9
 * elsewhere. A tenth shown profile still gets a menu row, just no digit.
 */
export const PROFILE_MENU_SHORTCUT_LIMIT = 9;

/**
 * The shortcut digit each shown profile takes, keyed by profile name.
 *
 * `profiles` must already be in the operator's order. A profile hidden from
 * the Profiles menu takes no row and no digit, so the next shown profile
 * takes its number. The application menu and the Settings → Profiles rows
 * both read this, so the digit a row advertises is the one the menu binds.
 */
export function profileMenuShortcutDigits(
  profiles: ReadonlyArray<{ name: string; showInMenu: boolean }>,
): Map<string, number> {
  const digits = new Map<string, number>();
  for (const profile of profiles) {
    if (digits.size >= PROFILE_MENU_SHORTCUT_LIMIT) {
      break;
    }
    if (profile.showInMenu) {
      digits.set(profile.name, digits.size + 1);
    }
  }
  return digits;
}
