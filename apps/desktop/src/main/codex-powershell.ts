import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  createCommandInvocation,
  type CommandInvocation,
} from "@pwrdrvr/agent-transport";
import {
  CODEX_COMMAND_ENV,
  compareCodexCliVersions,
  MINIMUM_CODEX_CLI_VERSION,
  type CodexDiscoveryCandidate,
} from "@pwrdrvr/codex-discovery";

const execFileAsync = promisify(execFile);
const CODEX_VERSION_PATTERN = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;
const POWERSHELL_SHIM_EXTENSION = ".ps1";
const POWERSHELL_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
];
const POWERSHELL_DISCOVERY_COMMAND = [
  "$resolved = Get-Command codex.ps1",
  "-CommandType ExternalScript",
  "-ErrorAction SilentlyContinue",
  "| Select-Object -First 1;",
  "if ($null -ne $resolved) { [Console]::Out.Write($resolved.Source) }",
].join(" ");

export type CodexPowerShellCommandRunner = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    windowsHide: boolean;
    windowsVerbatimArguments?: boolean;
  },
) => Promise<{ stderr?: string | Buffer; stdout?: string | Buffer }>;

export function isPowerShellScript(command: string): boolean {
  return path.win32.extname(command).toLowerCase() === POWERSHELL_SHIM_EXTENSION;
}

function readWindowsEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const key = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? env[key] : undefined;
}

export function resolveWindowsPowerShellExecutable(
  env: NodeJS.ProcessEnv,
): string {
  const systemRoot = readWindowsEnv(env, "SystemRoot")?.trim();
  return systemRoot
    ? path.win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe";
}

export function createCodexCommandInvocation(params: {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): CommandInvocation {
  const platform = params.platform ?? process.platform;
  if (platform !== "win32" || !isPowerShellScript(params.command)) {
    return createCommandInvocation(params);
  }
  return {
    command: resolveWindowsPowerShellExecutable(params.env),
    args: [
      ...POWERSHELL_ARGS,
      "-File",
      path.win32.normalize(params.command),
      ...params.args,
    ],
  };
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  options: Parameters<CodexPowerShellCommandRunner>[2],
): Promise<{ stderr?: string | Buffer; stdout?: string | Buffer }> {
  return await execFileAsync(command, args, options);
}

async function inspectPowerShellCandidate(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  runner: CodexPowerShellCommandRunner;
  source: CodexDiscoveryCandidate["source"];
}): Promise<CodexDiscoveryCandidate> {
  try {
    const invocation = createCodexCommandInvocation({
      command: params.command,
      args: ["--version"],
      env: params.env,
      platform: "win32",
    });
    const result = await params.runner(invocation.command, invocation.args, {
      env: params.env,
      timeout: 2_000,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const output = `${result.stdout?.toString() ?? ""}\n${
      result.stderr?.toString() ?? ""
    }`;
    const version = output.match(CODEX_VERSION_PATTERN)?.[1];
    const tooOld = version
      && compareCodexCliVersions(version, MINIMUM_CODEX_CLI_VERSION) < 0;
    return {
      command: params.command,
      source: params.source,
      executable: Boolean(version) && !tooOld,
      selected: false,
      ...(version ? { version } : { versionFailureReason: "version_not_reported" }),
      ...(tooOld ? { failureReason: "codex_too_old" } : {}),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      command: params.command,
      source: params.source,
      executable: false,
      selected: false,
      failureReason:
        code === "ENOENT" || code === "ENOTDIR"
          ? "not_found"
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

async function resolvePowerShellPathCommand(params: {
  env: NodeJS.ProcessEnv;
  runner: CodexPowerShellCommandRunner;
}): Promise<string | undefined> {
  const powershell = resolveWindowsPowerShellExecutable(params.env);
  try {
    const result = await params.runner(
      powershell,
      [...POWERSHELL_ARGS, "-Command", POWERSHELL_DISCOVERY_COMMAND],
      {
        env: params.env,
        timeout: 2_000,
        windowsHide: true,
      },
    );
    const command = result.stdout?.toString().trim();
    return command && isPowerShellScript(command) ? command : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Supplements shared Codex discovery for npm/nvm-windows installations that
 * expose only a PowerShell shim. PowerShell's own command resolver is the
 * source of truth for PATH precedence; fixed env/config paths retain their
 * normal priority ahead of automatic discovery.
 */
export async function discoverCodexPowerShellCandidates(params: {
  configuredCommand?: string;
  env: NodeJS.ProcessEnv;
  includePath?: boolean;
  runner?: CodexPowerShellCommandRunner;
}): Promise<CodexDiscoveryCandidate[]> {
  const runner = params.runner ?? defaultCommandRunner;
  const fixedCandidates = [
    {
      command: params.env[CODEX_COMMAND_ENV]?.trim(),
      source: "env" as const,
    },
    {
      command: params.configuredCommand?.trim(),
      source: "config" as const,
    },
  ].filter(
    (candidate): candidate is { command: string; source: "config" | "env" } =>
      Boolean(candidate.command && isPowerShellScript(candidate.command)),
  );
  const candidates = await Promise.all(
    fixedCandidates.map(async (candidate) =>
      await inspectPowerShellCandidate({
        ...candidate,
        env: params.env,
        runner,
      }),
    ),
  );
  if (params.includePath === false) {
    return candidates;
  }
  const resolvedPathCommand = await resolvePowerShellPathCommand({
    env: params.env,
    runner,
  });
  if (
    resolvedPathCommand
    && !fixedCandidates.some(
      (candidate) =>
        candidate.command.toLowerCase() === resolvedPathCommand.toLowerCase(),
    )
  ) {
    const pathCandidate = await inspectPowerShellCandidate({
      command: resolvedPathCommand,
      env: params.env,
      runner,
      source: "path",
    });
    if (pathCandidate.executable) {
      candidates.push(pathCandidate);
    }
  }
  return candidates;
}
