import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "../contracts/navigation";
import { buildDirectorySummaries } from "../directory-navigation";
import { serializeNavigationSnapshotForHash } from "../navigation-state";
import {
  buildProjectPausedThreadMessageRefusal,
  buildProjectPausedWakeupDiscardNote,
  buildProjectPausedWakeupHoldReason,
  buildProjectPrDependencyNotice,
  buildProjectPrWatchRefusal,
  DEFAULT_PROJECT_FORGE_AUTOMATION,
  isDefaultProjectForgeAutomation,
  isProjectPausedThreadMessageRefusal,
  projectAllowsAutoFixKind,
  projectAllowsForgePolling,
  projectAllowsPrWatches,
  projectRefusesThreadMessages,
  resolveProjectForgeAutomation,
  type ProjectForgeAutomation,
} from "../project-forge-automation";

const paused: ProjectForgeAutomation = {
  ...DEFAULT_PROJECT_FORGE_AUTOMATION,
  paused: true,
  pausedAt: 1_700_000_000_000,
};

describe("resolveProjectForgeAutomation", () => {
  it("fills missing and malformed fields from the defaults", () => {
    expect(resolveProjectForgeAutomation(undefined)).toEqual(DEFAULT_PROJECT_FORGE_AUTOMATION);
    expect(resolveProjectForgeAutomation("paused")).toEqual(DEFAULT_PROJECT_FORGE_AUTOMATION);
    expect(resolveProjectForgeAutomation({
      paused: "yes",
      autoFixMergeConflicts: false,
      wakeupPolicy: "explode",
      prWatches: 0,
    })).toEqual({
      ...DEFAULT_PROJECT_FORGE_AUTOMATION,
      autoFixMergeConflicts: false,
    });
  });

  it("keeps pausedAt only while paused", () => {
    expect(resolveProjectForgeAutomation(paused).pausedAt).toBe(paused.pausedAt);
    expect(resolveProjectForgeAutomation({ ...paused, paused: false })).not.toHaveProperty("pausedAt");
    expect(resolveProjectForgeAutomation({ paused: true, pausedAt: -1 })).not.toHaveProperty("pausedAt");
  });

  it("reads discard and treats every other wake-up policy as hold", () => {
    expect(resolveProjectForgeAutomation({ wakeupPolicy: "discard" }).wakeupPolicy).toBe("discard");
    expect(resolveProjectForgeAutomation({ wakeupPolicy: "later" }).wakeupPolicy).toBe("hold");
  });
});

describe("isDefaultProjectForgeAutomation", () => {
  it("is true only for the defaults", () => {
    expect(isDefaultProjectForgeAutomation({ ...DEFAULT_PROJECT_FORGE_AUTOMATION })).toBe(true);
    expect(isDefaultProjectForgeAutomation(paused)).toBe(false);
    expect(isDefaultProjectForgeAutomation({ ...DEFAULT_PROJECT_FORGE_AUTOMATION, prWatches: false })).toBe(false);
    expect(isDefaultProjectForgeAutomation({ ...DEFAULT_PROJECT_FORGE_AUTOMATION, wakeupPolicy: "discard" })).toBe(false);
  });
});

describe("gate helpers", () => {
  it("allow everything when no project stores a setting", () => {
    expect(projectAllowsAutoFixKind(undefined, "merge-conflict")).toBe(true);
    expect(projectAllowsAutoFixKind(undefined, "ci-failure")).toBe(true);
    expect(projectAllowsPrWatches(undefined)).toBe(true);
    expect(projectAllowsForgePolling(undefined)).toBe(true);
    expect(projectRefusesThreadMessages(undefined)).toBe(false);
  });

  it("narrow one Auto-fix kind at a time while active", () => {
    const noConflicts = { ...DEFAULT_PROJECT_FORGE_AUTOMATION, autoFixMergeConflicts: false };
    expect(projectAllowsAutoFixKind(noConflicts, "merge-conflict")).toBe(false);
    expect(projectAllowsAutoFixKind(noConflicts, "ci-failure")).toBe(true);
    expect(projectAllowsForgePolling(noConflicts)).toBe(true);
    expect(projectRefusesThreadMessages(noConflicts)).toBe(false);
  });

  it("close every forge gate while paused, whatever the switches say", () => {
    expect(projectAllowsAutoFixKind(paused, "merge-conflict")).toBe(false);
    expect(projectAllowsAutoFixKind(paused, "ci-failure")).toBe(false);
    expect(projectAllowsPrWatches(paused)).toBe(false);
    expect(projectAllowsForgePolling(paused)).toBe(false);
  });

  it("refuse thread messages only while paused and asked to", () => {
    expect(projectRefusesThreadMessages(paused)).toBe(true);
    expect(projectRefusesThreadMessages({ ...paused, refuseThreadMessages: false })).toBe(false);
    expect(projectRefusesThreadMessages({ ...DEFAULT_PROJECT_FORGE_AUTOMATION })).toBe(false);
  });

  it("hold PR watches when only the watch switch is off", () => {
    const noWatches = { ...DEFAULT_PROJECT_FORGE_AUTOMATION, prWatches: false };
    expect(projectAllowsPrWatches(noWatches)).toBe(false);
    expect(projectAllowsForgePolling(noWatches)).toBe(true);
  });
});

