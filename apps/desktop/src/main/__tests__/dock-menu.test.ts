import { describe, expect, it, vi } from "vitest";
import { buildDockProfileMenuTemplate } from "../dock-menu";

describe("Dock profile menu", () => {
  it("lists profiles and opens the selected profile", () => {
    const openProfile = vi.fn();
    const template = buildDockProfileMenuTemplate(
      [
        {
          active: true,
          canDelete: false,
          codexProfile: {
            codexHome: "/tmp/codex-default",
            displayName: "Default",
            exists: true,
            hasAuthFile: true,
            hasConfigFile: true,
            name: "default",
            selected: true,
            source: "default",
          },
          default: true,
          displayName: "Personal",
          name: "personal",
          profileDir: "/tmp/personal",
        },
        {
          active: false,
          canDelete: true,
          codexProfile: {
            codexHome: "/tmp/codex-work",
            displayName: "Work",
            exists: true,
            hasAuthFile: true,
            hasConfigFile: true,
            name: "work",
            selected: true,
            source: "directory",
          },
          default: false,
          name: "work",
          profileDir: "/tmp/work",
        },
      ],
      openProfile,
    );

    expect(template).toHaveLength(1);
    expect(template[0]?.label).toBe("Open Profile");
    expect(template[0]?.submenu).toEqual([
      expect.objectContaining({
        checked: true,
        label: "Personal",
        type: "checkbox",
      }),
      expect.objectContaining({
        checked: false,
        label: "work",
        type: "checkbox",
      }),
    ]);

    const firstItem = Array.isArray(template[0]?.submenu)
      ? template[0].submenu[0]
      : undefined;
    if (!firstItem || typeof firstItem === "string") {
      throw new Error("expected a profile menu item");
    }
    firstItem.click?.({} as never, {} as never, {} as never);
    expect(openProfile).toHaveBeenCalledWith("personal");
  });

  it("keeps the submenu visible when there are no profiles", () => {
    const template = buildDockProfileMenuTemplate([], vi.fn());

    expect(template[0]?.submenu).toEqual([
      {
        enabled: false,
        label: "No Profiles Found",
      },
    ]);
  });
});
