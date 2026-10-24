import type {
  DesktopPwrAgentProfileSummary,
} from "@pwragent/shared";
import type { MenuItemConstructorOptions } from "electron";

/**
 * The Dock's Open Profile submenu follows the Profiles menu: `profiles`
 * arrives in the operator's order from Settings → Profiles, and a profile
 * switched out of the Profiles menu takes no row here either.
 */
export function buildDockProfileMenuTemplate(
  profiles: DesktopPwrAgentProfileSummary[],
  openProfile: (profile: string) => void | Promise<void>,
): MenuItemConstructorOptions[] {
  if (profiles.length === 0) {
    return [
      {
        label: "Open Profile",
        submenu: [
          {
            label: "No Profiles Found",
            enabled: false,
          },
        ],
      },
    ];
  }

  const shownProfiles = profiles.filter((profile) => profile.showInMenu);
  // Every profile switched off is a choice, not an empty state: say nothing
  // rather than "No Profiles Found" over profiles that exist.
  if (shownProfiles.length === 0) {
    return [];
  }

  return [
    {
      label: "Open Profile",
      submenu: shownProfiles.map((profile) => ({
        label: profile.displayName || profile.name,
        type: "checkbox",
        checked: profile.active,
        click: () => {
          void openProfile(profile.name);
        },
      })),
    },
  ];
}
