import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import dugite from "dugite";
import { describe, expect, it } from "vitest";
import { bundledGitFiles, verifyBundledGit } from "./verify-bundled-git.mjs";

describe("packaged Git distribution", () => {
  it.each([["x64", "ucrt64"], ["arm64", "clangarm64"], ["ia32", "mingw32"]])(
    "verifies the Windows %s LFS helper in its own distribution", (arch, prefix) => {
      expect(bundledGitFiles("root", "win32", arch)).toEqual({
        git: join("root", "cmd/git.exe"),
        lfs: join("root", `${prefix}/libexec/git-core/git-lfs.exe`),
      });
    },
  );

  it.each(["darwin", "linux"])("preserves the %s Git and LFS layout", (platform) => {
    expect(bundledGitFiles("root", platform, "x64")).toEqual({
      git: join("root", "bin/git"),
      lfs: join("root", "libexec/git-core/git-lfs"),
    });
  });

  it("matches the installed Dugite resolver for the packaging host", () => {
    const root = resolve("staged-native", "node_modules", "dugite", "git");
    // CI runs on Windows too: a dependency layout change must fail here
    // before a release reaches beforePack. Ignore inherited Git overrides.
    expect(bundledGitFiles(root, process.platform, process.arch)).toEqual({
      git: dugite.resolveGitBinary(root),
      lfs: join(dugite.resolveGitExecPath(root, ""), process.platform === "win32" ? "git-lfs.exe" : "git-lfs"),
    });
  });

  it.each(["linux", "win32"])("fails before probing system Git when packaged %s LFS is missing", (platform) => {
    const root = mkdtempSync(join(tmpdir(), "pwragent-git-package-"));
    try {
      const files = bundledGitFiles(join(root, "git"), platform, "x64");
      mkdirSync(dirname(files.git), { recursive: true });
      writeFileSync(files.git, "not an executable");
      expect(() => verifyBundledGit(root, { platform, arch: "x64" })).toThrow(files.lfs);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
