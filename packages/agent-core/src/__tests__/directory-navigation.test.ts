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
});
