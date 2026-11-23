import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildPwrAgentChildProcessEnv } from "../child-process-env.js";
import type { AcpLaunchDescriptor } from "./acp-launch-descriptor.js";
import { normalizeAntigravityUsageStatus, type AcpProviderStatus } from "./acp-provider-status.js";
import {
  holdAntigravityExecutable,
  isAntigravityVersion,
  MANAGED_ANTIGRAVITY_ENV,
} from "./antigravity-runtime-retention.js";

const execFile = promisify(execFileCallback);

export async function readAntigravityUsage(
  launch: AcpLaunchDescriptor,
): Promise<AcpProviderStatus | undefined> {
  // The companion CLI uses the same sign-in and installed binary as agy acp.
  // A scratch cwd keeps the read out of the project and its local configuration.
  const cwd = await mkdtemp(path.join(tmpdir(), "pwragent-agy-usage-"));
  const env = buildPwrAgentChildProcessEnv(process.env, launch.env);
  try {
    const hold = process.platform === "win32"
      ? undefined
      : await holdAntigravityExecutable(
        launch.command, { cwd: launch.cwd, env }, launch.managedAntigravityFallback,
      );
    try {
      const command = hold?.command ?? launch.command;
      const options = {
        cwd,
        env: hold?.managed ? { ...env, ...MANAGED_ANTIGRAVITY_ENV } : env,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      };
      const version = (await execFile(command, ["--version"], { ...options, timeout: 5_000 })).stdout.trim();
      if (!supportsHeadlessUsage(version)) return undefined;
      const { stdout } = await execFile(
        command,
        ["--print", "/usage", "--output-format", "json", "--print-timeout", "15s"],
        { ...options, timeout: 20_000 },
      );
      return normalizeAntigravityUsageStatus(JSON.parse(stdout));
    } finally {
      hold?.release();
    }
  } catch {
    // CLI errors may include raw output. Keep them out of provider status and logs.
    return undefined;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function supportsHeadlessUsage(version: string): boolean {
  if (!isAntigravityVersion(version)) return false;
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  // 1.1.11 made /usage a read-only print command that bypasses model turns.
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11)));
}
