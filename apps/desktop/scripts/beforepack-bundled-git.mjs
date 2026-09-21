import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bundledGitFiles } from "./verify-bundled-git.mjs";

const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "arm", 3: "arm64" };

export function pruneMacCredentialManager(root) {
  const core = join(root, "libexec", "git-core");
  // As in PwrGit, .NET's per-arch data files cannot be lipo-merged. Keep Git,
  // LFS, credential helpers such as osxkeychain, scalar, and merge tools.
  for (const entry of readdirSync(core)) {
    if (!/^(git|scalar|mergetools)/.test(entry) || entry.startsWith("git-credential-manager")) {
      rmSync(join(core, entry), { recursive: true, force: true });
    }
  }
}

export default function beforePack(context) {
  const arch = ARCH_NAMES[context.arch];
  if (!arch) throw new Error(`Unsupported bundled Git architecture: ${context.arch}`);
  const platform = context.electronPlatformName;
  if (platform !== process.platform) {
    throw new Error("Bundled Git packaging requires a host matching the target platform.");
  }
  const appDir = context.packager.info.appDir;
  const dugiteDir = join(appDir, "node_modules", "dugite");
  const script = join(dugiteDir, "script", "download-git.js");
  if (!existsSync(script)) throw new Error(`Missing Dugite downloader: ${script}`);
  // Download into the production deploy stage only. The downloader verifies
  // the pinned archive checksum and replaces the previous architecture.
  const result = spawnSync(process.execPath, [script], {
    cwd: dugiteDir,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_arch: arch,
      DUGITE_CACHE_DIR: process.env.DUGITE_CACHE_DIR ?? join(tmpdir(), "pwragent-dugite-cache"),
    },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Bundled Git staging failed for ${platform}-${arch}: ${result.error?.message ?? result.status}`);
  }
  const root = join(dugiteDir, "git");
  for (const file of Object.values(bundledGitFiles(root, platform, arch))) {
    if (!existsSync(file)) throw new Error(`Missing bundled Git component: ${file}`);
  }
  if (platform === "darwin") pruneMacCredentialManager(root);
}
