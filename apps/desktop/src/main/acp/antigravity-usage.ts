import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { createCommandInvocation } from "@pwrdrvr/agent-transport";
import { buildPwrAgentChildProcessEnv } from "../child-process-env.js";
import { terminateOwnedProcessTree, type OwnedChildProcess } from "../process-tree.js";
import type { AcpLaunchDescriptor } from "./acp-launch-descriptor.js";
import { normalizeAntigravityUsageStatus, type AcpProviderStatus } from "./acp-provider-status.js";
import {
  holdAntigravityExecutable,
  isAntigravityVersion,
  MANAGED_ANTIGRAVITY_ENV,
} from "./antigravity-runtime-retention.js";

const MAX_OUTPUT_BYTES = 256 * 1024;
const PROCESS_STOP_OPTIONS = { gracefulTimeoutMs: 1_000, forceTimeoutMs: 2_000 };

type UsageProcess = OwnedChildProcess & { stdout: Readable | null };
type UsageProcessOptions = {
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[], options: SpawnOptions) => UsageProcess;
  terminate?: typeof terminateOwnedProcessTree;
};

export async function readAntigravityUsage(
  launch: AcpLaunchDescriptor,
  signal: AbortSignal,
  processOptions: UsageProcessOptions = {},
): Promise<AcpProviderStatus | undefined> {
  if (signal.aborted) return undefined;
  // The companion CLI uses the same sign-in and installed binary as agy acp.
  // A scratch cwd keeps the read out of the project and its local configuration.
  const cwd = await mkdtemp(path.join(tmpdir(), "pwragent-agy-usage-"));
  const env = buildPwrAgentChildProcessEnv(process.env, launch.env);
  try {
    const hold = (processOptions.platform ?? process.platform) === "win32"
      ? undefined
      : await holdAntigravityExecutable(
        launch.command, { cwd: launch.cwd, env }, launch.managedAntigravityFallback,
      );
    try {
      const command = {
        command: hold?.command ?? launch.command,
        cwd,
        env: hold?.managed ? { ...env, ...MANAGED_ANTIGRAVITY_ENV } : env,
      };
      const version = await readCommandOutput(command, ["--version"], signal, 5_000, processOptions);
      if (!version || !supportsHeadlessUsage(version.trim())) return undefined;
      const stdout = await readCommandOutput(
        command,
        ["--print", "/usage", "--output-format", "json", "--print-timeout", "15s"],
        signal, 20_000, processOptions,
      );
      if (!stdout || signal.aborted) return undefined;
      try {
        return normalizeAntigravityUsageStatus(JSON.parse(stdout));
      } catch {
        return undefined;
      }
    } finally {
      hold?.release();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function readCommandOutput(
  selected: { command: string; cwd: string; env: NodeJS.ProcessEnv },
  args: string[],
  ownerSignal: AbortSignal,
  timeoutMs: number,
  options: UsageProcessOptions,
): Promise<string | undefined> {
  if (ownerSignal.aborted) return undefined;
  const platform = options.platform ?? process.platform;
  const invocation = createCommandInvocation({ ...selected, args, platform });
  let child: UsageProcess;
  try {
    child = (options.spawn ?? spawn)(invocation.command, invocation.args, {
      cwd: selected.cwd,
      env: selected.env,
      detached: platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
  const signal = AbortSignal.any([ownerSignal, AbortSignal.timeout(timeoutMs)]);
  const completion = Promise.withResolvers<string | undefined>();
  const cancel = () => completion.resolve(undefined);
  const chunks: Buffer[] = [];
  let size = 0;
  child.stdout?.on("data", (chunk: Buffer) => {
    size += chunk.byteLength;
    if (size > MAX_OUTPUT_BYTES) cancel();
    else chunks.push(chunk);
  });
  child.stdout?.on("error", cancel);
  child.on("error", cancel);
  child.once("close", () => {
    completion.resolve(child.exitCode === 0 && size <= MAX_OUTPUT_BYTES
      ? Buffer.concat(chunks).toString("utf8") : undefined);
  });
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    return await completion.promise;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (child.pid) await (options.terminate ?? terminateOwnedProcessTree)(child, PROCESS_STOP_OPTIONS);
  }
}

function supportsHeadlessUsage(version: string): boolean {
  if (!isAntigravityVersion(version)) return false;
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  // 1.1.11 made /usage a read-only print command that bypasses model turns.
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11)));
}
