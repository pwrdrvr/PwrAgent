import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_FORGE_AUTOMATION, type ProjectForgeAutomation } from "@pwragent/shared";
import {
  canEditProjectForgeAutomation,
  describeProjectAutoFixOverride,
  findThreadProjectDirectory,
  withProjectForgePause,
} from "../forge-automation-view";

const PAUSED: ProjectForgeAutomation = { ...DEFAULT_PROJECT_FORGE_AUTOMATION, paused: true, pausedAt: 1_000 };

describe("canEditProjectForgeAutomation", () => {
  it("offers the setting only on a configured local directory project", () => {
    expect(canEditProjectForgeAutomation({ kind: "directory" }, false)).toBe(true);
    expect(canEditProjectForgeAutomation({ kind: "directory", localAvailability: "unconfigured" }, false)).toBe(false);
    expect(canEditProjectForgeAutomation({ kind: "workspace" }, false)).toBe(false);
    expect(canEditProjectForgeAutomation({ kind: "unlinked" }, false)).toBe(false);
    expect(canEditProjectForgeAutomation({ kind: "directory" }, true)).toBe(false);
  });
});

describe("withProjectForgePause", () => {
  it("keeps the per-kind switches and while-paused choices", () => {
    const narrowed: ProjectForgeAutomation = {
      ...DEFAULT_PROJECT_FORGE_AUTOMATION,
      autoFixMergeConflicts: false,
      refuseThreadMessages: false,
      wakeupPolicy: "discard",
    };
    expect(withProjectForgePause(narrowed, true, 5_000)).toEqual({ ...narrowed, paused: true, pausedAt: 5_000 });
    expect(withProjectForgePause({ ...narrowed, paused: true, pausedAt: 5_000 }, false, 9_000)).toEqual(narrowed);
  });

  it("pauses a project with no stored setting from the defaults", () => {
    expect(withProjectForgePause(undefined, true, 5_000)).toEqual({ ...DEFAULT_PROJECT_FORGE_AUTOMATION, paused: true, pausedAt: 5_000 });
  });
});

describe("describeProjectAutoFixOverride", () => {
  it("mutes the control while the project is paused", () => {
    expect(describeProjectAutoFixOverride(PAUSED, "openclaw")).toEqual({
      muted: true,
      tooltip: "Auto-fix is paused for openclaw. This thread's own setting returns on resume. Change it from the project menu: Forge Automation…",
    });
  });

  it("names the one kind a project skips without muting", () => {
    expect(describeProjectAutoFixOverride({ ...DEFAULT_PROJECT_FORGE_AUTOMATION, autoFixMergeConflicts: false }, "openclaw"))
      .toEqual({ muted: false, tooltip: "Auto-fix skips merge conflicts in openclaw." });
    expect(describeProjectAutoFixOverride({ ...DEFAULT_PROJECT_FORGE_AUTOMATION, autoFixCiFailures: false }, "openclaw"))
      .toEqual({ muted: false, tooltip: "Auto-fix skips failing CI in openclaw." });
  });

  it("mutes the control when both kinds are off", () => {
    expect(describeProjectAutoFixOverride({
      ...DEFAULT_PROJECT_FORGE_AUTOMATION,
      autoFixMergeConflicts: false,
      autoFixCiFailures: false,
    }, "openclaw")?.muted).toBe(true);
  });

  it("leaves the control alone when the project narrows nothing Auto-fix does", () => {
    expect(describeProjectAutoFixOverride(undefined, "openclaw")).toBeUndefined();
    expect(describeProjectAutoFixOverride({ ...DEFAULT_PROJECT_FORGE_AUTOMATION, prWatches: false }, "openclaw")).toBeUndefined();
  });
});

describe("findThreadProjectDirectory", () => {
  it("files a worktree thread under its repository's project, as the sidebar does", () => {
    const project = {
      key: "directory:/Users/fixture-user/openclaw",
      kind: "directory" as const,
      label: "openclaw",
      path: "/Users/fixture-user/openclaw",
    };
    expect(findThreadProjectDirectory({
      linkedDirectories: [{
        id: "worktree-1",
        kind: "worktree",
        label: "openclaw",
        path: "/Users/fixture-user/openclaw/.worktrees/fix-ci",
      }],
    }, [project])).toBe(project);
    expect(findThreadProjectDirectory({ linkedDirectories: [] }, [project])).toBeUndefined();
  });

  it("folds a tool-managed worktree onto the project row with its name", () => {
    const project = {
      key: "directory:/Users/fixture-user/openclaw",
      kind: "directory" as const,
      label: "openclaw",
      path: "/Users/fixture-user/openclaw",
    };
    const other = {
      key: "directory:/Users/fixture-user/notes",
      kind: "directory" as const,
      label: "notes",
      path: "/Users/fixture-user/notes",
    };
    for (const path of [
      "/Users/fixture-user/.pwragent/worktrees/mabc123/openclaw",
      "/Users/fixture-user/.codex/worktrees/9f3e/openclaw",
    ]) {
      expect(findThreadProjectDirectory({
        linkedDirectories: [{ id: path, kind: "local", label: "openclaw", path }],
      }, [other, project])).toBe(project);
    }
  });

  it("prefers a stable project over a worktree folder listed first", () => {
    const project = {
      key: "directory:/Users/fixture-user/openclaw",
      kind: "directory" as const,
      label: "openclaw",
      path: "/Users/fixture-user/openclaw",
    };
    const worktreePath = "/Users/fixture-user/.pwragent/worktrees/mabc123/scratch";
    const worktreeRow = {
      key: `directory:${worktreePath}`,
      kind: "directory" as const,
      label: "scratch",
      path: worktreePath,
    };
    expect(findThreadProjectDirectory({
      linkedDirectories: [
        { id: "worktree", kind: "local", label: "scratch", path: worktreePath },
        { id: "repo", kind: "local", label: "openclaw", path: "/Users/fixture-user/openclaw" },
      ],
    }, [worktreeRow, project])).toBe(project);
  });
});
