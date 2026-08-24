import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  prependBundledToolsToPath,
  resolveBundledToolsDirectory,
} from "../bundled-tools";

function writeRipgrep(directory: string, executable = "rg"): void {
  mkdirSync(directory, { recursive: true });
  const executablePath = path.join(directory, executable);
  writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
  if (executable !== "rg.exe") {
    chmodSync(executablePath, 0o755);
  }
}

describe("bundled tools", () => {
  it("prefers the packaged resources directory", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pwragent-tools-"));
    try {
      const packagedDirectory = path.join(tempRoot, "resources", "tools");
      const developmentDirectory = path.join(
        tempRoot,
        "build",
        "bundled-tools",
        "ripgrep",
      );
      writeRipgrep(packagedDirectory);
      writeRipgrep(developmentDirectory);

      expect(resolveBundledToolsDirectory({
        developmentMode: true,
        developmentRoot: tempRoot,
        resourcesPath: path.join(tempRoot, "resources"),
      })).toBe(packagedDirectory);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the staged development bundle when packaged resources have no ripgrep", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pwragent-tools-"));
    try {
      const developmentDirectory = path.join(
        tempRoot,
        "apps",
        "desktop",
        "build",
        "bundled-tools",
        "ripgrep",
      );
      writeRipgrep(developmentDirectory);

      expect(resolveBundledToolsDirectory({
        developmentMode: true,
        developmentRoot: tempRoot,
        resourcesPath: path.join(tempRoot, "electron-resources"),
      })).toBe(developmentDirectory);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("leaves PATH unchanged when the bundle is missing", () => {
    const env = { PATH: "/usr/bin:/bin" };

    expect(prependBundledToolsToPath(env, {
      directory: "/missing/pwragent/tools",
    })).toBe(env);
  });

  it("does not trust a working-directory tool in a packaged process", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pwragent-tools-"));
    try {
      const developmentDirectory = path.join(
        tempRoot,
        "build",
        "bundled-tools",
        "ripgrep",
      );
      writeRipgrep(developmentDirectory);

      expect(resolveBundledToolsDirectory({
        developmentMode: false,
        developmentRoot: tempRoot,
        resourcesPath: path.join(tempRoot, "missing-resources"),
      })).toBeUndefined();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("deduplicates Windows PATH entries case-insensitively", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pwragent-tools-"));
    try {
      writeRipgrep(tempRoot, "rg.exe");
      const env = {
        Path: `C:\\Windows;${tempRoot.toUpperCase()};C:\\Tools`,
      };

      expect(prependBundledToolsToPath(env, {
        directory: tempRoot,
        platform: "win32",
      })).toEqual({
        Path: `${tempRoot};C:\\Windows;C:\\Tools`,
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
