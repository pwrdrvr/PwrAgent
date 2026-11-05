import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stageNativePrebuilds } from "./stage-native-prebuilds.mjs";
import { stageRuntime } from "./stage-runtime.mjs";
import { buildMcpIpcRelay } from "./build-mcp-ipc-relay.mjs";
import { bundledGitFiles } from "./verify-bundled-git.mjs";

const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "arm", 3: "arm64", 4: "universal" };

export default async function beforePack(context) {
  const arch = ARCH_NAMES[context.arch];
  if (arch === "universal") return;
  if (!arch) throw new Error(`Unsupported bundled Git architecture: ${context.arch}`);
  const platform = context.electronPlatformName;
  if (platform !== process.platform) {
    throw new Error("Bundled Git packaging requires a host matching the target platform.");
  }
  const appDir = context.packager.info.appDir;
  buildMcpIpcRelay({ arch, outputRoot: appDir, packaged: true });
  stageNativePrebuilds({ appDir, platform, arch });
  const dugiteDir = join(appDir, "node_modules", "dugite");
  if (platform !== "win32") {
    await stageRuntime({ manifestPath: join(appDir, "custom-git-runtime.json"), platform, arch,
      output: join(dugiteDir, "git"), cache: process.env.PWRGIT_RUNTIME_CACHE || undefined });
    return;
  }
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
}
