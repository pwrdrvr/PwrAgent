import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { buildDirectorySummaries } from "../domain/directory-navigation";
import { materializeNavigationThreads } from "../domain/navigation-state";

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
          createdAt: 2_000,
          inbox: { inInbox: true },
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgent",
              path: "/Users/huntharo/pwrdrvr/PwrAgent",
              kind: "local",
            },
          ],
        }),
        buildThread({
          id: "thread-2",
          createdAt: 1_000,
          inbox: { inInbox: false },
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgent",
              path: "/Users/huntharo/pwrdrvr/PwrAgent",
              kind: "local",
            },
          ],
          updatedAt: 2_000,
        }),
      ],
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
        label: "PwrAgent",
        threadKeys: ["codex:thread-1", "codex:thread-2"],
        needsAttentionCount: 1,
        latestUpdatedAt: 2_000,
      }),
    ]);
  });

  it("orders directory threads by creation time instead of last update time", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "updated-later",
          createdAt: 1_000,
          updatedAt: 9_000,
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgent",
              path: "/Users/huntharo/pwrdrvr/PwrAgent",
              kind: "local",
            },
          ],
        }),
        buildThread({
          id: "created-later",
          createdAt: 2_000,
          updatedAt: 2_000,
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgent",
              path: "/Users/huntharo/pwrdrvr/PwrAgent",
              kind: "local",
            },
          ],
        }),
      ],
    });

    expect(directories[0]?.threadKeys).toEqual([
      "codex:created-later",
      "codex:updated-later",
    ]);
  });

  it("includes launchpad-only directories even when no current thread is linked", () => {
    const directories = buildDirectorySummaries({
      threads: [],
      launchpadsByKey: {
        "directory:/Users/huntharo/pwrdrvr/PwrAgent": {
          directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
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
        key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
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
          createdAt: 2_000,
          linkedDirectories: [
            {
              id: "dir-1",
              label: "directory:/Users/huntharo/github/PwrAgent",
              path: "/Users/huntharo/github/PwrAgent",
              kind: "local",
            },
          ],
        }),
      ],
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/huntharo/github/PwrAgent",
        label: "PwrAgent",
      }),
    ]);
  });

  it("normalizes stale launchpad labels that contain internal directory keys", () => {
    const directories = buildDirectorySummaries({
      threads: [],
      launchpadsByKey: {
        "directory:/Users/huntharo/github/PwrAgent": {
          directoryKey: "directory:/Users/huntharo/github/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "directory:/Users/huntharo/github/PwrAgent",
          directoryPath: "/Users/huntharo/github/PwrAgent",
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
        key: "directory:/Users/huntharo/github/PwrAgent",
        label: "PwrAgent",
        launchpad: expect.objectContaining({
          directoryLabel: "PwrAgent",
          prompt: "Existing draft",
        }),
      }),
    ]);
  });

  it("derives stale launchpad display labels from the directory key when path is missing", () => {
    const directories = buildDirectorySummaries({
      threads: [],
      launchpadsByKey: {
        "directory:/Users/huntharo/github/PwrAgent": {
          directoryKey: "directory:/Users/huntharo/github/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "directory:/Users/huntharo/github/PwrAgent",
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
        key: "directory:/Users/huntharo/github/PwrAgent",
        label: "PwrAgent",
        path: "/Users/huntharo/github/PwrAgent",
        launchpad: expect.objectContaining({
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/github/PwrAgent",
        }),
      }),
    ]);
  });

  it("ignores opened-only launchpads with no pending data or touched settings", () => {
    const directories = buildDirectorySummaries({
      threads: [],
      launchpadsByKey: {
        "directory:/Users/huntharo/pwrdrvr/PwrAgent": {
          directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
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

  it("keeps explicitly registered directories even when their launchpad is empty", () => {
    const directories = buildDirectorySummaries({
      threads: [],
      launchpadsByKey: {
        "directory:/Users/huntharo/pwrdrvr/PwrAgent": {
          directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          registeredAt: 1_500,
          workMode: "local",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      },
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
        threadKeys: [],
        needsAttentionCount: 0,
        launchpad: expect.objectContaining({
          prompt: "",
          registeredAt: 1_500,
        }),
      }),
    ]);
  });

  it("keeps launchpads with user-touched settings even when the prompt is empty", () => {
    const directories = buildDirectorySummaries({
      threads: [],
      launchpadsByKey: {
        "directory:/Users/huntharo/pwrdrvr/PwrAgent": {
          directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
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
        key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
        launchpad: expect.objectContaining({
          executionMode: "full-access",
          settingsTouchedAt: 2_000,
        }),
      }),
    ]);
  });

  it("groups the scratch workspace root under Workspaces instead of a projects directory", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          createdAt: 2_000,
          linkedDirectories: [
            {
              id: "/Users/huntharo/.pwragent/projects",
              label: "projects",
              path: "/Users/huntharo/.pwragent/projects",
              kind: "local",
            },
          ],
        }),
        buildThread({
          id: "thread-2",
          createdAt: 1_000,
          linkedDirectories: [
            {
              id: "/Users/huntharo/.pwragent/projects/2026-05-02-a1b2c3",
              label: "2026-05-02-a1b2c3",
              path: "/Users/huntharo/.pwragent/projects/2026-05-02-a1b2c3",
              kind: "local",
            },
          ],
          updatedAt: 2_000,
        }),
      ],
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "workspace:/Users/huntharo/.pwragent/projects",
        kind: "workspace",
        label: "Workspaces",
        path: "/Users/huntharo/.pwragent/projects",
        threadKeys: ["codex:thread-1", "codex:thread-2"],
      }),
    ]);
  });

  it("groups profile-scoped scratch projects under Workspaces", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          linkedDirectories: [
            {
              id: "/Users/huntharo/.pwragent/profiles/default/projects/2026-05-08-9bc2d3",
              label: "2026-05-08-9bc2d3",
              path: "/Users/huntharo/.pwragent/profiles/default/projects/2026-05-08-9bc2d3",
              kind: "local",
            },
          ],
        }),
      ],
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "workspace:/Users/huntharo/.pwragent/profiles/default/projects",
        kind: "workspace",
        label: "Workspaces",
        path: "/Users/huntharo/.pwragent/profiles/default/projects",
        threadKeys: ["codex:thread-1"],
      }),
    ]);
  });

  it("collapses current, legacy, and launchpad-only scratch roots into one Workspaces row", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "019e1e90-ae49-78a0-8414-266602c3a532",
          inbox: { inInbox: true },
          linkedDirectories: [
            {
              id: "/Users/huntharo/.pwragent/profiles/dev/projects/2026-05-12-605c84",
              label: "2026-05-12-605c84",
              path: "/Users/huntharo/.pwragent/profiles/dev/projects/2026-05-12-605c84",
              kind: "local",
            },
          ],
          updatedAt: 4_000,
        }),
        buildThread({
          id: "019e1732-3ce4-7dd1-9191-f097f816a5dd",
          linkedDirectories: [
            {
              id: "/Users/huntharo/.pwragent/profiles/dev/projects/2026-05-11-dc5db1",
              label: "2026-05-11-dc5db1",
              path: "/Users/huntharo/.pwragent/profiles/dev/projects/2026-05-11-dc5db1",
              kind: "local",
            },
          ],
          updatedAt: 3_000,
        }),
        buildThread({
          id: "019deae0-5018-7ac3-8b5c-2ac392f8fbd8",
          linkedDirectories: [
            {
              id: "/Users/huntharo/.pwragnt/projects/2026-05-02-bc16ae",
              label: "2026-05-02-bc16ae",
              path: "/Users/huntharo/.pwragnt/projects/2026-05-02-bc16ae",
              kind: "local",
            },
          ],
          updatedAt: 2_000,
        }),
        buildThread({
          id: "019de4af-5a9e-7813-88f0-6cc4ac251fda",
          linkedDirectories: [
            {
              id: "/Users/huntharo/.pwragnt/projects/2026-05-01-800a67",
              label: "2026-05-01-800a67",
              path: "/Users/huntharo/.pwragnt/projects/2026-05-01-800a67",
              kind: "local",
            },
          ],
          updatedAt: 1_000,
        }),
      ],
      launchpadsByKey: {
        "workspace:/Users/huntharo/.pwragent/profiles/default/projects": {
          directoryKey: "workspace:/Users/huntharo/.pwragent/profiles/default/projects",
          directoryKind: "workspace",
          directoryLabel: "Workspaces",
          directoryPath: "/Users/huntharo/.pwragent/profiles/default/projects",
          backend: "codex",
          executionMode: "default",
          prompt: "Pending scratchpad draft",
          workMode: "local",
          createdAt: 5_000,
          updatedAt: 6_000,
        },
      },
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "workspace:/Users/huntharo/.pwragent/profiles/default/projects",
        kind: "workspace",
        label: "Workspaces",
        path: "/Users/huntharo/.pwragent/profiles/default/projects",
        threadKeys: [
          "codex:019e1e90-ae49-78a0-8414-266602c3a532",
          "codex:019e1732-3ce4-7dd1-9191-f097f816a5dd",
          "codex:019deae0-5018-7ac3-8b5c-2ac392f8fbd8",
          "codex:019de4af-5a9e-7813-88f0-6cc4ac251fda",
        ],
        needsAttentionCount: 1,
        latestUpdatedAt: 6_000,
        launchpad: expect.objectContaining({
          directoryKey: "workspace:/Users/huntharo/.pwragent/profiles/default/projects",
          prompt: "Pending scratchpad draft",
        }),
      }),
    ]);
  });

  it("keeps multiple pending workspace drafts selectable instead of collapsing one away", () => {
    const directories = buildDirectorySummaries({
      threads: [],
      launchpadsByKey: {
        "workspace:/Users/huntharo/.pwragnt/projects": {
          directoryKey: "workspace:/Users/huntharo/.pwragnt/projects",
          directoryKind: "workspace",
          directoryLabel: "Workspaces",
          directoryPath: "/Users/huntharo/.pwragnt/projects",
          backend: "codex",
          executionMode: "default",
          prompt: "Legacy draft",
          workMode: "local",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
        "workspace:/Users/huntharo/.pwragent/profiles/dev/projects": {
          directoryKey: "workspace:/Users/huntharo/.pwragent/profiles/dev/projects",
          directoryKind: "workspace",
          directoryLabel: "Workspaces",
          directoryPath: "/Users/huntharo/.pwragent/profiles/dev/projects",
          backend: "codex",
          executionMode: "default",
          prompt: "Profile draft",
          workMode: "local",
          createdAt: 3_000,
          updatedAt: 4_000,
        },
      },
    });

    expect(directories).toHaveLength(2);
    expect(directories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "workspace:/Users/huntharo/.pwragnt/projects",
          launchpad: expect.objectContaining({
            directoryKey: "workspace:/Users/huntharo/.pwragnt/projects",
            prompt: "Legacy draft",
          }),
        }),
        expect.objectContaining({
          key: "workspace:/Users/huntharo/.pwragent/profiles/dev/projects",
          launchpad: expect.objectContaining({
            directoryKey: "workspace:/Users/huntharo/.pwragent/profiles/dev/projects",
            prompt: "Profile draft",
          }),
        }),
      ]),
    );
  });

  it("keeps same-named Codex worktrees as separate directory rows", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          createdAt: 2_000,
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgent",
              path: "/Users/huntharo/.codex/worktrees/repo-one/PwrAgent",
              kind: "worktree",
            },
          ],
        }),
        buildThread({
          id: "thread-2",
          createdAt: 1_000,
          linkedDirectories: [
            {
              id: "dir-2",
              label: "PwrAgent",
              path: "/Users/huntharo/.codex/worktrees/repo-two/PwrAgent",
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
          key: "directory:/Users/huntharo/.codex/worktrees/repo-one/PwrAgent",
          label: "PwrAgent",
          path: "/Users/huntharo/.codex/worktrees/repo-one/PwrAgent",
          threadKeys: ["codex:thread-1"],
        }),
        expect.objectContaining({
          key: "directory:/Users/huntharo/.codex/worktrees/repo-two/PwrAgent",
          label: "PwrAgent",
          path: "/Users/huntharo/.codex/worktrees/repo-two/PwrAgent",
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
          createdAt: 2_000,
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgent",
              path: "/Users/huntharo/pwrdrvr/PwrAgent",
              worktreePath: "/Users/huntharo/.codex/worktrees/repo-one/PwrAgent",
              kind: "worktree",
            },
          ],
        }),
        buildThread({
          id: "thread-2",
          createdAt: 1_000,
          linkedDirectories: [
            {
              id: "dir-2",
              label: "PwrAgent",
              path: "/Users/huntharo/pwrdrvr/PwrAgent",
              worktreePath: "/Users/huntharo/.codex/worktrees/repo-two/PwrAgent",
              kind: "worktree",
            },
          ],
          updatedAt: 2_000,
        }),
      ],
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
        label: "PwrAgent",
        path: "/Users/huntharo/pwrdrvr/PwrAgent",
        threadKeys: ["codex:thread-1", "codex:thread-2"],
        latestUpdatedAt: 2_000,
      }),
    ]);
  });

  it("groups PwrAgent-managed worktree paths under the stable same-label home repo row", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-home",
          createdAt: 2_000,
          linkedDirectories: [
            {
              id: "/Users/huntharo/claude-worktrees/PwrAgnt/modest/apps/desktop",
              label: "PwrAgnt",
              path: "/Users/huntharo/claude-worktrees/PwrAgnt/modest/apps/desktop",
              kind: "local",
            },
          ],
        }),
        buildThread({
          id: "thread-worktree",
          createdAt: 1_000,
          linkedDirectories: [
            {
              id: "/Users/huntharo/.pwragent/worktrees/mord46hf/PwrAgnt",
              label: "PwrAgnt",
              path: "/Users/huntharo/.pwragent/worktrees/mord46hf/PwrAgnt",
              kind: "local",
            },
          ],
          updatedAt: 2_000,
        }),
      ],
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/huntharo/claude-worktrees/PwrAgnt/modest/apps/desktop",
        label: "PwrAgnt",
        path: "/Users/huntharo/claude-worktrees/PwrAgnt/modest/apps/desktop",
        threadKeys: ["codex:thread-home", "codex:thread-worktree"],
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
              label: "PwrAgent",
              path: "/repo",
              kind: "local",
            },
            {
              id: "pwragent-handoff:codex:thread-1",
              label: "PwrAgent",
              path: "/repo",
              worktreePath: "/repo/.worktrees/pwragent-feature",
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

describe("materializeNavigationThreads", () => {
  it("normalizes linked directories so a worktree path cannot render as local", () => {
    const [thread] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {},
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [
        buildThread({
          linkedDirectories: [
            {
              id: "thread-worktree",
              label: "PwrAgent",
              path: "/Users/huntharo/github/PwrAgent",
              worktreePath: "/Users/huntharo/.codex/worktrees/morkpkco/PwrAgent",
              kind: "local",
            },
          ],
        }),
      ],
    });

    expect(thread?.linkedDirectories).toEqual([
      {
        id: "thread-worktree",
        label: "PwrAgent",
        path: "/Users/huntharo/github/PwrAgent",
        worktreePath: "/Users/huntharo/.codex/worktrees/morkpkco/PwrAgent",
        kind: "worktree",
      },
    ]);
  });

  it("normalizes managed worktree paths even when no repository path is known", () => {
    const [thread] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {},
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [
        buildThread({
          linkedDirectories: [
            {
              id: "/Users/huntharo/.codex/worktrees/mp62bt71/PwrAgnt",
              label: "PwrAgnt",
              path: "/Users/huntharo/.codex/worktrees/mp62bt71/PwrAgnt",
              kind: "local",
            },
          ],
        }),
      ],
    });

    expect(thread?.linkedDirectories).toEqual([
      {
        id: "/Users/huntharo/.codex/worktrees/mp62bt71/PwrAgnt",
        label: "PwrAgnt",
        path: "/Users/huntharo/.codex/worktrees/mp62bt71/PwrAgnt",
        worktreePath: "/Users/huntharo/.codex/worktrees/mp62bt71/PwrAgnt",
        kind: "worktree",
      },
    ]);
  });
});
