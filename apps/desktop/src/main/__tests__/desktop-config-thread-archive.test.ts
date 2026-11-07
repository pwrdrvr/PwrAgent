import { describe, expect, it } from "vitest";
import { normalizeThreadArchivePolicy } from "@pwragent/shared";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

describe("archive policy configuration", () => {
  it("defaults to 20 eligible threads per project, seven-day age mode, and no permanent deletion", () => {
    expect(normalizeThreadArchivePolicy()).toEqual({ mode: "count", keepPerProject: 20, inactivityDays: 7, retentionDays: 0 });
  });
  it("round trips both modes while preserving existing comments and worktree storage", () => {
    const original = '# Keep this comment\n[worktrees]\nstorage = "user-home"\n';
    const policy = { mode: "age" as const, inactivityDays: 7, keepPerProject: 20, retentionDays: 30 };
    const saved = applyTomlEdits(original, desktopSettingsPatchToEdits({ worktrees: { archive: policy } }, parseTomlTables(original, "test.toml")));
    expect(saved).toContain("# Keep this comment");
    expect(saved).toContain('storage = "user-home"');
    expect(normalizeThreadArchivePolicy(parseDesktopSettingsToml(saved, "test.toml").worktrees?.archive)).toEqual(policy);
    // A new archive table never gets the retired switch.
    expect(saved).not.toMatch(/^enabled\s*=/m);
  });
  it("reads the retired automatic-archive switch as legacy data only", () => {
    const read = (toml: string) => parseDesktopSettingsToml(toml, "test.toml").worktrees?.archive;
    expect(read("[worktrees.archive]\nenabled = true\n")?.legacyEnabled).toBe(true);
    expect(read("[worktrees.archive]\nenabled = false\n")?.legacyEnabled).toBe(false);
    expect(read('[worktrees.archive]\nmode = "age"\n')?.legacyEnabled).toBeUndefined();
    expect(normalizeThreadArchivePolicy(read("[worktrees.archive]\nenabled = false\n"))).not.toHaveProperty("enabled");
  });
  it("keeps the retired switch and its value on save, marked once for older clients", () => {
    for (const value of ["true", "false"]) {
      const original = `[worktrees.archive]\nenabled = ${value}\nmode = "count"\n`;
      const save = (source: string, patch: { mode: "age" | "count" }) =>
        applyTomlEdits(source, desktopSettingsPatchToEdits({ worktrees: { archive: patch } }, parseTomlTables(source, "test.toml")));
      const once = save(original, { mode: "age" });
      const twice = save(once, { mode: "count" });
      expect(twice).toContain(`enabled = ${value}`);
      const markers = twice.match(/^# pwragent-legacy-settings key=enabled shape=boolean used_through=1\.3\.13 kept_for_older_clients$/gm);
      expect(markers).toHaveLength(1);
      expect(twice.indexOf("# pwragent-legacy-settings key=enabled")).toBeLessThan(twice.indexOf(`enabled = ${value}`));
      expect(parseDesktopSettingsToml(twice, "test.toml").worktrees?.archive).toMatchObject({ legacyEnabled: value === "true", mode: "count" });
    }
  });
  it("rejects malformed numbers and bounds settings instead of enabling invalid expiry", () => {
    expect(normalizeThreadArchivePolicy({ inactivityDays: NaN, keepPerProject: -1, retentionDays: Infinity })).toMatchObject({ inactivityDays: 7, keepPerProject: 1, retentionDays: 0 });
    expect(normalizeThreadArchivePolicy(parseDesktopSettingsToml('[worktrees.archive]\nretention_days = "forever"\n', "test.toml").worktrees?.archive).retentionDays).toBe(0);
  });
});
