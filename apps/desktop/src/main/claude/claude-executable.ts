import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveBundledClaudeExecutable } from "./claude-bundled-executable";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";

const runFile = promisify(execFile);

export const CLAUDE_SETUP_INSTRUCTIONS =
  "Install Claude Code from https://code.claude.com/docs/en/setup, then run `claude auth login` in your terminal.";

export type ClaudeInstallation = {
  executable?: string;
  source?: "system" | "bundled";
  version?: string;
  loginCommand?: string;
  authStatus: "signed-in" | "sign-in-required" | "unknown";
  authMethod?: "api-key" | "claude-account" | "external";
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

export function parseClaudeVersion(output: string): string | undefined {
  return /^\s*(\d+\.\d+\.\d+)\s+\(Claude Code\)\s*$/.exec(output)?.[1];
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

async function runClaude(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const isScript = /\.(c?js|mjs)$/i.test(command);
  const { stdout } = await runFile(isScript ? process.execPath : command,
    [...(isScript ? [command] : []), ...args], {
      env: isScript ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env,
      timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
  return stdout;
}

export async function selectClaudeExecutable(options: {
  system?: string;
  bundled?: string;
  readVersion: (executable: string) => Promise<string>;
}): Promise<Pick<ClaudeInstallation, "executable" | "source" | "version">> {
  const probe = async (file?: string) => {
    if (!file) return undefined;
    try { return parseClaudeVersion(await options.readVersion(file)); }
    catch { return undefined; }
  };
  const [systemVersion, bundledVersion] = await Promise.all([probe(options.system), probe(options.bundled)]);
  if (options.bundled && bundledVersion
    && (!options.system || !systemVersion || compareVersions(systemVersion, bundledVersion) < 0)) {
    return { executable: options.bundled, source: "bundled", version: bundledVersion };
  }
  if (options.system) return { executable: options.system, source: "system", version: systemVersion };
  return {};
}

export function claudeLoginCommand(executable: string, platform: NodeJS.Platform = process.platform): string {
  // A command for the user to paste in a terminal, never executed by PwrAgent.
  const quoted = "'" + executable.replaceAll("'", platform === "win32" ? "''" : "'\"'\"'") + "'";
  return `${platform === "win32" ? "& " : ""}${quoted} auth login`;
}

export async function inspectClaudeInstallation(options: {
  env?: NodeJS.ProcessEnv;
  resolveExecutable?: () => Promise<string | undefined>;
  resolveBundledExecutable?: () => Promise<string | undefined>;
  readVersion?: (executable: string, env: NodeJS.ProcessEnv) => Promise<string>;
  readAuthStatus?: (executable: string, env: NodeJS.ProcessEnv) => Promise<string>;
} = {}): Promise<ClaudeInstallation> {
  const env = claudeEnvironment(options.env ?? process.env);
  const [system, bundled] = await Promise.all([
    (options.resolveExecutable ?? (() => resolveClaudeExecutable({ env })))(),
    (options.resolveBundledExecutable ?? resolveBundledClaudeExecutable)(),
  ]);
  const selected = await selectClaudeExecutable({ system, bundled,
    readVersion: (executable) => (options.readVersion ?? ((file, launchEnv) => runClaude(file, ["--version"], launchEnv)))(executable, env),
  });
  const executable = selected.executable;
  if (!executable) return { authStatus: "unknown", message: CLAUDE_SETUP_INSTRUCTIONS };
  const loginCommand = selected.source === "bundled" ? claudeLoginCommand(executable) : "claude auth login";
  const installation = { ...selected, loginCommand };
  try {
    const readAuthStatus = options.readAuthStatus ?? (async (command, launchEnv) => {
      return await runClaude(command, ["auth", "status", "--json"], launchEnv).catch((error: unknown) => {
        // Logged-out status may exit nonzero with valid JSON. Retain only the
        // status fields below, never raw output, account identifiers, or credentials.
        if (error && typeof error === "object" && "stdout" in error
          && typeof error.stdout === "string" && error.stdout.trim()) return error.stdout;
        throw error;
      });
    });
    const status: unknown = JSON.parse(await readAuthStatus(executable, env));
    if (status && typeof status === "object" && "loggedIn" in status
      && typeof status.loggedIn === "boolean") {
      // Project only a known authentication category. The CLI owns credentials;
      // loggedIn does not prove subscription access or a positive API balance.
      const authMethod = "authMethod" in status && status.authMethod === "api_key"
        ? "api-key" as const
        : "authMethod" in status && status.authMethod === "claude.ai"
          ? "claude-account" as const
          : "apiProvider" in status && typeof status.apiProvider === "string"
            && ["bedrock", "vertex", "foundry", "anthropicAws", "anthropicGoogleCloud", "mantle", "gateway"].includes(status.apiProvider)
            ? "external" as const
            : undefined;
      return { ...installation, authStatus: status.loggedIn ? "signed-in" : "sign-in-required",
        ...(status.loggedIn && authMethod ? { authMethod } : {}),
        ...(!status.loggedIn ? { message: `Run ${loginCommand} in your terminal, then check again.` } : {}),
      };
    }
  } catch {
    // Older CLI versions may not implement auth status. Do not claim login.
  }
  return { ...installation, authStatus: "unknown",
    message: `Could not verify CLI sign-in. Run ${loginCommand} in your terminal.`,
  };
}
