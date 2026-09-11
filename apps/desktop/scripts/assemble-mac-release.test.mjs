import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { assembleMacRelease } from "./assemble-mac-release.mjs";

const require = createRequire(import.meta.url);
const { MacUpdater } = require("electron-updater/out/MacUpdater.js");
const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pwragent-mac-release-"));
  roots.push(root);
  const directories = ["universal", "arm64"].map((arch) => {
    const directory = join(root, arch);
    mkdirSync(directory);
    const url = `PwrAgent-1.2.0-${arch}-mac.zip`;
    const bytes = Buffer.from(`ZIP fixture ${arch}`);
    writeFileSync(join(directory, url), bytes);
    writeFileSync(join(directory, `${url}.blockmap`), "blockmap fixture");
    writeFileSync(join(directory, `PwrAgent-1.2.0-${arch}.dmg`), `DMG ${arch}`);
    writeFileSync(join(directory, "latest-mac.yml"), JSON.stringify({
      version: "1.2.0",
      files: [{ url, size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64") }],
    }));
    return directory;
  });
  return directories;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("paired macOS release assembly", () => {
  it("preserves legacy universal routing and selects arm64 only on Apple Silicon", () => {
    const dirs = fixture();
    const info = assembleMacRelease(...dirs);
    expect(info.path).toBe("PwrAgent-1.2.0-universal-mac.zip");
    expect(info.sha512).toBe(info.files[0].sha512);
    const resolved = info.files.map((file) => ({ info: file, url: new URL(file.url, "https://example.test/") }));
    expect(MacUpdater.filterFilesForArch(resolved, true)).toEqual([resolved[1]]);
    expect(MacUpdater.filterFilesForArch(resolved, false)).toEqual([resolved[0]]);
    expect(MacUpdater.filterFilesForArch([resolved[0]], true)).toEqual([resolved[0]]);
    expect(readFileSync(join(dirs[0], "PwrAgent.dmg"), "utf8")).toBe("DMG universal");
    expect(readFileSync(join(dirs[0], "PwrAgent-arm64.dmg"), "utf8")).toBe("DMG arm64");
    expect(readFileSync(join(dirs[0], "PwrAgent-macos-SHA256SUMS"), "utf8").trim().split("\n")).toHaveLength(9);
  });

  it("rejects a corrupted ZIP before merging or publishing metadata", () => {
    const dirs = fixture();
    writeFileSync(join(dirs[1], "PwrAgent-1.2.0-arm64-mac.zip"), "corrupt");
    expect(() => assembleMacRelease(...dirs)).toThrow("hash or size");
  });

  it("rejects missing blockmaps", () => {
    const dirs = fixture();
    rmSync(join(dirs[1], "PwrAgent-1.2.0-arm64-mac.zip.blockmap"));
    expect(() => assembleMacRelease(...dirs)).toThrow("Missing");
  });

  it("rejects cross-architecture file names", () => {
    const dirs = fixture();
    writeFileSync(join(dirs[1], "latest-mac.yml"), readFileSync(join(dirs[0], "latest-mac.yml")));
    expect(() => assembleMacRelease(...dirs)).toThrow("Expected PwrAgent-1.2.0-arm64-mac.zip");
  });
});
