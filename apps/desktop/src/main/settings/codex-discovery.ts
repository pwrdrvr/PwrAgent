import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  DesktopCodexCandidateSource,
  DesktopCodexDiscoveryCandidate,
  DesktopCodexDiscoverySnapshot,
} from "@pwragnt/shared";
import { CODEX_COMMAND_ENV } from "./desktop-settings-env";

const execFile = promisify(execFileCallback);

export type ResolvedCodexCommandCandidate = {
  command: string;
  source: DesktopCodexCandidateSource;
  version?: string;
};

export async function pathIsExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolvePathCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (command.includes(path.sep)) {
    return command;
  }

  try {
    const result = await execFile("/usr/bin/which", [command], {
      env,
      timeout: 2_000,
    });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readCodexVersion(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  ran: boolean;
  version?: string;
  failureReason?: string;
}> {
  try {
    const result = await execFile(command, ["--version"], {
      env,
      timeout: 2_000,
    });
    const output = `${result.stdout}\n${result.stderr ?? ""}`;
    const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
    return {
      ran: true,
      version: match?.[1],
      failureReason: match ? undefined : "version_not_reported",
    };
  } catch (error) {
    return {
      ran: false,
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseVersion(value?: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
} | undefined {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    return undefined;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      if (leftNumber !== rightNumber) {
        return Math.sign(leftNumber - rightNumber);
      }
      continue;
    }
    if (leftNumber !== undefined) {
      return -1;
    }
    if (rightNumber !== undefined) {
      return 1;
    }
    if (leftPart !== rightPart) {
      return leftPart.localeCompare(rightPart);
    }
  }

  return 0;
}

export function compareCodexCliVersions(left?: string, right?: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion && !rightVersion) {
    return 0;
  }
  if (!leftVersion) {
    return -1;
  }
  if (!rightVersion) {
    return 1;
  }

  for (const key of ["major", "minor", "patch"] as const) {
    if (leftVersion[key] !== rightVersion[key]) {
      return Math.sign(leftVersion[key] - rightVersion[key]);
    }
  }

  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function getCodexAppCandidatePaths(): string[] {
  return [
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(os.homedir(), "Applications/Codex.app/Contents/Resources/codex"),
  ];
}

async function buildDiscoveryCandidate(
  command: string | undefined,
  source: DesktopCodexCandidateSource,
  env: NodeJS.ProcessEnv,
): Promise<DesktopCodexDiscoveryCandidate | undefined> {
  const trimmedCommand = command?.trim();
  if (!trimmedCommand) {
    return undefined;
  }

  const resolvedCommand =
    source === "path" || !trimmedCommand.includes(path.sep)
      ? await resolvePathCommand(trimmedCommand, env)
      : trimmedCommand;
  const accessExecutable = resolvedCommand
    ? await pathIsExecutable(resolvedCommand)
    : false;
  const versionResult = resolvedCommand
    ? await readCodexVersion(resolvedCommand, env)
    : { ran: false, failureReason: "not_found" };
  const executable = accessExecutable || versionResult.ran;

  return {
    command: resolvedCommand || trimmedCommand,
    source,
    executable,
    selected: false,
    version: versionResult.version,
    versionFailureReason: executable ? versionResult.failureReason : undefined,
    failureReason: executable ? undefined : "not_executable",
  };
}

export async function discoverCodexCommands(params?: {
  configuredCommand?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DesktopCodexDiscoverySnapshot> {
  const env = params?.env ?? process.env;
  const envOverride = env[CODEX_COMMAND_ENV]?.trim();
  const configuredCommand = params?.configuredCommand?.trim();

  const fixedCandidates = (
    await Promise.all([
      buildDiscoveryCandidate(envOverride, "env", env),
      buildDiscoveryCandidate(configuredCommand, "config", env),
    ])
  ).filter((candidate): candidate is DesktopCodexDiscoveryCandidate => Boolean(candidate));

  const autoCandidates = (
    await Promise.all([
      buildDiscoveryCandidate("codex", "path", env),
      ...getCodexAppCandidatePaths().map((candidatePath) =>
        buildDiscoveryCandidate(candidatePath, "application", env),
      ),
    ])
  )
    .filter((candidate): candidate is DesktopCodexDiscoveryCandidate => Boolean(candidate))
    .filter((candidate) => candidate.executable)
    .sort((left, right) => compareCodexCliVersions(right.version, left.version));

  const candidates = [...fixedCandidates, ...autoCandidates];
  const selected =
    candidates.find((candidate) => candidate.source === "env" && candidate.executable)
    ?? candidates.find((candidate) => candidate.source === "config" && candidate.executable)
    ?? autoCandidates.find((candidate) => candidate.executable);

  if (selected) {
    selected.selected = true;
  }

  return {
    selectedCommand: selected?.command,
    selectedSource: selected?.source,
    candidates,
  };
}

export async function resolveCodexCommand(params: {
  command: string;
  env: NodeJS.ProcessEnv;
}): Promise<ResolvedCodexCommandCandidate> {
  const configuredCommand =
    params.command.trim() && params.command.trim() !== "codex"
      ? params.command.trim()
      : undefined;
  const discovery = await discoverCodexCommands({
    configuredCommand,
    env: params.env,
  });
  const selected = discovery.candidates.find((candidate) => candidate.selected);

  return selected
    ? {
        command: selected.command,
        source: selected.source,
        version: selected.version,
      }
    : {
        command: params.command.trim() || "codex",
        source: "path",
      };
}
