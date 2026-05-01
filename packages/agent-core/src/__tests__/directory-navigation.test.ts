import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragnt/shared";
import { buildDirectorySummaries } from "../domain/directory-navigation";

function buildThread(
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id: "thread-1",
    title: "Desktop App",
    titleSource: "explicit",
    source: "codex",
    linkedDirectories: [],
    inbox: {
      inInbox: false,
    },
    updatedAt: 1_000,
    executionMode: "default",
    ...overrides,
  };
}

describe("buildDirectorySummaries", () => {
  it("groups linked threads under stable directory rows and counts needs-attention threads", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          inbox: { inInbox: true },
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgnt",
              path: "/Users/huntharo/pwrdrvr/PwrAgnt",
              kind: "local",
            },
          ],
        }),
        buildThread({
          id: "thread-2",
          inbox: { inInbox: false },
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgnt",
              path: "/Users/huntharo/pwrdrvr/PwrAgnt",
              kind: "local",
            },
          ],
          updatedAt: 2_000,
        }),
      ],
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
        label: "PwrAgnt",
        threadKeys: ["codex:thread-1", "codex:thread-2"],
        needsAttentionCount: 1,
        latestUpdatedAt: 2_000,
      }),
    ]);
  });

  it("includes launchpad-only directories even when no current thread is linked", () => {
    const directories = buildDirectorySummaries({
      threads: [],
      launchpadsByKey: {
        "directory:/Users/huntharo/pwrdrvr/PwrAgnt": {
          directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
          directoryKind: "directory",
          directoryLabel: "PwrAgnt",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgnt",
          backend: "codex",
          executionMode: "default",
          prompt: "Draft prompt",
          workMode: "local",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      },
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
        threadKeys: [],
        needsAttentionCount: 0,
        launchpad: expect.objectContaining({
          prompt: "Draft prompt",
        }),
      }),
    ]);
  });

  it("uses the directory basename when a linked thread label is an internal directory key", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          linkedDirectories: [
            {
              id: "dir-1",
              label: "directory:/Users/huntharo/github/PwrAgnt",
              path: "/Users/huntharo/github/PwrAgnt",
              kind: "local",
            },
          ],
        }),
      ],
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/huntharo/github/PwrAgnt",
        label: "PwrAgnt",
      }),
    ]);
  });

  it("normalizes stale launchpad labels that contain internal directory keys", () => {
    const directories = buildDirectorySummaries({
      threads: [],
      launchpadsByKey: {
        "directory:/Users/huntharo/github/PwrAgnt": {
          directoryKey: "directory:/Users/huntharo/github/PwrAgnt",
          directoryKind: "directory",
          directoryLabel: "directory:/Users/huntharo/github/PwrAgnt",
          directoryPath: "/Users/huntharo/github/PwrAgnt",
          backend: "codex",
          executionMode: "default",
          prompt: "Existing draft",
          workMode: "local",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      },
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/huntharo/github/PwrAgnt",
        label: "PwrAgnt",
        launchpad: expect.objectContaining({
          directoryLabel: "PwrAgnt",
          prompt: "Existing draft",
        }),
      }),
    ]);
  });

  it("ignores opened-only launchpads with no pending data or touched settings", () => {
    const directories = buildDirectorySummaries({
      threads: [],
      launchpadsByKey: {
        "directory:/Users/huntharo/pwrdrvr/PwrAgnt": {
          directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
          directoryKind: "directory",
          directoryLabel: "PwrAgnt",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgnt",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      },
    });

    expect(directories).toEqual([]);
  });

  it("keeps launchpads with user-touched settings even when the prompt is empty", () => {
    const directories = buildDirectorySummaries({
      threads: [],
      launchpadsByKey: {
        "directory:/Users/huntharo/pwrdrvr/PwrAgnt": {
          directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
          directoryKind: "directory",
          directoryLabel: "PwrAgnt",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgnt",
          backend: "codex",
          executionMode: "full-access",
          prompt: "",
          settingsTouchedAt: 2_000,
          workMode: "local",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      },
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
        launchpad: expect.objectContaining({
          executionMode: "full-access",
          settingsTouchedAt: 2_000,
        }),
      }),
    ]);
  });

  it("keeps same-named Codex worktrees as separate directory rows", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgnt",
              path: "/Users/huntharo/.codex/worktrees/repo-one/PwrAgnt",
              kind: "worktree",
            },
          ],
        }),
        buildThread({
          id: "thread-2",
          linkedDirectories: [
            {
              id: "dir-2",
              label: "PwrAgnt",
              path: "/Users/huntharo/.codex/worktrees/repo-two/PwrAgnt",
              kind: "worktree",
            },
          ],
          updatedAt: 2_000,
        }),
      ],
    });

    expect(directories).toHaveLength(2);
    expect(directories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "directory:/Users/huntharo/.codex/worktrees/repo-one/PwrAgnt",
          label: "PwrAgnt",
          path: "/Users/huntharo/.codex/worktrees/repo-one/PwrAgnt",
          threadKeys: ["codex:thread-1"],
        }),
        expect.objectContaining({
          key: "directory:/Users/huntharo/.codex/worktrees/repo-two/PwrAgnt",
          label: "PwrAgnt",
          path: "/Users/huntharo/.codex/worktrees/repo-two/PwrAgnt",
          threadKeys: ["codex:thread-2"],
        }),
      ]),
    );
  });

  it("groups multiple worktrees under the same home repo when thread summaries share the canonical directory path", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgnt",
              path: "/Users/huntharo/pwrdrvr/PwrAgnt",
              worktreePath: "/Users/huntharo/.codex/worktrees/repo-one/PwrAgnt",
              kind: "worktree",
            },
          ],
        }),
        buildThread({
          id: "thread-2",
          linkedDirectories: [
            {
              id: "dir-2",
              label: "PwrAgnt",
              path: "/Users/huntharo/pwrdrvr/PwrAgnt",
              worktreePath: "/Users/huntharo/.codex/worktrees/repo-two/PwrAgnt",
              kind: "worktree",
            },
          ],
          updatedAt: 2_000,
        }),
      ],
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
        label: "PwrAgnt",
        path: "/Users/huntharo/pwrdrvr/PwrAgnt",
        threadKeys: ["codex:thread-1", "codex:thread-2"],
        latestUpdatedAt: 2_000,
      }),
    ]);
  });

  it("uses handoff overlay workspace metadata as the active local/worktree directory", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          linkedDirectories: [
            {
              id: "backend-local",
              label: "PwrAgnt",
              path: "/repo",
              kind: "local",
            },
            {
              id: "pwragnt-handoff:codex:thread-1",
              label: "PwrAgnt",
              path: "/repo",
              worktreePath: "/repo/.worktrees/pwragnt-feature",
              kind: "worktree",
            },
          ],
        }),
      ],
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/repo",
        path: "/repo",
        threadKeys: ["codex:thread-1"],
      }),
    ]);
  });
});
