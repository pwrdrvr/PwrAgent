import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";

const runFile = promisify(execFile);

export const CLAUDE_SETUP_INSTRUCTIONS =
  "Install Claude Code from https://code.claude.com/docs/en/setup, then run `claude auth login` in your terminal.";

export type ClaudeInstallation = {
  executable?: string;
  authStatus: "signed-in" | "sign-in-required" | "unknown";
  message?: string;
};

/** The CLI owns authentication. Never supply an application credential fallback. */
export function claudeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = buildPwrAgentChildProcessEnv(env);
  for (const key of [
    "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  ]) {
    delete result[key];
  }
  return result;
}

export async function resolveClaudeExecutable(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  resolveCandidate?: (candidate: string) => Promise<string | undefined>;
} = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const home = options.homeDir ?? os.homedir();
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const directories = [
    ...pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean),
    paths.join(home, ".local", "bin"),
    ...(platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin"]),
  ];
  const resolveCandidate = options.resolveCandidate ?? (async (candidate: string) => {
    try {
      const resolved = await realpath(candidate);
      if (!(await stat(resolved)).isFile()) return undefined;
      await access(resolved, platform === "win32" ? constants.F_OK : constants.X_OK);
      return resolved;
    } catch {
      return undefined;
    }
  });
  for (const directory of new Set(directories)) {
    // Never hand a Windows shell shim to the SDK. Resolve npm installations
    // through their official package entry, or the native install's .exe.
    const candidates = platform === "win32"
      ? [
          paths.join(directory, "claude.exe"),
          paths.join(directory, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
          paths.join(directory, "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
        ]
      : [paths.join(directory, "claude")];
    for (const candidate of candidates) {
      const resolved = await resolveCandidate(candidate);
      if (resolved && !/\.(cmd|bat|ps1)$/i.test(resolved)) return resolved;
    }
  }
  return undefined;
}

export async function inspectClaudeInstallation(options: {
  env?: NodeJS.ProcessEnv;
  resolveExecutable?: () => Promise<string | undefined>;
  readAuthStatus?: (executable: string, env: NodeJS.ProcessEnv) => Promise<string>;
} = {}): Promise<ClaudeInstallation> {
  const env = claudeEnvironment(options.env ?? process.env);
  const executable = await (options.resolveExecutable ?? (() => resolveClaudeExecutable({ env })))();
  if (!executable) {
    return { authStatus: "unknown", message: CLAUDE_SETUP_INSTRUCTIONS };
  }
  try {
    const readAuthStatus = options.readAuthStatus ?? (async (command, launchEnv) => {
      const isScript = /\.(c?js|mjs)$/i.test(command);
      const { stdout } = await runFile(
        isScript ? process.execPath : command,
        [...(isScript ? [command] : []), "auth", "status", "--json"],
        {
          env: isScript ? { ...launchEnv, ELECTRON_RUN_AS_NODE: "1" } : launchEnv,
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        },
      ).catch((error: unknown) => {
        // `auth status` can exit nonzero while returning a valid logged-out
        // response. Parse only its JSON status; never retain raw CLI output.
        if (error && typeof error === "object" && "stdout" in error
          && typeof error.stdout === "string" && error.stdout.trim()) {
          return { stdout: error.stdout };
        }
        throw error;
      });
      return stdout;
    });
    const status: unknown = JSON.parse(await readAuthStatus(executable, env));
    if (status && typeof status === "object" && "loggedIn" in status
      && typeof status.loggedIn === "boolean") {
      return {
        executable,
        authStatus: status.loggedIn ? "signed-in" : "sign-in-required",
        ...(!status.loggedIn ? { message: "Run `claude auth login` in your terminal, then check again." } : {}),
      };
    }
  } catch {
    // Older CLI versions may not implement auth status. Do not claim login.
  }
  return {
    executable,
    authStatus: "unknown",
    message: "Could not verify CLI sign-in. Run `claude auth login` in your terminal.",
  };
}
