import { describe, expect, it } from "vitest";
import { selectGrokBundleAsset } from "./stage-grok-bundle.mjs";

const universal = "pwragent-grok-1.0.0-pwragent.2-macos-universal.tar.gz";
const arm64 = universal.replace("macos-universal", "macos-aarch64");
const manifest = { assets: { "macos-universal": universal } };
const checksum = (name) => `${"a".repeat(64)}  ${name}\n`;

describe("Grok arm64 availability", () => {
  it("keeps old pinned releases usable with universal Grok", () => {
    expect(selectGrokBundleAsset(manifest, "macos-aarch64", checksum(universal))).toBe(universal);
  });
  it("selects arm64 only when the exact pinned release asset exists", () => {
    expect(selectGrokBundleAsset(manifest, "macos-aarch64", checksum(universal) + checksum(arm64), [universal, arm64])).toBe(arm64);
    expect(selectGrokBundleAsset(manifest, "macos-aarch64", checksum(universal) + checksum(arm64), [universal])).toBe(universal);
  });
  it("fails when an existing arm64 asset has missing or malformed checksum metadata", () => {
    expect(() => selectGrokBundleAsset(manifest, "macos-aarch64", checksum(universal), [universal, arm64])).toThrow("SHA256SUMS does not contain");
    expect(() => selectGrokBundleAsset(manifest, "macos-aarch64", checksum(universal) + `bad  ${arm64}\n`, [universal, arm64])).toThrow("SHA256SUMS does not contain");
  });
  it("does not mistake another version's asset for the pinned one", () => {
    expect(selectGrokBundleAsset(manifest, "macos-aarch64", checksum(universal), [arm64.replace(".2-", ".3-")])).toBe(universal);
  });
  it("preserves universal selection even when arm64 is available", () => {
    expect(selectGrokBundleAsset(manifest, "macos-universal", checksum(universal) + checksum(arm64), [universal, arm64])).toBe(universal);
  });
});
