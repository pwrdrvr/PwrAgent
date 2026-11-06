import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readRuntimeManifest, verifyRuntime } from "./stage-runtime.mjs";
import { spawnSync } from "node:child_process";

export function bundledGitFiles(root, platform, arch) {
  const prefix = arch === "arm64" ? "clangarm64" : arch === "ia32" ? "mingw32" : "ucrt64";
  return {
    git: join(root, platform === "win32" ? "cmd/git.exe" : "bin/git"),
    lfs: join(root, platform === "win32" ? `${prefix}/libexec/git-core/git-lfs.exe` : "libexec/git-core/git-lfs"),
  };
}

export function verifyBundledGit(resources, { platform = process.platform, arch = process.arch } = {}) {
  const root = join(resources, "git");
  const files = bundledGitFiles(root, platform, arch);
  for (const file of [...Object.values(files), ...["COPYING", "LICENSE.git-lfs", "SOURCES"].map((name) => join(root, name))]) {
    if (!existsSync(file)) throw new Error(`Packaged Git runtime is incomplete: ${file}`);
  }
  if (platform !== "win32") {
    const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "..", "custom-git-runtime.json");
    verifyRuntime(root, readRuntimeManifest(manifestPath, platform, arch));
  }
  // Verify the packaged tools themselves, never a PATH lookup. LFS supports
  // `version` directly, so this probe cannot succeed via a system fallback.
  for (const [file, args, pattern] of [[files.git, ["--version"], /^git version /], [files.lfs, ["version"], /^git-lfs\//]]) {
    const result = spawnSync(file, args, { encoding: "utf8", timeout: 10_000, windowsHide: true });
    if (result.status !== 0 || !pattern.test(result.stdout ?? "")) {
      throw new Error(`Bundled runtime probe failed: ${file}: ${result.error?.message ?? result.stderr}`);
    }
  }
  return files;
}
