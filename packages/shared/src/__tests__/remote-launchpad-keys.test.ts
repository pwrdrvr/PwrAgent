import { describe, expect, it } from "vitest";
import type { DirectoryLaunchpadOverlayState } from "../contracts/navigation";
import {
  buildRemoteLaunchpadStorageKey,
  isRemoteLaunchpadStorageKey,
  launchpadStorageKey,
  parseRemoteLaunchpadStorageKey,
} from "../contracts/navigation";
import { buildDirectorySummaries } from "../directory-navigation";

const owner = { scope: "remote" as const, instanceId: "owner:one" };

function draft(directoryKey: string, prompt: string): DirectoryLaunchpadOverlayState {
  return {
    directoryKey,
    directoryKind: "directory",
    directoryLabel: "app",
    directoryPath: "/Users/fixture/src/app",
    backend: "codex",
    executionMode: "default",
    prompt,
    workMode: "local",
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("remote launchpad storage keys", () => {
  it("names the owner for a peer's directory and nothing else", () => {
    const key = launchpadStorageKey("directory:/Users/fixture/src/app", owner);
    expect(key).not.toBe("directory:/Users/fixture/src/app");
    expect(parseRemoteLaunchpadStorageKey(key)).toEqual({
      instanceId: "owner:one",
      directoryKey: "directory:/Users/fixture/src/app",
    });
    expect(isRemoteLaunchpadStorageKey(key)).toBe(true);

    // This machine's own draft, and a draft with no owner, keep the key.
    expect(launchpadStorageKey("directory:/a", { scope: "local" })).toBe("directory:/a");
    expect(launchpadStorageKey("directory:/a", undefined)).toBe("directory:/a");
    // A sub-thread key already names the parent's machine.
    expect(launchpadStorageKey("subthread:codex:parent:new-worktree:owner", owner))
      .toBe("subthread:codex:parent:new-worktree:owner");

    // Two peers with one home layout get two rows.
    expect(buildRemoteLaunchpadStorageKey("a", "workspace:/x"))
      .not.toBe(buildRemoteLaunchpadStorageKey("b", "workspace:/x"));
    expect(isRemoteLaunchpadStorageKey("directory:/peer:x")).toBe(false);
    expect(parseRemoteLaunchpadStorageKey("peer:owner")).toBeUndefined();
  });

  it("keeps a peer's draft out of this machine's directory list", () => {
    const remoteKey = launchpadStorageKey("directory:/Users/fixture/src/elsewhere", owner);
    const summaries = buildDirectorySummaries({
      threads: [],
      launchpadsByKey: {
        "directory:/Users/fixture/src/app": draft("directory:/Users/fixture/src/app", "local"),
        [remoteKey]: {
          ...draft(remoteKey, "remote"),
          directoryPath: "/Users/fixture/src/elsewhere",
        },
      },
    });

    expect(summaries.map((summary) => summary.key)).toEqual([
      "directory:/Users/fixture/src/app",
    ]);
  });
});
