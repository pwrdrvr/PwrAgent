import { spawn, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const MAX_STDERR_BYTES = 8 * 1024;
const PROCESS_STOP_OPTIONS = { gracefulTimeoutMs: 1_000, forceTimeoutMs: 2_000 };
const BROWSER_SUPPRESSED_ENV_KEYS = new Set([
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "BROWSER",
  "ELECTRON_RUN_AS_NODE",
  "SSH_CONNECTION",
]);
const INTERACTIVE_AUTH_PROMPT_PATTERN =
  /authentication required|please visit the url to log in|https:\/\/accounts\.google\.com\/o\/oauth2\/auth|paste the authorization code/i;

type UsageProcess = OwnedChildProcess & { stdout: Readable | null; stderr?: Readable | null };
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
  const platform = processOptions.platform ?? process.platform;
  try {
    const hold = platform === "win32"
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
      // Non-ACP `agy --print /usage` starts an interactive browser OAuth flow
      // when unauthenticated. Suppress browser launchers before spawning it.
      const usageEnv = await nonInteractiveUsageEnv(command.env, cwd, platform);
      if (!usageEnv) return undefined;
      const stdout = await readCommandOutput(
        { ...command, env: usageEnv },
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

async function nonInteractiveUsageEnv(
  baseEnv: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform,
): Promise<NodeJS.ProcessEnv | undefined> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!BROWSER_SUPPRESSED_ENV_KEYS.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  const runtime = platform === "win32" ? process.execPath.replaceAll("\\", "/") : process.execPath;
  if (runtime.includes(path.delimiter) || /[\r\n\0]|%s/u.test(runtime)) {
    return undefined;
  }
  env.SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 0";
  env.BROWSER = `'${runtime.replaceAll("'", "'\"'\"'")}' -e 'process.exit(0)' -- %s`;
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";

  if (platform === "darwin" || platform === "linux") {
    const browserBin = path.join(cwd, "browser-bin");
    if (browserBin.includes(path.delimiter)) return undefined;
    try {
      await mkdir(browserBin, { mode: 0o700 });
      const opener = platform === "darwin" ? "open" : "xdg-open";
      await writeFile(path.join(browserBin, opener), "#!/bin/sh\nexit 0\n", { flag: "wx", mode: 0o700 });
    } catch {
      return undefined;
    }
    const pathKey = Object.hasOwn(env, "PATH")
      ? "PATH"
      : process.platform === "win32"
        ? Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
        : "PATH";
    env[pathKey] = `${browserBin}${path.delimiter}${env[pathKey] ?? "/usr/bin:/bin"}`;
  }
  return env;
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
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
  const signal = AbortSignal.any([ownerSignal, AbortSignal.timeout(timeoutMs)]);
  const completion = Promise.withResolvers<string | undefined>();
  const cancel = () => completion.resolve(undefined);
  const chunks: Buffer[] = [];
  let size = 0;
  let stderrTail = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    size += chunk.byteLength;
    if (size > MAX_OUTPUT_BYTES) cancel();
    else chunks.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = appendBoundedTail(stderrTail, String(chunk), MAX_STDERR_BYTES);
    if (INTERACTIVE_AUTH_PROMPT_PATTERN.test(stderrTail)) cancel();
  });
  child.stdout?.on("error", cancel);
  child.stderr?.on("error", cancel);
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

function appendBoundedTail(current: string, chunk: string, limit: number): string {
  const combined = `${current}${chunk}`;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

function supportsHeadlessUsage(version: string): boolean {
  if (!isAntigravityVersion(version)) return false;
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  // 1.1.11 made /usage a read-only print command that bypasses model turns.
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11)));
}
