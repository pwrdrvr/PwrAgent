import { describe, expect, it } from "vitest";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

function save(original: string, baseDirectory: string | null): string {
  return applyTomlEdits(
    original,
    desktopSettingsPatchToEdits({ worktrees: { baseDirectory } }, parseTomlTables(original, "test.toml")),
  );
}

describe("worktree folder configuration", () => {
  it("writes base_directory beside storage and removes it to return to the home folder", () => {
    const original = '# Keep this comment\n[worktrees]\nstorage = "user-home"\n';
    const saved = save(original, "/Volumes/Dev");
    expect(saved).toContain("# Keep this comment");
    expect(saved).toMatch(/\[worktrees\][\s\S]*storage = "user-home"[\s\S]*base_directory = "\/Volumes\/Dev"/);
    expect(parseDesktopSettingsToml(saved, "test.toml").worktrees).toMatchObject({
      storage: "user-home",
      baseDirectory: "/Volumes/Dev",
    });

    const cleared = save(saved, null);
    expect(cleared).not.toContain("base_directory");
    expect(cleared).toContain('storage = "user-home"');
    expect(parseDesktopSettingsToml(cleared, "test.toml").worktrees?.baseDirectory).toBeUndefined();
  });

  it("writes and reads the Codex opt-in", () => {
    const saved = applyTomlEdits(
      "[worktrees]\n",
      desktopSettingsPatchToEdits({ worktrees: { baseDirectoryIncludesCodex: true } }, parseTomlTables("[worktrees]\n", "test.toml")),
    );
    expect(saved).toContain("base_directory_includes_codex = true");
    expect(parseDesktopSettingsToml(saved, "test.toml").worktrees?.baseDirectoryIncludesCodex).toBe(true);
  });

  it("clears the Codex opt-in with the folder, so a later folder asks again", () => {
    const original = '[worktrees]\nbase_directory = "/Volumes/Dev"\nbase_directory_includes_codex = true\n';
    const cleared = save(original, null);
    expect(cleared).not.toContain("base_directory");
    expect(parseDesktopSettingsToml(cleared, "test.toml").worktrees?.baseDirectoryIncludesCodex).toBeUndefined();
  });

  it("ignores a relative or non-string folder", () => {
    expect(parseDesktopSettingsToml('[worktrees]\nbase_directory = "Dev"\n', "test.toml").worktrees?.baseDirectory)
      .toBeUndefined();
    expect(parseDesktopSettingsToml("[worktrees]\nbase_directory = 7\n", "test.toml").worktrees?.baseDirectory)
      .toBeUndefined();
  });
});
