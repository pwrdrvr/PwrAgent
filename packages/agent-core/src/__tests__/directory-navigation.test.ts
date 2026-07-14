import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { buildDirectorySummaries } from "../domain/directory-navigation";
import {
  buildNavigationSnapshot,
  buildNavigationSnapshotHash,
  materializeNavigationThreads,
} from "../domain/navigation-state";

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

describe("materializeNavigationThreads — subthread grouping", () => {
  it("flattens persisted nested subthreads to the root parent", () => {
    const threads = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {
        "codex:source-child": {
          backend: "codex",
          threadId: "source-child",
          executionMode: "default",
          extraLinkedDirectories: [],
          parentThreadId: "root-thread",
        },
        "codex:nested-child": {
          backend: "codex",
          threadId: "nested-child",
          executionMode: "default",
          extraLinkedDirectories: [],
          parentThreadId: "source-child",
        },
      },
      previousKnownThreadKeys: [],
      threads: [
        buildThread({ id: "root-thread" }),
        buildThread({ id: "source-child" }),
        buildThread({ id: "nested-child" }),
      ],
    });

    expect(
      threads.find((thread) => thread.id === "nested-child")?.parentThreadId,
    ).toBe("root-thread");
  });
});

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

  it("uses escaped dynamic backend ids in directory thread keys", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          source: "acp:gemini",
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

    expect(directories[0]?.threadKeys).toEqual(["acp%3Agemini:thread-1"]);
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

  it("does not surface a sub-thread launchpad as a project-directory row", () => {
    // Repro for the launchpad leak: opening "create sub-thread", typing a
    // prompt, then cancelling used to leave the subthread:<source>:<parent>:<mode>
    // overlay row behind. Because it carried a prompt, buildDirectorySummaries
    // rendered it as a phantom top-level project directory (labelled with the
    // parent workspace name), duplicating the real directory row. Sub-thread
    // launchpads are thread-scoped and reached inline from the parent thread —
    // they must never masquerade as a directory in the Directories lens.
    const directories = buildDirectorySummaries({
      threads: [],
      launchpadsByKey: {
        "subthread:codex:thread-parent:same-worktree": {
          directoryKey: "subthread:codex:thread-parent:same-worktree",
          directoryKind: "directory",
          directoryLabel: "media-service",
          directoryPath: "/Users/huntharo/pwrdrvr/media-service",
          backend: "codex",
          executionMode: "default",
          prompt: "Make a PR to swap all the icons",
          workMode: "worktree",
          parentThreadId: "thread-parent",
          parentThreadTitle: "media-service",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      },
    });

    expect(directories).toEqual([]);
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

  it("groups Codex Desktop no-directory chats under Codex Chats", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "019e8142-230d-78d1-928c-8b4ba1f20d92",
          createdAt: 2_000,
          linkedDirectories: [
            {
              id: "/Users/huntharo/Documents/Codex/2026-05-31/testing-another-chat",
              label: "testing-another-chat",
              path: "/Users/huntharo/Documents/Codex/2026-05-31/testing-another-chat",
              kind: "local",
            },
          ],
        }),
        buildThread({
          id: "019e8142-078b-7cd0-9417-3206124d762e",
          createdAt: 1_000,
          linkedDirectories: [
            {
              id: "/Users/huntharo/Documents/Codex/2026-05-31/testing-a-chat",
              label: "testing-a-chat",
              path: "/Users/huntharo/Documents/Codex/2026-05-31/testing-a-chat",
              kind: "local",
            },
          ],
          updatedAt: 2_000,
        }),
      ],
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/huntharo/Documents/Codex",
        kind: "directory",
        label: "Codex Chats",
        path: "/Users/huntharo/Documents/Codex",
        threadKeys: [
          "codex:019e8142-230d-78d1-928c-8b4ba1f20d92",
          "codex:019e8142-078b-7cd0-9417-3206124d762e",
        ],
      }),
    ]);
  });

  it("does not treat arbitrary Documents/Codex children as Codex Chats", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          linkedDirectories: [
            {
              id: "/Users/huntharo/Documents/Codex/MyProject",
              label: "MyProject",
              path: "/Users/huntharo/Documents/Codex/MyProject",
              kind: "local",
            },
          ],
        }),
      ],
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/huntharo/Documents/Codex/MyProject",
        label: "MyProject",
        path: "/Users/huntharo/Documents/Codex/MyProject",
      }),
    ]);
  });

  it("filters profile-scoped workspace roots outside the active profile", () => {
    const defaultProjectsRoot = "/Users/huntharo/.pwragent/profiles/default/projects";
    const preProfileProjectsRoot = "/Users/huntharo/.pwragent/projects";
    const devProjectsRoot = "/Users/huntharo/.pwragent/profiles/dev/projects";
    const legacyProjectsRoot = "/Users/huntharo/.pwragnt/projects";
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "default-thread",
          linkedDirectories: [
            {
              id: `${defaultProjectsRoot}/2026-05-08-9bc2d3`,
              label: "2026-05-08-9bc2d3",
              path: `${defaultProjectsRoot}/2026-05-08-9bc2d3`,
              kind: "local",
            },
          ],
        }),
        buildThread({
          id: "pre-profile-thread",
          linkedDirectories: [
            {
              id: `${preProfileProjectsRoot}/2026-05-10-c7d8e9`,
              label: "2026-05-10-c7d8e9",
              path: `${preProfileProjectsRoot}/2026-05-10-c7d8e9`,
              kind: "local",
            },
          ],
        }),
        buildThread({
          id: "dev-thread",
          linkedDirectories: [
            {
              id: `${devProjectsRoot}/2026-05-12-605c84`,
              label: "2026-05-12-605c84",
              path: `${devProjectsRoot}/2026-05-12-605c84`,
              kind: "local",
            },
          ],
        }),
        buildThread({
          id: "legacy-thread",
          linkedDirectories: [
            {
              id: `${legacyProjectsRoot}/2026-05-02-bc16ae`,
              label: "2026-05-02-bc16ae",
              path: `${legacyProjectsRoot}/2026-05-02-bc16ae`,
              kind: "local",
            },
          ],
        }),
      ],
      launchpadsByKey: {
        [`workspace:${defaultProjectsRoot}`]: {
          directoryKey: `workspace:${defaultProjectsRoot}`,
          directoryKind: "workspace",
          directoryLabel: "Workspaces",
          directoryPath: defaultProjectsRoot,
          backend: "codex",
          executionMode: "default",
          prompt: "Default draft",
          workMode: "local",
          createdAt: 1_000,
          updatedAt: 3_000,
        },
        [`workspace:${preProfileProjectsRoot}`]: {
          directoryKey: `workspace:${preProfileProjectsRoot}`,
          directoryKind: "workspace",
          directoryLabel: "Workspaces",
          directoryPath: preProfileProjectsRoot,
          backend: "codex",
          executionMode: "default",
          prompt: "Pre-profile draft",
          workMode: "local",
          createdAt: 1_000,
          updatedAt: 5_000,
        },
        [`workspace:${devProjectsRoot}`]: {
          directoryKey: `workspace:${devProjectsRoot}`,
          directoryKind: "workspace",
          directoryLabel: "Workspaces",
          directoryPath: devProjectsRoot,
          backend: "codex",
          executionMode: "default",
          prompt: "Dev draft",
          workMode: "local",
          createdAt: 1_000,
          updatedAt: 4_000,
        },
      },
      workspaceRoots: [
        defaultProjectsRoot,
        preProfileProjectsRoot,
        legacyProjectsRoot,
      ],
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: `workspace:${defaultProjectsRoot}`,
        label: "Workspaces",
        path: defaultProjectsRoot,
        threadKeys: expect.arrayContaining([
          "codex:default-thread",
          "codex:pre-profile-thread",
          "codex:legacy-thread",
        ]),
        launchpad: expect.objectContaining({
          prompt: "Default draft",
        }),
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

  it("collapses multiple pending workspace drafts into one Workspaces row", () => {
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

    expect(directories).toEqual([
      expect.objectContaining({
        key: "workspace:/Users/huntharo/.pwragent/profiles/dev/projects",
        kind: "workspace",
        label: "Workspaces",
        path: "/Users/huntharo/.pwragent/profiles/dev/projects",
        threadKeys: [],
        needsAttentionCount: 0,
        latestUpdatedAt: 4_000,
        launchpad: expect.objectContaining({
          directoryKey: "workspace:/Users/huntharo/.pwragent/profiles/dev/projects",
          prompt: "Profile draft",
        }),
      }),
    ]);
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

  it("groups stale same-origin Codex worktree rows when no canonical repo path is known", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          createdAt: 2_000,
          gitOriginUrl: "git@github.com:Giphy/svc-infra.git",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "svc-infra",
              path: "/Users/huntharo/.codex/worktrees/e926/svc-infra",
              kind: "worktree",
            },
          ],
        }),
        buildThread({
          id: "thread-2",
          createdAt: 1_000,
          gitOriginUrl: "https://github.com/Giphy/svc-infra.git",
          linkedDirectories: [
            {
              id: "dir-2",
              label: "svc-infra",
              path: "/Users/huntharo/.codex/worktrees/3364/svc-infra",
              kind: "worktree",
            },
          ],
          updatedAt: 2_000,
        }),
      ],
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/huntharo/.codex/worktrees/e926/svc-infra",
        label: "svc-infra",
        path: "/Users/huntharo/.codex/worktrees/e926/svc-infra",
        threadKeys: ["codex:thread-1", "codex:thread-2"],
      }),
    ]);
  });

  it("keeps same-label managed worktrees separate when their origins differ", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          createdAt: 2_000,
          gitOriginUrl: "git@github.com:Giphy/svc-infra.git",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "svc-infra",
              path: "/Users/huntharo/.codex/worktrees/e926/svc-infra",
              kind: "worktree",
            },
          ],
        }),
        buildThread({
          id: "thread-2",
          createdAt: 1_000,
          gitOriginUrl: "git@github.com:OtherOrg/svc-infra.git",
          linkedDirectories: [
            {
              id: "dir-2",
              label: "svc-infra",
              path: "/Users/huntharo/.codex/worktrees/3364/svc-infra",
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
          key: "directory:/Users/huntharo/.codex/worktrees/e926/svc-infra",
          threadKeys: ["codex:thread-1"],
        }),
        expect.objectContaining({
          key: "directory:/Users/huntharo/.codex/worktrees/3364/svc-infra",
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

  it("collapses a Windows repo into one row across path-separator representations", () => {
    // Reproduces the Windows bug where one project surfaced as three "PwrAgent"
    // rows: the main checkout linked once with forward slashes (how we normalize
    // codex/git paths) and once with native backslashes, plus a codex worktree
    // that then couldn't remap onto a now-ambiguous canonical repo path.
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "main-fwd",
          createdAt: 3_000,
          linkedDirectories: [
            {
              id: "d1",
              label: "PwrAgent",
              path: "C:/Users/Administrator/PwrAgent",
              kind: "local",
            },
          ],
        }),
        buildThread({
          id: "main-bak",
          createdAt: 2_000,
          linkedDirectories: [
            {
              id: "d2",
              label: "PwrAgent",
              path: "C:\\Users\\Administrator\\PwrAgent",
              kind: "local",
            },
          ],
        }),
        buildThread({
          id: "worktree",
          createdAt: 1_000,
          linkedDirectories: [
            {
              id: "d3",
              label: "PwrAgent",
              path: "C:\\Users\\Administrator\\.codex\\worktrees\\mq4ow4zb\\PwrAgent",
              kind: "worktree",
            },
          ],
        }),
      ],
    });

    expect(directories).toHaveLength(1);
    expect(directories[0]).toEqual(
      expect.objectContaining({
        key: "directory:C:/Users/Administrator/PwrAgent",
        label: "PwrAgent",
        path: "C:/Users/Administrator/PwrAgent",
      }),
    );
    expect(directories[0]?.threadKeys).toHaveLength(3);
  });

  it("does not duplicate a Windows codex worktree row across separator representations", () => {
    // One thread linked to the same codex worktree via both forward and back
    // slashes must surface as a single row, not appear twice.
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          createdAt: 1_000,
          linkedDirectories: [
            {
              id: "d-fwd",
              label: "PwrAgent",
              path: "C:/Users/Administrator/.codex/worktrees/mq4ow4zb/PwrAgent",
              kind: "worktree",
            },
            {
              id: "d-bak",
              label: "PwrAgent",
              path: "C:\\Users\\Administrator\\.codex\\worktrees\\mq4ow4zb\\PwrAgent",
              kind: "worktree",
            },
          ],
        }),
      ],
    });

    expect(directories).toHaveLength(1);
    expect(directories[0]).toEqual(
      expect.objectContaining({
        key: "directory:C:/Users/Administrator/.codex/worktrees/mq4ow4zb/PwrAgent",
        label: "PwrAgent",
      }),
    );
    expect(directories[0]?.threadKeys).toEqual(["codex:thread-1"]);
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

  // The one-row-per-thread invariant. This is platform-independent: on macOS
  // (all forward slashes) the same thread was surfacing under two/three
  // "PwrAgnt" parent folders at once, all highlighting as selected. A thread
  // must appear under exactly one parent directory row no matter how many
  // distinct rows its linked directories resolve to.
  it("never lists the same thread under more than one parent directory row", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          createdAt: 1_000,
          // Two managed worktrees of the same project, different hashes, no
          // canonical repo path and no shared git origin to remap onto — so
          // they classify to two distinct rows that cannot be collapsed.
          linkedDirectories: [
            {
              id: "wt-a",
              label: "PwrAgnt",
              path: "/Users/huntharo/.codex/worktrees/aaaa/PwrAgnt",
              kind: "worktree",
            },
            {
              id: "wt-b",
              label: "PwrAgnt",
              path: "/Users/huntharo/.codex/worktrees/bbbb/PwrAgnt",
              kind: "worktree",
            },
          ],
        }),
      ],
    });

    const rowsWithThread = directories.filter((directory) =>
      directory.threadKeys.includes("codex:thread-1"),
    );
    expect(rowsWithThread).toHaveLength(1);
    // Deterministic home: lexicographically smallest key when no row is more
    // canonical than another.
    expect(rowsWithThread[0]?.key).toBe(
      "directory:/Users/huntharo/.codex/worktrees/aaaa/PwrAgnt",
    );
  });

  it("never lists the same thread under more than one parent directory row (Windows paths)", () => {
    // Same invariant as above, but the linked directories arrive with native
    // Windows backslashes + a drive letter. classifyDirectory canonicalizes
    // separators first, so the home selection that follows behaves identically
    // to POSIX — the thread still lands in exactly one row.
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          createdAt: 1_000,
          linkedDirectories: [
            {
              id: "wt-a",
              label: "PwrAgnt",
              path: "C:\\Users\\Administrator\\.codex\\worktrees\\aaaa\\PwrAgnt",
              kind: "worktree",
            },
            {
              id: "wt-b",
              label: "PwrAgnt",
              path: "C:\\Users\\Administrator\\.codex\\worktrees\\bbbb\\PwrAgnt",
              kind: "worktree",
            },
          ],
        }),
      ],
    });

    const rowsWithThread = directories.filter((directory) =>
      directory.threadKeys.includes("codex:thread-1"),
    );
    expect(rowsWithThread).toHaveLength(1);
    expect(rowsWithThread[0]?.key).toBe(
      "directory:C:/Users/Administrator/.codex/worktrees/aaaa/PwrAgnt",
    );
  });

  it("homes a thread on its repo row, not an unrelated worktree row", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          createdAt: 1_000,
          linkedDirectories: [
            {
              id: "repo",
              label: "PwrAgnt",
              path: "/Users/huntharo/pwrdrvr/PwrAgnt",
              kind: "local",
            },
            {
              id: "stray-worktree",
              label: "Other",
              path: "/Users/huntharo/.codex/worktrees/zzzz/Other",
              kind: "worktree",
            },
          ],
        }),
      ],
    });

    const rowsWithThread = directories.filter((directory) =>
      directory.threadKeys.includes("codex:thread-1"),
    );
    expect(rowsWithThread).toHaveLength(1);
    expect(rowsWithThread[0]).toEqual(
      expect.objectContaining({
        key: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
        path: "/Users/huntharo/pwrdrvr/PwrAgnt",
      }),
    );
  });

  it("does not duplicate a worktree thread when the same-label stable repo path is ambiguous", () => {
    // Reproduces the macOS report (thread surfacing under two parent folders at
    // once). thread-1 carries a live worktree-rooted directory plus a backfilled
    // repo relationship. A sibling thread checked out the same project under a
    // different absolute path, so the per-label stable path is ambiguous and the
    // worktree descriptor can no longer remap onto the repo — leaving thread-1
    // with two distinct rows. The invariant must still home it on exactly one.
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "019ea569-b29b-78c3-8b2a-3fc135e4af1f",
          createdAt: 2_000,
          linkedDirectories: [
            {
              id: "live",
              label: "PwrAgnt",
              path: "/Users/huntharo/.codex/worktrees/mq4ow4zb/PwrAgnt",
              kind: "worktree",
            },
            {
              id: "backfill",
              label: "PwrAgnt",
              path: "/Users/huntharo/pwrdrvr/PwrAgnt",
              worktreePath: "/Users/huntharo/.codex/worktrees/mq4ow4zb/PwrAgnt",
              kind: "worktree",
            },
          ],
        }),
        buildThread({
          id: "sibling",
          createdAt: 1_000,
          linkedDirectories: [
            {
              id: "sibling-repo",
              label: "PwrAgnt",
              path: "/Users/huntharo/pwrdrvr-old/PwrAgnt",
              kind: "local",
            },
          ],
        }),
      ],
    });

    const threadKey = "codex:019ea569-b29b-78c3-8b2a-3fc135e4af1f";
    const rowsWithThread = directories.filter((directory) =>
      directory.threadKeys.includes(threadKey),
    );
    expect(rowsWithThread).toHaveLength(1);
    // The repo row (a real checkout) wins over the worktree row.
    expect(rowsWithThread[0]?.key).toBe("directory:/Users/huntharo/pwrdrvr/PwrAgnt");
  });

  it("keeps a worktree thread homed under its provider directory when another repo is attached", () => {
    const snapshot = buildNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1_000,
      firstSnapshot: false,
      overlayByThreadKey: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [
            {
              id: "directory:/Users/huntharo/pwrdrvr/agent-kit",
              label: "agent-kit",
              path: "/Users/huntharo/pwrdrvr/agent-kit",
              kind: "local",
            },
          ],
        },
      },
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [
        buildThread({
          projectKey: "/Users/huntharo/.codex/worktrees/mr03ibdv/PwrAgnt",
          linkedDirectories: [
            {
              id: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
              label: "PwrAgent",
              path: "/Users/huntharo/pwrdrvr/PwrAgent",
              worktreePath: "/Users/huntharo/.codex/worktrees/mr03ibdv/PwrAgnt",
              kind: "worktree",
            },
          ],
        }),
      ],
      unchanged: false,
    });

    const rowsWithThread = snapshot.directories.filter((directory) =>
      directory.threadKeys.includes("codex:thread-1"),
    );
    expect(rowsWithThread).toHaveLength(1);
    expect(rowsWithThread[0]).toEqual(
      expect.objectContaining({
        key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
        label: "PwrAgent",
      }),
    );
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

  it("normalizes profile-scoped Codex worktree paths even when no repository path is known", () => {
    const [thread] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {},
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [
        buildThread({
          linkedDirectories: [
            {
              id: "/Users/huntharo/.codex/profiles/sstk/worktrees/mp75j7bn/GifGrabber",
              label: "GifGrabber",
              path: "/Users/huntharo/.codex/profiles/sstk/worktrees/mp75j7bn/GifGrabber",
              kind: "local",
            },
          ],
        }),
      ],
    });

    expect(thread?.linkedDirectories).toEqual([
      {
        id: "/Users/huntharo/.codex/profiles/sstk/worktrees/mp75j7bn/GifGrabber",
        label: "GifGrabber",
        path: "/Users/huntharo/.codex/profiles/sstk/worktrees/mp75j7bn/GifGrabber",
        worktreePath: "/Users/huntharo/.codex/profiles/sstk/worktrees/mp75j7bn/GifGrabber",
        kind: "worktree",
      },
    ]);
  });

  it("keeps provider directories before user-attached extra directories", () => {
    const [thread] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [
            {
              id: "directory:/Users/huntharo/pwrdrvr/agent-kit",
              label: "agent-kit",
              path: "/Users/huntharo/pwrdrvr/agent-kit",
              kind: "local",
            },
          ],
        },
      },
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [
        buildThread({
          linkedDirectories: [
            {
              id: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
              label: "PwrAgent",
              path: "/Users/huntharo/pwrdrvr/PwrAgent",
              worktreePath: "/Users/huntharo/.codex/worktrees/mr03ibdv/PwrAgnt",
              kind: "worktree",
            },
          ],
        }),
      ],
    });

    expect(thread?.linkedDirectories.map((directory) => directory.label)).toEqual([
      "PwrAgent",
      "agent-kit",
    ]);
  });
});

