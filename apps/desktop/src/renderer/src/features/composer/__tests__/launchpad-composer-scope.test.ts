import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLaunchpadComposerScopeKey,
  buildStartingLaunchpadComposerScopeKey,
  getEditableLaunchpadDirectoryKey,
  getEditableLaunchpadOwner,
  getLaunchpadScopeDirectoryKey,
  getLaunchpadScopeStorageKey,
  isStartingLaunchpadComposerScopeKey,
} from "../launchpad-composer-scope";

describe("launchpad composer scopes", () => {
  const directoryKey = "directory:/Users/fixture-user/github/PwrSnap";

  it("keeps a starting thread's scope apart from the directory's draft", () => {
    const starting = buildStartingLaunchpadComposerScopeKey("abc1", directoryKey);

    expect(starting.startsWith("launchpad:")).toBe(true);
    expect(isStartingLaunchpadComposerScopeKey(starting)).toBe(true);
    expect(getEditableLaunchpadDirectoryKey(starting)).toBeUndefined();
    expect(getLaunchpadScopeDirectoryKey(starting)).toBe(directoryKey);
  });

  it("reads the directory's own draft scope as editable", () => {
    const editable = `launchpad:${directoryKey}`;

    expect(isStartingLaunchpadComposerScopeKey(editable)).toBe(false);
    expect(getEditableLaunchpadDirectoryKey(editable)).toBe(directoryKey);
    expect(getLaunchpadScopeDirectoryKey(editable)).toBe(directoryKey);
  });

  it("keeps a peer's draft apart from this machine's draft for the same key", () => {
    const owner = { scope: "remote" as const, instanceId: "owner_one" };
    const local = buildLaunchpadComposerScopeKey(directoryKey, undefined);
    const remote = buildLaunchpadComposerScopeKey(directoryKey, owner);

    expect(local).toBe(`launchpad:${directoryKey}`);
    expect(remote).not.toBe(local);
    expect(remote).not.toBe(
      buildLaunchpadComposerScopeKey(directoryKey, { scope: "remote", instanceId: "owner_two" }),
    );
    // Edits still go out under the owner's key.
    expect(getEditableLaunchpadDirectoryKey(remote)).toBe(directoryKey);
    expect(getLaunchpadScopeDirectoryKey(remote)).toBe(directoryKey);
  });

  it("names the owner and storage key a scope's draft belongs to", () => {
    const owner = { scope: "remote" as const, instanceId: "owner_one" };
    const local = buildLaunchpadComposerScopeKey(directoryKey, { scope: "local" });
    const remote = buildLaunchpadComposerScopeKey(directoryKey, owner);
    const starting = buildStartingLaunchpadComposerScopeKey("abc1", directoryKey);

    expect(getEditableLaunchpadOwner(local)).toEqual({ scope: "local" });
    expect(getEditableLaunchpadOwner(remote)).toEqual(owner);
    expect(getEditableLaunchpadOwner(starting)).toBeUndefined();
    expect(getEditableLaunchpadOwner("thread:codex:thread-1")).toBeUndefined();

    // Recovery records keep the two drafts apart.
    expect(getLaunchpadScopeStorageKey(local)).toBe(directoryKey);
    expect(getLaunchpadScopeStorageKey(remote)).toBe(remote.slice("launchpad:".length));
    expect(getLaunchpadScopeStorageKey(remote)).not.toBe(getLaunchpadScopeStorageKey(local));
    expect(getLaunchpadScopeStorageKey(starting)).toBe(directoryKey);
  });

  describe("in a window fronting a peer", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("names that peer when the launchpad names no owner", () => {
      vi.stubGlobal("window", {
        __pwragentFederationTarget: { scope: "remote", instanceId: "owner_one" },
      });

      expect(buildLaunchpadComposerScopeKey(directoryKey)).toBe(
        buildLaunchpadComposerScopeKey(directoryKey, { scope: "remote", instanceId: "owner_one" }),
      );
      expect(buildLaunchpadComposerScopeKey(directoryKey)).not.toBe(`launchpad:${directoryKey}`);
      // A launchpad that names this machine keeps its plain scope.
      expect(buildLaunchpadComposerScopeKey(directoryKey, { scope: "local" }))
        .toBe(`launchpad:${directoryKey}`);
    });
  });

  it("does not read a thread scope as a launchpad", () => {
    expect(getEditableLaunchpadDirectoryKey("thread:codex:thread-1")).toBeUndefined();
    expect(getLaunchpadScopeDirectoryKey("thread:codex:thread-1")).toBeUndefined();
  });
});
