import { describe, expect, it, vi } from "vitest";
import {
  buildDirectorySummaries,
  DEFAULT_PROJECT_FORGE_AUTOMATION,
  type LinkedDirectorySummary,
  type NavigationThreadSummary,
  type ProjectForgeAutomation,
} from "@pwragent/shared";
import {
  getProjectForgeAutomationIndex,
  ProjectForgeAutomationIndex,
  resetProjectForgeAutomationIndexForTests,
} from "../app-server/project-forge-automation-index";

const REPO = "/Users/fixture/src/openclaw";
const PROJECT = `directory:${REPO}`;
const paused: ProjectForgeAutomation = {
  ...DEFAULT_PROJECT_FORGE_AUTOMATION,
  paused: true,
  pausedAt: 1_700_000_000_000,
};

function thread(id: string, linkedDirectories: LinkedDirectorySummary[]): NavigationThreadSummary {
  return {
    id,
    source: "codex",
    title: id,
    titleSource: "explicit",
    updatedAt: 1,
    linkedDirectories,
    inbox: { inInbox: false },
  } as NavigationThreadSummary;
}

const local = (path: string, label = "openclaw"): LinkedDirectorySummary => ({
  id: path,
  label,
  path,
  kind: "local",
});

describe("ProjectForgeAutomationIndex", () => {
  it("answers without classifying anything while no project stores a setting", () => {
    const index = new ProjectForgeAutomationIndex();
    const lookupHint = vi.fn(() => ({ linkedDirectories: [local(REPO)] }));
    expect(index.automationForThread({ backend: "codex", threadId: "a" }, lookupHint)).toBeUndefined();
    expect(index.resolveThread({ backend: "codex", threadId: "a" }, lookupHint)).toBeUndefined();
    expect(lookupHint).not.toHaveBeenCalled();
  });

  it("hydrates stored settings and ignores defaults and non-project keys", () => {
    const index = new ProjectForgeAutomationIndex();
    index.hydrate({
      [PROJECT]: { directoryKey: PROJECT, forgeAutomation: paused },
      "directory:/Users/fixture/src/other": {
        directoryKey: "directory:/Users/fixture/src/other",
        forgeAutomation: { ...DEFAULT_PROJECT_FORGE_AUTOMATION },
      },
      "workspace:/Users/fixture/.pwragent/projects": {
        directoryKey: "workspace:/Users/fixture/.pwragent/projects",
        forgeAutomation: paused,
      },
    });
    expect(index.isHydrated()).toBe(true);
    expect(index.entries()).toEqual([[PROJECT, paused]]);
  });

  it("files threads under the project the navigation scan shows, worktrees included", () => {
    const worktree: LinkedDirectorySummary = {
      id: "wt",
      label: "openclaw",
      path: REPO,
      worktreePath: `${REPO}/.worktrees/fix-ci`,
      kind: "worktree",
    };
    const threads = [
      thread("repo", [local(REPO)]),
      thread("worktree", [worktree]),
      thread("managed", [local("/Users/fixture/.pwragent/worktrees/mabc123/openclaw")]),
      thread("elsewhere", [local("/Users/fixture/src/other", "other")]),
    ];
    const index = new ProjectForgeAutomationIndex();
    index.hydrate({ [PROJECT]: { directoryKey: PROJECT, forgeAutomation: paused } });
    index.rememberDirectories(buildDirectorySummaries({ threads }));

    for (const threadId of ["repo", "worktree", "managed"]) {
      expect(index.resolveThread({ backend: "codex", threadId })).toEqual({
        directoryKey: PROJECT,
        label: "openclaw",
        automation: paused,
      });
    }
    expect(index.resolveThread({ backend: "codex", threadId: "elsewhere" })).toBeUndefined();
    expect(index.threadKeysForDirectory(PROJECT).sort()).toEqual([
      "codex:managed",
      "codex:repo",
      "codex:worktree",
    ].sort());
  });

  it("classifies a thread the last scan did not list from its linked directories", () => {
    const index = new ProjectForgeAutomationIndex();
    index.hydrate({ [PROJECT]: { directoryKey: PROJECT, forgeAutomation: paused } });
    index.rememberDirectories(buildDirectorySummaries({ threads: [thread("repo", [local(REPO)])] }));

    // A `.worktrees/` checkout folds onto its repository.
    expect(index.automationForThread(
      { backend: "codex", threadId: "new-worktree" },
      () => ({
        linkedDirectories: [{
          id: "wt",
          label: "fix-ci",
          path: `${REPO}/.worktrees/fix-ci`,
          kind: "worktree",
        }],
      }),
    )).toEqual(paused);
    // A tool-managed worktree folds onto the one project with its name.
    expect(index.directoryKeyForThread(
      { backend: "codex", threadId: "new-managed" },
      () => ({ linkedDirectories: [local("/Users/fixture/.codex/worktrees/a1b2/openclaw")] }),
    )).toBe(PROJECT);
    // A scratch workspace is not a Directories project.
    expect(index.directoryKeyForThread(
      { backend: "codex", threadId: "scratch" },
      () => ({ linkedDirectories: [local("/Users/fixture/.pwragent/projects/scratch-1")] }),
    )).toBeUndefined();
  });

  it("resolves a working directory to its project", () => {
    const index = new ProjectForgeAutomationIndex();
    index.set(PROJECT, paused);
    expect(index.resolvePath(REPO)?.directoryKey).toBe(PROJECT);
    expect(index.resolvePath("/Users/fixture/src/other")).toBeUndefined();
    // A folder inside the project, or one that only shares its prefix.
    expect(index.resolvePath(`${REPO}/.worktrees/feat`)?.directoryKey).toBe(PROJECT);
    expect(index.resolvePath(`${REPO}/packages/app/`)?.directoryKey).toBe(PROJECT);
    expect(index.resolvePath(`${REPO}-fork`)).toBeUndefined();
  });

  it("clears a project on a Save back to the defaults", () => {
    const index = new ProjectForgeAutomationIndex();
    index.set(PROJECT, paused);
    expect(index.hasAny()).toBe(true);
    index.set(PROJECT, { ...DEFAULT_PROJECT_FORGE_AUTOMATION });
    expect(index.hasAny()).toBe(false);
    index.set(PROJECT, paused);
    index.set(PROJECT, null);
    expect(index.get(PROJECT)).toBeUndefined();
  });

  it("adopts a scan's projected setting only until the store is read", () => {
    const index = new ProjectForgeAutomationIndex();
    const directories = buildDirectorySummaries({
      threads: [thread("repo", [local(REPO)])],
      directoryOverlayByKey: { [PROJECT]: { directoryKey: PROJECT, forgeAutomation: paused } },
    });
    index.rememberDirectories(directories);
    expect(index.get(PROJECT)).toEqual(paused);

    index.hydrate({});
    index.rememberDirectories(directories);
    expect(index.get(PROJECT)).toBeUndefined();
  });

  it("drops threads a later complete scan no longer lists", () => {
    const index = new ProjectForgeAutomationIndex();
    index.set(PROJECT, paused);
    index.rememberDirectories(buildDirectorySummaries({ threads: [thread("repo", [local(REPO)])] }));
    index.rememberDirectories(buildDirectorySummaries({ threads: [] }));
    expect(index.directoryKeyForThread({ backend: "codex", threadId: "repo" })).toBeUndefined();
  });

  it("shares one index until a test resets it", () => {
    const shared = getProjectForgeAutomationIndex();
    expect(getProjectForgeAutomationIndex()).toBe(shared);
    resetProjectForgeAutomationIndexForTests();
    expect(getProjectForgeAutomationIndex()).not.toBe(shared);
  });
});