/**
 * Unit D + Unit E coverage from plan
 * `2026-05-09-002-feat-directory-pinning-plan.md`. The two units are
 * tightly coupled — without Unit E's hash inclusion, Unit D's
 * pinnedRank attachment doesn't propagate to the renderer.
 *
 * Unit E is the GATE: if the directories hash doesn't include
 * `pinnedRank`, pin mutations look like no-ops because the overlay
 * store's `reconcileNavigationSnapshot` short-circuits on identical
 * hashes (overlay-store-sqlite.ts:161-174). Add a hash mutation
 * test before the rest of the feature lands.
 */
describe("buildDirectorySummaries — directory pin overlay (Unit D)", () => {
  it("attaches pinnedRank from the directoryOverlayByKey input", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgent",
              path: "/Users/me/code/PwrAgent",
              kind: "local",
            },
          ],
        }),
      ],
      directoryOverlayByKey: {
        "directory:/Users/me/code/PwrAgent": {
          directoryKey: "directory:/Users/me/code/PwrAgent",
          pinnedRank: "1024",
        },
      },
    });

    expect(directories).toEqual([
      expect.objectContaining({
        key: "directory:/Users/me/code/PwrAgent",
        pinnedRank: "1024",
      }),
    ]);
  });

  it("leaves pinnedRank undefined for directories with no overlay row", () => {
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgent",
              path: "/Users/me/code/PwrAgent",
              kind: "local",
            },
          ],
        }),
      ],
    });

    expect(directories[0]?.pinnedRank).toBeUndefined();
  });

  it("attaches pinnedRank to workspace pseudo-directories (workspaces are pinnable)", () => {
    // Policy: both `kind: "directory"` and `kind: "workspace"`
    // entries are user-pinnable. Workspaces are named entries the
    // user explicitly browses by clicking, so pinning them keeps
    // them at the top of the lens. Only `kind: "unlinked"` (the
    // catch-all bucket) is excluded.
    const directories = buildDirectorySummaries({
      threads: [
        buildThread({
          id: "thread-1",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "scratch",
              path: "/Users/me/.pwragent/projects/scratch",
              kind: "local",
            },
          ],
        }),
      ],
      directoryOverlayByKey: {
        "workspace:/Users/me/.pwragent/projects": {
          directoryKey: "workspace:/Users/me/.pwragent/projects",
          pinnedRank: "1024",
        },
      },
    });

    const workspace = directories.find((dir) => dir.kind === "workspace");
    expect(workspace).toBeDefined();
    expect(workspace?.pinnedRank).toBe("1024");
  });

  it("does NOT attach pinnedRank to the unlinked catch-all even with overlay row", () => {
    // Defensive: the IPC handler also blocks this, but the snapshot
    // builder enforces the same invariant so a misbehaving caller
    // (test, future contributor) can't accidentally pin a synthetic
    // catch-all entry.
    const directories = buildDirectorySummaries({
      threads: [
        // A thread with no linked directories rolls up into the
        // unlinked bucket.
        buildThread({
          id: "thread-unlinked",
          linkedDirectories: [],
        }),
      ],
      directoryOverlayByKey: {
        unlinked: {
          directoryKey: "unlinked",
          pinnedRank: "1024",
        },
      },
    });

    const unlinked = directories.find((dir) => dir.kind === "unlinked");
    expect(unlinked).toBeDefined();
    expect(unlinked?.pinnedRank).toBeUndefined();
  });
});

