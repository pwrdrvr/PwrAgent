import type {
  DesktopPwrAgentProfileSummary,
} from "@pwragent/shared";
import type { MenuItemConstructorOptions } from "electron";

export function buildDockProfileMenuTemplate(
  profiles: DesktopPwrAgentProfileSummary[],
  openProfile: (profile: string) => void | Promise<void>,
): MenuItemConstructorOptions[] {
  const profileItems: MenuItemConstructorOptions[] = profiles.length > 0
    ? profiles.map((profile) => ({
        label: profile.displayName || profile.name,
        type: "checkbox",
        checked: profile.active,
        click: () => {
          void openProfile(profile.name);
        },
      }))
    : [
        {
          label: "No Profiles Found",
          enabled: false,
        },
      ];

  return [
    {
      label: "Open Profile",
      submenu: profileItems,
    },
  ];
}
