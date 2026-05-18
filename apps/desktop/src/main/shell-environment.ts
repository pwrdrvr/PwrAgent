import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { getMainLogger } from "./log";

const shellEnvLog = getMainLogger("pwragent:shell-environment");

type ExecFileSyncLike = (
  file: string,
  args: string[],
  options: {
    encoding: BufferEncoding;
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
  },
) => string;

type ShellPathOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execFileSync?: ExecFileSyncLike;
  shellCandidates?: string[];
  timeoutMs?: number;
};

type MergeLoginShellEnvOptions = ShellPathOptions & {
  resolveShellEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv | undefined;
};

const ENV_MARKER_START = "__PWRAGENT_ENV_START__";
const ENV_MARKER_END = "__PWRAGENT_ENV_END__";
const DEFAULT_SHELL_PATH_TIMEOUT_MS = 5_000;

export function mergeLoginShellEnvIntoEnv(
  env: NodeJS.ProcessEnv,
  options: MergeLoginShellEnvOptions = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const shellEnv = options.resolveShellEnv
    ? options.resolveShellEnv(env)
    : resolveInteractiveLoginShellEnv({
        ...options,
        env,
        platform,
      });
  if (!shellEnv || Object.keys(shellEnv).length === 0) {
    // Silent hydration failure is a likely root cause when env-setup
    // commands work from a terminal-launched dev build but fail from a
    // Finder-launched bundle. Log enough to diagnose without leaking
    // sensitive env values.
    shellEnvLog.warn("login-shell-env-merge-empty", {
      platform,
      shellCandidates: defaultShellCandidates(env),
      parentShell: env.SHELL,
      parentPathLength: env.PATH?.length ?? 0,
    });
    return env;
  }
  shellEnvLog.info("login-shell-env-merged", {
    keys: Object.keys(shellEnv).length,
    parentPathLength: env.PATH?.length ?? 0,
    hydratedPathLength: shellEnv.PATH?.length ?? 0,
    hadNvmDir: Boolean(shellEnv.NVM_DIR),
    hadHomebrewPrefix: Boolean(shellEnv.HOMEBREW_PREFIX),
  });
  return {
    ...env,
    ...shellEnv,
  };
}

export function resolveInteractiveLoginShellEnv(
  options: ShellPathOptions = {},
): NodeJS.ProcessEnv | undefined {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return undefined;
  }

  const env = options.env ?? process.env;
  const exec: ExecFileSyncLike =
    options.execFileSync
    ?? ((file, args, execOptions) =>
      String(execFileSync(file, args, execOptions)));
  const timeout = options.timeoutMs ?? DEFAULT_SHELL_PATH_TIMEOUT_MS;
  const command = [
    `command printf '${ENV_MARKER_START}\\n'`,
    "command env",
    `command printf '${ENV_MARKER_END}\\n'`,
  ].join("; ");

  const failures: Array<{ shell: string; message: string }> = [];
  for (const shell of options.shellCandidates ?? defaultShellCandidates(env)) {
    try {
      const output = exec(shell, ["-ilc", command], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
        timeout,
      });
      const shellEnv = extractMarkedEnv(output);
      if (shellEnv) {
        return shellEnv;
      }
      failures.push({ shell, message: "empty-env-output" });
    } catch (error) {
      failures.push({
        shell,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    shellEnvLog.warn("login-shell-env-resolve-failed", {
      attempts: failures.length,
      failures: failures.map((entry) => `${entry.shell}:${entry.message}`).join("; "),
      timeoutMs: timeout,
    });
  }
  return undefined;
}

function defaultShellCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates = [env.SHELL, readUserShell(), "/bin/zsh", "/bin/bash"];
  return [...new Set(candidates.filter(isUsableShellPath))];
}

function readUserShell(): string | undefined {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function isUsableShellPath(value: string | undefined): value is string {
  if (!value?.trim()) {
    return false;
  }
  return path.isAbsolute(value);
}

function extractMarkedEnv(output: string): NodeJS.ProcessEnv | undefined {
  const start = output.indexOf(ENV_MARKER_START);
  if (start === -1) {
    return undefined;
  }
  const valueStart = start + ENV_MARKER_START.length;
  const end = output.indexOf(ENV_MARKER_END, valueStart);
  if (end === -1) {
    return undefined;
  }
  const env: NodeJS.ProcessEnv = {};
  for (const line of output.slice(valueStart, end).split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    env[key] = line.slice(separator + 1);
  }
  return Object.keys(env).length > 0 ? env : undefined;
}
