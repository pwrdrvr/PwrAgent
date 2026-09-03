import path from "node:path";
import { describe, expect, it } from "vitest";
import { managedCodexTagForCommand } from "../codex-build-channel";

const managedRoot = path.join("/tmp", "pwragent-root", "agents", "codex");
const options = { managedRoot };

describe("managedCodexTagForCommand", () => {
  it("recovers the release tag from a managed install path", () => {
    expect(managedCodexTagForCommand(
      path.join(managedRoot, "versions", "pwragent-v0.149.0-pwragent.2", "codex"),
      options,
    )).toBe("pwragent-v0.149.0-pwragent.2");
  });

  it("claims a superseded managed version, not only the newest", () => {
    // Provenance is a property of the binary. An operator pinned to an older
    // tag is still on the PwrAgent channel, and must not be described as
    // running OpenAI's release because the channel moved on without them.
    expect(managedCodexTagForCommand(
      path.join(managedRoot, "versions", "pwragent-v0.148.0-pwragent.1", "codex"),
      options,
    )).toBe("pwragent-v0.148.0-pwragent.1");
  });

  it("has no tag for the version directory itself or anything outside it", () => {
    expect(managedCodexTagForCommand(
      path.join(managedRoot, "versions", "pwragent-v0.149.0-pwragent.2"),
      options,
    )).toBeUndefined();
    expect(managedCodexTagForCommand(
      path.join(managedRoot, "managed-release.json"),
      options,
    )).toBeUndefined();
    expect(managedCodexTagForCommand("/opt/homebrew/bin/codex", options))
      .toBeUndefined();
    // A sibling directory whose name merely starts with the managed root's.
    expect(managedCodexTagForCommand(
      `${managedRoot}-backup/versions/pwragent-v0.149.0-pwragent.2/codex`,
      options,
    )).toBeUndefined();
    expect(managedCodexTagForCommand(undefined, options)).toBeUndefined();
  });
});