describe("buildNavigationSnapshotHash — directory pin invariant (Unit E, GATE)", () => {
  function buildBaseHashInput() {
    return {
      backend: "all" as const,
      threads: [],
      directories: [
        {
          key: "directory:/Users/me/code/PwrAgent",
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/me/code/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          latestUpdatedAt: 1_000,
        },
      ],
    };
  }

  it("changes the hash when a directory's pinnedRank changes (GATE)", () => {
    // This is the "fix the recurring footgun" assertion. Without
    // `pinnedRank` in the hashed directory slice, mutations don't
    // invalidate the snapshot cache and the renderer keeps stale
    // pin state. If this test fails, the feature looks broken from
    // the renderer's perspective even though the overlay store is
    // working correctly.
    const base = buildBaseHashInput();
    const unpinnedHash = buildNavigationSnapshotHash(base);

    const pinned = {
      ...base,
      directories: [
        { ...base.directories[0]!, pinnedRank: "1024" },
      ],
    };
    const pinnedHash = buildNavigationSnapshotHash(pinned);

    expect(pinnedHash).not.toBe(unpinnedHash);
  });

  it("changes the hash when the pinnedRank value changes (reorder case)", () => {
    const base = buildBaseHashInput();
    const rankA = {
      ...base,
      directories: [{ ...base.directories[0]!, pinnedRank: "1024" }],
    };
    const rankB = {
      ...base,
      directories: [{ ...base.directories[0]!, pinnedRank: "2048" }],
    };

    expect(buildNavigationSnapshotHash(rankA)).not.toBe(
      buildNavigationSnapshotHash(rankB),
    );
  });

  it("produces identical hashes for identical inputs", () => {
    const input = buildBaseHashInput();
    expect(buildNavigationSnapshotHash(input)).toBe(
      buildNavigationSnapshotHash(input),
    );
  });
});
