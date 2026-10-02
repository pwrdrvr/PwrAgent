import { describe, expect, it } from "vitest";
import { normalizeThreadArchivePolicy } from "@pwragent/shared";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

describe("archive policy configuration", () => {
  it("defaults to 20 eligible threads per project, seven-day age mode, and no permanent deletion", () => {
    expect(normalizeThreadArchivePolicy()).toEqual({ enabled: true, mode: "count", keepPerProject: 20, inactivityDays: 7, retentionDays: 0 });
  });
  it("round trips both modes while preserving existing comments and worktree storage", () => {
    const original = '# Keep this comment\n[worktrees]\nstorage = "user-home"\n';
    const policy = { enabled: true, mode: "age" as const, inactivityDays: 7, keepPerProject: 20, retentionDays: 30 };
    const saved = applyTomlEdits(original, desktopSettingsPatchToEdits({ worktrees: { archive: policy } }, parseTomlTables(original, "test.toml")));
    expect(saved).toContain("# Keep this comment");
    expect(saved).toContain('storage = "user-home"');
    expect(normalizeThreadArchivePolicy(parseDesktopSettingsToml(saved, "test.toml").worktrees?.archive)).toEqual(policy);
  });
  it("rejects malformed numbers and bounds settings instead of enabling invalid expiry", () => {
    expect(normalizeThreadArchivePolicy({ inactivityDays: NaN, keepPerProject: -1, retentionDays: Infinity })).toMatchObject({ inactivityDays: 7, keepPerProject: 1, retentionDays: 0 });
    expect(normalizeThreadArchivePolicy(parseDesktopSettingsToml('[worktrees.archive]\nretention_days = "forever"\n', "test.toml").worktrees?.archive).retentionDays).toBe(0);
  });
});
