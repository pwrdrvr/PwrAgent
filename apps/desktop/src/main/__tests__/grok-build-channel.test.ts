import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPwrAgentSuppliedGrokCommand,
  managedGrokTagForCommand,
} from "../acp/grok-build-channel";

const managedRoot = path.join("/tmp", "pwragent-root", "agents", "grok");
const resourcesPath = path.join("/Applications", "PwrAgent.app", "Contents", "Resources");
const options = { managedRoot, resourcesPath };

describe("managedGrokTagForCommand", () => {
  it("recovers the release tag from a managed install path", () => {
    expect(managedGrokTagForCommand(
      path.join(managedRoot, "versions", "pwragent-v1.0.4-pwragent.2", "grok"),
      options,
    )).toBe("pwragent-v1.0.4-pwragent.2");
  });

  it("has no tag for the version directory itself or anything outside it", () => {
    expect(managedGrokTagForCommand(
      path.join(managedRoot, "versions", "pwragent-v1.0.4-pwragent.2"),
      options,
    )).toBeUndefined();
    expect(managedGrokTagForCommand(
      path.join(managedRoot, "managed-release.json"),
      options,
    )).toBeUndefined();
    expect(managedGrokTagForCommand("/Users/me/.grok/bin/grok", options))
      .toBeUndefined();
    expect(managedGrokTagForCommand(undefined, options)).toBeUndefined();
  });
});

describe("isPwrAgentSuppliedGrokCommand", () => {
  it("claims managed downloads and the packaged bundle copy", () => {
    expect(isPwrAgentSuppliedGrokCommand(
      path.join(managedRoot, "versions", "pwragent-v1.0.4-pwragent.2", "grok"),
      options,
    )).toBe(true);
    expect(isPwrAgentSuppliedGrokCommand(
      path.join(resourcesPath, "agents", "grok", "grok"),
      options,
    )).toBe(true);
  });

  it("claims a superseded managed version, not only the newest", () => {
    // The whole point: provenance is a property of the binary. An operator
    // pinned to an older tag is still on the PwrAgent channel, and must not
    // collect an xAI update notice because the channel moved on without them.
    expect(isPwrAgentSuppliedGrokCommand(
      path.join(managedRoot, "versions", "pwragent-v1.0.0-pwragent.1", "grok"),
      options,
    )).toBe(true);
  });

  it("leaves vendor installs alone", () => {
    expect(isPwrAgentSuppliedGrokCommand("/Users/me/.grok/bin/grok", options))
      .toBe(false);
    expect(isPwrAgentSuppliedGrokCommand("/opt/homebrew/bin/grok", options))
      .toBe(false);
    // A sibling directory whose name merely starts with the managed root's.
    expect(isPwrAgentSuppliedGrokCommand(
      `${managedRoot}-backup/versions/pwragent-v1.0.4-pwragent.2/grok`,
      options,
    )).toBe(false);
    expect(isPwrAgentSuppliedGrokCommand(undefined, options)).toBe(false);
  });
});
