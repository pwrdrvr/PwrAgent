import { describe, expect, it } from "vitest";
import {
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

  it("does not read a thread scope as a launchpad", () => {
    expect(getEditableLaunchpadDirectoryKey("thread:codex:thread-1")).toBeUndefined();
    expect(getLaunchpadScopeDirectoryKey("thread:codex:thread-1")).toBeUndefined();
  });
});
