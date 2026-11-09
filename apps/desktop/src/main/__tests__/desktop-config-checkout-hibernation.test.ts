import { describe, expect, it } from "vitest";
import { normalizeCheckoutHibernationPolicy } from "@pwragent/shared";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

describe("checkout hibernation configuration", () => {
  it("writes [worktrees.hibernate] beside the archive table, preserving comments and other keys", () => {
    const original = '# Keep this comment\n[worktrees]\nstorage = "user-home"\n\n[worktrees.archive]\nmode = "age"\ninactivity_days = 30\n';
    const policy = { enabled: true, idleDays: 10, maxSnapshotMb: 25, removeRebuildableOutput: false, restoreOn: "open" as const };
    const saved = applyTomlEdits(original, desktopSettingsPatchToEdits({ worktrees: { hibernate: policy } }, parseTomlTables(original, "test.toml")));
    expect(saved).toContain("# Keep this comment");
    expect(saved).toContain('storage = "user-home"');
    expect(saved).toContain("inactivity_days = 30");
    expect(saved).toMatch(/\[worktrees\.hibernate\][\s\S]*idle_days = 10[\s\S]*max_snapshot_mb = 25[\s\S]*remove_rebuildable_output = false[\s\S]*restore_on = "open"/);
    const parsed = parseDesktopSettingsToml(saved, "test.toml").worktrees;
    expect(normalizeCheckoutHibernationPolicy(parsed?.hibernate)).toEqual({ ...policy, removeRebuildableOutput: true });
  });

  it("is on when the table is absent, and ignores values it cannot read", () => {
    const absent = parseDesktopSettingsToml('[worktrees]\nstorage = "in-repo"\n', "test.toml").worktrees?.hibernate;
    expect(absent).toBeUndefined();
    expect(normalizeCheckoutHibernationPolicy(absent).enabled).toBe(true);
    const parsed = parseDesktopSettingsToml('[worktrees.hibernate]\nenabled = "yes"\nrestore_on = "later"\nmax_snapshot_mb = "big"\n', "test.toml");
    expect(normalizeCheckoutHibernationPolicy(parsed.worktrees?.hibernate)).toEqual({
      enabled: true, idleDays: 7, maxSnapshotMb: 100, removeRebuildableOutput: true, restoreOn: "send",
    });
  });

  it("stays off for a profile that turned it off", () => {
    const parsed = parseDesktopSettingsToml("[worktrees.hibernate]\nenabled = false\n", "test.toml");
    expect(normalizeCheckoutHibernationPolicy(parsed.worktrees?.hibernate).enabled).toBe(false);
  });
});
