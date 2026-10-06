import { describe, expect, it } from "vitest";
import {
  PROFILE_MENU_SHORTCUT_LIMIT,
  profileMenuShortcutDigits,
} from "../profile-menu";

const shown = (name: string) => ({ name, showInMenu: true });
const hidden = (name: string) => ({ name, showInMenu: false });

describe("profileMenuShortcutDigits", () => {
  it("numbers shown profiles in the order given", () => {
    expect([
      ...profileMenuShortcutDigits([shown("work"), shown("default")]),
    ]).toEqual([
      ["work", 1],
      ["default", 2],
    ]);
  });

  it("gives a hidden profile no digit and its number to the next shown one", () => {
    expect([
      ...profileMenuShortcutDigits([
        shown("default"),
        hidden("scratch"),
        shown("work"),
      ]),
    ]).toEqual([
      ["default", 1],
      ["work", 2],
    ]);
  });

  it("stops at nine", () => {
    const profiles = Array.from({ length: 12 }, (_unused, index) =>
      shown(`p${index + 1}`),
    );

    const digits = profileMenuShortcutDigits(profiles);

    expect(PROFILE_MENU_SHORTCUT_LIMIT).toBe(9);
    expect(digits.size).toBe(9);
    expect(digits.get("p9")).toBe(9);
    expect(digits.has("p10")).toBe(false);
  });
});
