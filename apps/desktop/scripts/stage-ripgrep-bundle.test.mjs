import { describe, expect, it } from "vitest";
import {
  expectedChecksum,
  resolveCurrentRipgrepPlatform,
  resolveRipgrepAssetPlatforms,
} from "./stage-ripgrep-bundle.mjs";

describe("ripgrep bundle staging", () => {
  it("maps supported host architectures to pinned asset platforms", () => {
    expect(resolveCurrentRipgrepPlatform("darwin", "arm64")).toBe("macos-arm64");
    expect(resolveCurrentRipgrepPlatform("darwin", "x64")).toBe("macos-x86_64");
    expect(resolveCurrentRipgrepPlatform("linux", "arm64")).toBe("linux-aarch64");
    expect(resolveCurrentRipgrepPlatform("linux", "x64")).toBe("linux-x86_64");
    expect(resolveCurrentRipgrepPlatform("win32", "x64")).toBe("windows-x86_64");
  });

  it("stages both macOS architectures for a universal package", () => {
    expect(resolveRipgrepAssetPlatforms(
      "macos-universal",
      "darwin",
      "arm64",
    )).toEqual(["macos-arm64", "macos-x86_64"]);
  });

  it("validates official per-archive checksum files", () => {
    const digest = "a".repeat(64);
    expect(expectedChecksum(
      `${digest}  ripgrep-15.2.0-aarch64-apple-darwin.tar.gz\n`,
      "ripgrep-15.2.0-aarch64-apple-darwin.tar.gz",
    )).toBe(digest);
    expect(() => expectedChecksum(
      `${digest}  another-asset.tar.gz\n`,
      "ripgrep.tar.gz",
    )).toThrow("Invalid checksum");
  });
});
