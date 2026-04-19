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
});
