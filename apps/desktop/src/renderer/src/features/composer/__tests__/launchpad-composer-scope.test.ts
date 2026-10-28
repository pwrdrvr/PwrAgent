import { afterEach, describe, expect, it } from "vitest";
import {
  buildLaunchpadComposerScopeKey,
  buildStartingLaunchpadComposerScopeKey,
  getEditableLaunchpadDirectoryKey,
  getLaunchpadScopeDirectoryKey,
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

  describe("in a window fronting a peer", () => {
    const rendererWindow = globalThis as typeof globalThis & {
      __pwragentFederationTarget?: unknown;
    };
    afterEach(() => {
      delete rendererWindow.__pwragentFederationTarget;
    });

    it("names that peer by default", () => {
      rendererWindow.__pwragentFederationTarget = { scope: "remote", instanceId: "owner_one" };

      expect(buildLaunchpadComposerScopeKey(directoryKey)).toBe(
        buildLaunchpadComposerScopeKey(directoryKey, { scope: "remote", instanceId: "owner_one" }),
      );
      expect(buildLaunchpadComposerScopeKey(directoryKey)).not.toBe(`launchpad:${directoryKey}`);
    });
  });

  it("does not read a thread scope as a launchpad", () => {
    expect(getEditableLaunchpadDirectoryKey("thread:codex:thread-1")).toBeUndefined();
    expect(getLaunchpadScopeDirectoryKey("thread:codex:thread-1")).toBeUndefined();
  });
});
