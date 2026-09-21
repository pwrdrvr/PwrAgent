import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledGitFiles, verifyBundledGit } from "./verify-bundled-git.mjs";
import { pruneMacCredentialManager } from "./beforepack-bundled-git.mjs";

describe("packaged Git distribution", () => {
  it.each([["x64", "mingw64"], ["arm64", "clangarm64"], ["ia32", "mingw32"]])(
    "verifies the Windows %s LFS helper in its own distribution", (arch, prefix) => {
      expect(bundledGitFiles("root", "win32", arch)).toEqual({
        git: join("root", "cmd/git.exe"),
        lfs: join("root", `${prefix}/libexec/git-core/git-lfs.exe`),
      });
    },
  );

  it("fails before probing system Git when packaged LFS is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pwragent-git-package-"));
    try {
      const files = bundledGitFiles(join(root, "git"), "linux", "x64");
      mkdirSync(dirname(files.git), { recursive: true });
      writeFileSync(files.git, "not an executable");
      expect(() => verifyBundledGit(root, { platform: "linux", arch: "x64" })).toThrow(files.lfs);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves Git, LFS and keychain helpers when pruning unmergeable macOS GCM files", () => {
    const root = mkdtempSync(join(tmpdir(), "pwragent-git-prune-"));
    const core = join(root, "libexec/git-core");
    mkdirSync(core, { recursive: true });
    const keep = ["git", "git-lfs", "git-credential-osxkeychain", "scalar"];
    const remove = ["git-credential-manager", "git-credential-manager.dll", "System.Runtime.dll"];
    try {
      for (const name of [...keep, ...remove]) writeFileSync(join(core, name), name);
      pruneMacCredentialManager(root);
      for (const name of keep) expect(existsSync(join(core, name))).toBe(true);
      for (const name of remove) expect(existsSync(join(core, name))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