describe("refusal text", () => {
  it("names the project and how the operator lifts it", () => {
    const message = buildProjectPausedThreadMessageRefusal({ projectLabel: "openclaw", threadTitle: "Fix the build" });
    expect(message).toContain("\"Fix the build\" is in openclaw");
    expect(message).toContain("project menu");
    expect(message).toContain("Do not retry");
    expect(buildProjectPausedThreadMessageRefusal({ projectLabel: "openclaw" })).toMatch(/^That thread is in openclaw/);
  });

  it("recognizes a refusal that crossed federation as text", () => {
    const refusal = buildProjectPausedThreadMessageRefusal({ projectLabel: "openclaw", threadTitle: "Fix the build" });
    expect(isProjectPausedThreadMessageRefusal(`Remote request failed: ${refusal}`)).toBe(true);
    expect(isProjectPausedThreadMessageRefusal("Thread not found: thread-1")).toBe(false);
  });

  it("says a PR dependency is stored but waits", () => {
    expect(buildProjectPrDependencyNotice({ projectLabel: "openclaw", paused: true }))
      .toContain("stored, but this thread is in openclaw, where forge activity is paused");
    expect(buildProjectPrDependencyNotice({ projectLabel: "openclaw", paused: false }))
      .toContain("PR watches are turned off in Forge Automation");
  });

  it("says why no watch was armed", () => {
    expect(buildProjectPrWatchRefusal({ projectLabel: "openclaw", pullRequest: "PR #12", paused: true }))
      .toContain("PR #12 is in openclaw, where forge activity is paused");
    expect(buildProjectPrWatchRefusal({ projectLabel: "openclaw", paused: false }))
      .toContain("PR watches are turned off in Forge Automation");
  });

  it("explains a held or discarded wake-up", () => {
    expect(buildProjectPausedWakeupHoldReason({ projectLabel: "openclaw" })).toContain("openclaw is paused");
    expect(buildProjectPausedWakeupDiscardNote({ projectLabel: "openclaw", summary: "Monitor finished" }))
      .toBe("PwrAgent discarded a wake-up (Monitor finished) because forge activity in openclaw is paused.");
  });
});

function thread(id: string, path: string): NavigationThreadSummary {
  return {
    id,
    source: "codex",
    title: id,
    titleSource: "explicit",
    updatedAt: 1,
    linkedDirectories: [{ id: path, label: "openclaw", path, kind: "local" }],
    inbox: { inInbox: false },
  } as NavigationThreadSummary;
}

describe("buildDirectorySummaries", () => {
  it("projects a stored setting onto its Directories project only", () => {
    const summaries = buildDirectorySummaries({
      threads: [thread("a", "/Users/fixture/src/openclaw")],
      directoryOverlayByKey: {
        "directory:/Users/fixture/src/openclaw": {
          directoryKey: "directory:/Users/fixture/src/openclaw",
          forgeAutomation: paused,
        },
      },
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.forgeAutomation).toEqual(paused);
  });

  it("drops a stored value that reads back as the defaults", () => {
    const summaries = buildDirectorySummaries({
      threads: [thread("a", "/Users/fixture/src/openclaw")],
      directoryOverlayByKey: {
        "directory:/Users/fixture/src/openclaw": {
          directoryKey: "directory:/Users/fixture/src/openclaw",
          forgeAutomation: { ...DEFAULT_PROJECT_FORGE_AUTOMATION },
        },
      },
    });
    expect(summaries[0]).not.toHaveProperty("forgeAutomation");
  });

  it("changes the snapshot hash when a project pauses", () => {
    const threads = [thread("a", "/Users/fixture/src/openclaw")];
    const active = buildDirectorySummaries({ threads });
    const pausedSummaries = buildDirectorySummaries({
      threads,
      directoryOverlayByKey: {
        "directory:/Users/fixture/src/openclaw": {
          directoryKey: "directory:/Users/fixture/src/openclaw",
          forgeAutomation: paused,
        },
      },
    });
    expect(serializeNavigationSnapshotForHash({ backend: "all", threads, directories: active }))
      .not.toBe(serializeNavigationSnapshotForHash({ backend: "all", threads, directories: pausedSummaries }));
  });
});
